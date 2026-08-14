#!/usr/bin/env node

/**
 * Codex PreToolUse hook — intercepts Bash commands targeting ~/.memoree/memory/.
 *
 * Decision -> wire mapping. Codex >= 0.136 parses PreToolUse JSON on stdout
 * (verified against codex-rs/hooks/src/events/pre_tool_use.rs, tag rust-v0.136.0):
 * - action=pass  -> exit 0, no output                (Codex runs the original command)
 * - action=block -> stderr content, exit 2           (Codex blocks; reason -> model)
 * - action=allow -> exit 0, stdout JSON carrying
 *     hookSpecificOutput.permissionDecision="allow" + updatedInput.command
 *                                                    (Codex runs the REPLACEMENT command)
 *
 * `allow` is used for every command handled by the sandbox. The hook performs
 * the VFS operation itself, then rewrites the host command to a harmless printf
 * (and, for failures, a preserved nonzero exit) so Codex never runs the original
 * memory command against the real host filesystem.
 *
 * The source logic is exported so tests can exercise it directly without
 * spawning the bundled script in a subprocess.
 */

import { join, dirname } from "node:path";
import { deriveProjectKey } from "../../utils/repo-identity.js";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readStdin } from "../../utils/stdin.js";
import { loadConfig } from "../../config.js";
import { resolveDirConfig } from "../../dir-config.js";
import { createStorageBackend } from "../../storage/factory.js";
import type { StorageBackend } from "../../storage/backend.js";
import { sqlLike } from "../../utils/sql.js";
import { parseBashGrep, handleGrepDirect } from "../grep-direct.js";
import { tryGraphRead } from "../../graph/graph-command.js";
import { handleDocsVfs } from "../../docs/vfs-handler.js";
import { makeQueryEmbedder } from "../../docs/embed.js";
import { executeCompiledBashCommand } from "../bash-command-compiler.js";
import {
  findVirtualPaths,
  readVirtualPathContents,
  listVirtualPathRows,
  readVirtualPathContent,
} from "../virtual-table-query.js";
import {
  readCachedIndexContent,
  writeCachedIndexContent,
} from "../query-cache.js";
import { log as _log } from "../../utils/debug.js";
import { isDirectRun } from "../../utils/direct-run.js";
import { commandTouchesOutsideMemoryPath, isSafe, touchesMemory, rewritePaths, shouldRouteThroughStructuredVfs } from "../memory-path-utils.js";
import { parseCodexCompatibilityCommand } from "./compatibility-broker.js";
import { armSkillOptOnSkillUse } from "../shared/skillopt-hook.js";
import { MEMORY_COMMAND_GUIDANCE } from "../shared/memory-command-contract.js";
import { safeFailureReplacement, safeProcessReplacement, safeStdoutReplacement } from "../shared/shell-replacement.js";
import { capOutputForClaude } from "../../utils/output-cap.js";

export { isSafe, touchesMemory, rewritePaths };

const __bundleDir = dirname(fileURLToPath(import.meta.url));

const log = (msg: string) => _log("codex-pre", msg);

export interface CodexPreToolUseInput {
  session_id: string;
  tool_name: string;
  tool_use_id: string;
  tool_input: { command: string };
  cwd: string;
  hook_event_name: string;
  model: string;
  turn_id?: string;
}

export interface CodexPreToolDecision {
  action: "pass" | "block" | "allow";
  output?: string;
  rewrittenCommand?: string;
  /**
   * Host command Codex should run INSTEAD of the original, delivered via the
   * PreToolUse `updatedInput.command` rewrite. Set only for action="allow"
   * after the sandbox has already handled the VFS command. The replacement
   * prints literal output or reproduces the sandbox failure without exposing
   * the original command to the host.
   */
  replacementCommand?: string;
}

export function buildUnsupportedGuidance(): string {
  return "This command was denied for ~/.memoree/memory/ operations. " + MEMORY_COMMAND_GUIDANCE;
}

function buildHandledSuccess(
  output: string,
  rewrittenCommand: string,
  kind = "command",
): CodexPreToolDecision {
  const capped = capOutputForClaude(output, { kind });
  return {
    action: "allow",
    output: capped,
    replacementCommand: safeStdoutReplacement(capped),
    rewrittenCommand,
  };
}

function buildHandledFailure(
  stderr: string,
  status: number | null,
  rewrittenCommand: string,
  stdout = "",
): CodexPreToolDecision {
  return {
    action: "allow",
    output: stderr || stdout,
    replacementCommand: safeFailureReplacement(stderr, status, stdout),
    rewrittenCommand,
  };
}

function buildIndexContent(rows: Record<string, unknown>[]): string {
  const lines = ["# Memory Index", "", `${rows.length} sessions:`, ""];
  for (const row of rows) {
    const path = row["path"] as string;
    const project = row["project"] as string || "";
    const description = (row["description"] as string || "").slice(0, 120);
    const date = (row["creation_date"] as string || "").slice(0, 10);
    lines.push(`- [${path}](${path}) ${date} ${project ? `[${project}]` : ""} ${description}`);
  }
  return lines.join("\n");
}

interface CodexPreToolDeps {
  config?: ReturnType<typeof loadConfig>;
  createApi?: (table: string, config: NonNullable<ReturnType<typeof loadConfig>>) => StorageBackend;
  executeCompiledBashCommandFn?: typeof executeCompiledBashCommand;
  readVirtualPathContentsFn?: typeof readVirtualPathContents;
  readVirtualPathContentFn?: typeof readVirtualPathContent;
  listVirtualPathRowsFn?: typeof listVirtualPathRows;
  findVirtualPathsFn?: typeof findVirtualPaths;
  handleGrepDirectFn?: typeof handleGrepDirect;
  readCachedIndexContentFn?: typeof readCachedIndexContent;
  writeCachedIndexContentFn?: typeof writeCachedIndexContent;
  runVfsShellFn?: (command: string) => { status: number | null; stdout: string; stderr: string };
  runCompatibilityCommandFn?: (args: string[]) => { status: number | null; stdout: string; stderr: string };
  tryGraphReadFn?: typeof tryGraphRead;
  logFn?: (msg: string) => void;
}

export async function processCodexPreToolUse(
  input: CodexPreToolUseInput,
  deps: CodexPreToolDeps = {},
): Promise<CodexPreToolDecision> {
  const {
    config: baseConfig = loadConfig(),
    createApi = (table, activeConfig) => createStorageBackend(activeConfig, table),
    executeCompiledBashCommandFn = executeCompiledBashCommand,
    readVirtualPathContentsFn = readVirtualPathContents,
    readVirtualPathContentFn = readVirtualPathContent,
    listVirtualPathRowsFn = listVirtualPathRows,
    findVirtualPathsFn = findVirtualPaths,
    handleGrepDirectFn = handleGrepDirect,
    readCachedIndexContentFn = readCachedIndexContent,
    writeCachedIndexContentFn = writeCachedIndexContent,
    runVfsShellFn = (command: string) => {
      const shellBundle = join(__bundleDir, "shell", "memoree-shell.js");
      const proc = spawnSync(process.execPath, [shellBundle, "-c", command], {
        encoding: "utf-8",
        timeout: 10_000,
      });
      return { status: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
    },
    runCompatibilityCommandFn = (args: string[]) => {
      const commandEntry = join(__bundleDir, "command", "memoree.js");
      const proc = spawnSync(process.execPath, [commandEntry, ...args], {
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { status: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
    },
    tryGraphReadFn = tryGraphRead,
    logFn = log,
  } = deps;

  // Route memory reads/writes through the nearest `.memoree`, like capture —
  // a directory pinned to another workspace must read/write THAT workspace, not
  // the global one. Applied to the injected/default base alike (a no-op when no
  // `.memoree` applies). See src/dir-config.ts.
  const config = baseConfig ? resolveDirConfig(baseConfig, input.cwd ?? process.cwd()).config : baseConfig;

  const cmd = input.tool_input?.command ?? "";
  logFn(`hook fired: cmd=${cmd}`);

  const compatibility = parseCodexCompatibilityCommand(cmd);
  if (compatibility.kind === "deny") {
    return { action: "block", output: compatibility.reason };
  }
  if (compatibility.kind === "run") {
    const proc = runCompatibilityCommandFn(compatibility.args);
    const stdout = capOutputForClaude(proc.stdout ?? "", { kind: "command" });
    const stderr = capOutputForClaude(proc.stderr ?? "", { kind: "command" });
    return {
      action: "allow",
      output: stdout || stderr,
      replacementCommand: safeProcessReplacement(stdout, stderr, proc.status),
      rewrittenCommand: "memoree",
    };
  }

  if (!touchesMemory(cmd)) return { action: "pass" };

  if (commandTouchesOutsideMemoryPath(cmd)) {
    return { action: "block", output: buildUnsupportedGuidance() };
  }

  const rewritten = rewritePaths(cmd);

  // Graph VFS dispatch — a cat/head/tail/ls on the `/graph/*` subtree is
  // answered from the local snapshot, no SQL, no config needed. Runs before
  // the isSafe/grep/shell handling. Shared parser: src/graph/graph-command.ts.
  const graphBody = await tryGraphReadFn(rewritten, input.cwd ?? process.cwd());
  if (graphBody !== null) {
    logFn(`graph vfs intercept: ${rewritten}`);
    return buildHandledSuccess(graphBody, rewritten, "graph");
  }

  if (!isSafe(rewritten)) {
    // BLOCK (exit 2), never exit 0. Any exit-0 path lets Codex run the original
    // command on the host, so an unsafe memory command — `python … x.py`,
    // backticks, `$()`, `curl` — would still execute and could read/run real
    // files. Block stops it and injects the guidance instead.
    logFn(`unsupported command, blocking with guidance: ${rewritten}`);
    return {
      action: "block",
      output: buildUnsupportedGuidance(),
      rewrittenCommand: rewritten,
    };
  }

  if (!config) {
    return buildHandledFailure(
      "Memoree storage is unavailable. Run `memoree doctor`.\n",
      1,
      rewritten,
    );
  }

  if (config) {
    const table = process.env["MEMOREE_TABLE"] ?? "memory";
    const sessionsTable = process.env["MEMOREE_SESSIONS_TABLE"] ?? "sessions";
    let api: StorageBackend;
    try {
      api = createApi(table, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildHandledFailure(`Memoree storage is unavailable: ${message}\n`, 1, rewritten);
    }

    const readVirtualPathContentsWithCache = async (
      cachePaths: string[],
    ): Promise<Map<string, string | null>> => {
      const uniquePaths = [...new Set(cachePaths)];
      const result = new Map<string, string | null>(uniquePaths.map((path) => [path, null]));
      const cachedIndex = uniquePaths.includes("/index.md")
        ? readCachedIndexContentFn(input.session_id)
        : null;

      const remainingPaths = cachedIndex === null
        ? uniquePaths
        : uniquePaths.filter((path) => path !== "/index.md");

      if (cachedIndex !== null) {
        result.set("/index.md", cachedIndex);
      }

      if (remainingPaths.length > 0) {
        const fetched = await readVirtualPathContentsFn(api, table, sessionsTable, remainingPaths);
        for (const [path, content] of fetched) result.set(path, content);
      }

      const fetchedIndex = result.get("/index.md");
      if (typeof fetchedIndex === "string") {
        writeCachedIndexContentFn(input.session_id, fetchedIndex);
      }

      return result;
    };

    try {
      if (shouldRouteThroughStructuredVfs(rewritten)) {
        logFn(`structured vfs intercept: ${rewritten}`);
        const proc = runVfsShellFn(rewritten);
        if (proc.status === 0) {
          const output = proc.stdout ?? "";
          return buildHandledSuccess(output, rewritten, "structured");
        }
        return buildHandledFailure(proc.stderr ?? "", proc.status, rewritten, proc.stdout ?? "");
      }

      // `ls /docs` belongs to the docs VFS — intercept BEFORE the compiled
      // bash executor (which owns generic ls) so the root index renders the
      // same view the cat branch and the Claude hook serve.
      const lsDocs = rewritten.match(/^ls\s+(?:-[a-zA-Z]+\s+)*\/docs\/?\s*$/);
      if (lsDocs) {
        logFn("docs vfs intercept: ls /docs");
        const r = await handleDocsVfs("", (sql) => api.query(sql), process.env["MEMOREE_DOCS_TABLE"] ?? config.docsTableName, { project: deriveProjectKey(input.cwd ?? process.cwd()).key, dialect: api.dialect });
        const body = r.kind === "ok" ? r.body : "(docs unavailable)";
        return buildHandledSuccess(body, rewritten, "docs");
      }

      const compiled = await executeCompiledBashCommandFn(api, table, sessionsTable, rewritten, {
        readVirtualPathContentsFn: async (_api, _memoryTable, _sessionsTable, cachePaths) => readVirtualPathContentsWithCache(cachePaths),
      });
      if (compiled !== null) {
        return buildHandledSuccess(compiled, rewritten, "bash");
      }

      let virtualPath: string | null = null;
      let lineLimit = 0;
      let fromEnd = false;

      const catCmd = rewritten.replace(/\s+2>\S+/g, "").trim();
      const catPipeHead = catCmd.match(/^cat\s+(\S+?)\s*(?:\|[^|]*)*\|\s*head\s+(?:-n?\s*)?(-?\d+)\s*$/);
      if (catPipeHead) {
        virtualPath = catPipeHead[1];
        lineLimit = Math.abs(parseInt(catPipeHead[2], 10));
      }
      if (!virtualPath) {
        const catMatch = catCmd.match(/^cat\s+(\S+)\s*$/);
        if (catMatch) virtualPath = catMatch[1];
      }
      if (!virtualPath) {
        const headMatch = rewritten.match(/^head\s+(?:-n\s*)?(-?\d+)\s+(\S+)\s*$/)
          ?? rewritten.match(/^head\s+(\S+)\s*$/);
        if (headMatch) {
          if (headMatch[2]) {
            virtualPath = headMatch[2];
            lineLimit = Math.abs(parseInt(headMatch[1], 10));
          } else {
            virtualPath = headMatch[1];
            lineLimit = 10;
          }
        }
      }
      if (!virtualPath) {
        const tailMatch = rewritten.match(/^tail\s+(?:-n\s*)?(-?\d+)\s+(\S+)\s*$/)
          ?? rewritten.match(/^tail\s+(\S+)\s*$/);
        if (tailMatch) {
          fromEnd = true;
          if (tailMatch[2]) {
            virtualPath = tailMatch[2];
            lineLimit = Math.abs(parseInt(tailMatch[1], 10));
          } else {
            virtualPath = tailMatch[1];
            lineLimit = 10;
          }
        }
      }
      if (!virtualPath) {
        const wcMatch = rewritten.match(/^wc\s+-l\s+(\S+)\s*$/);
        if (wcMatch) {
          virtualPath = wcMatch[1];
          lineLimit = -1;
        }
      }

      // Docs VFS dispatch — a cat of `/docs/*` (browse or find/) is answered by
      // the docs table via handleDocsVfs, NOT the generic memory read below
      // (docs live in their own table). Mirrors the graph dispatch above; async
      // + config-backed. Same route Claude's pre-tool-use uses.
      if (virtualPath && (virtualPath === "/docs" || virtualPath.startsWith("/docs/"))) {
        logFn(`docs vfs intercept: ${virtualPath}`);
        const docsTable = process.env["MEMOREE_DOCS_TABLE"] ?? config.docsTableName;
        const sub = virtualPath === "/docs" ? "" : virtualPath.slice("/docs/".length);
        const r = await handleDocsVfs(sub, (sql) => api.query(sql), docsTable, { embedQuery: makeQueryEmbedder(), project: deriveProjectKey(input.cwd ?? process.cwd()).key, dialect: api.dialect });
        if (r.kind === "ok") return buildHandledSuccess(r.body, rewritten, "docs");
        return buildHandledFailure(`${virtualPath}: No such file or directory\n`, 1, rewritten);
      }

      if (virtualPath && !virtualPath.endsWith("/")) {
        logFn(`direct read: ${virtualPath}`);
        let content = virtualPath === "/index.md"
          ? readCachedIndexContentFn(input.session_id)
          : null;
        if (content === null) {
          content = await readVirtualPathContentFn(api, table, sessionsTable, virtualPath);
        }
        if (content === null && virtualPath === "/index.md") {
          const idxRows = await api.query(
            `SELECT path, project, description, creation_date FROM "${table}" WHERE path LIKE '/summaries/%' ORDER BY creation_date DESC`
          );
          content = buildIndexContent(idxRows);
        }

        if (content !== null) {
          if (virtualPath === "/index.md") {
            writeCachedIndexContentFn(input.session_id, content);
          }
          if (lineLimit === -1) {
            return buildHandledSuccess(`${content.split("\n").length} ${virtualPath}`, rewritten, "wc");
          }
          if (lineLimit > 0) {
            const lines = content.split("\n");
            content = fromEnd
              ? lines.slice(-lineLimit).join("\n")
              : lines.slice(0, lineLimit).join("\n");
          }
          return buildHandledSuccess(content, rewritten, fromEnd ? "tail" : lineLimit > 0 ? "head" : "cat");
        }
        // Concrete file path with no VFS row → "not found", not an unsupported
        // command. Returning the generic guidance would mislead the model into
        // rewriting an already-valid `cat`/`head`/… shape.
        logFn(`virtual path not found: ${virtualPath}`);
        return buildHandledFailure(`${virtualPath}: No such file or directory\n`, 1, rewritten);
      }

      const lsMatch = rewritten.match(/^ls\s+(?:-[a-zA-Z]+\s+)*(\S+)?\s*$/);
      if (lsMatch) {
        const dir = (lsMatch[1] ?? "/").replace(/\/+$/, "") || "/";
        const isLong = /\s-[a-zA-Z]*l/.test(rewritten);
        logFn(`direct ls: ${dir}`);
        const rows = await listVirtualPathRowsFn(api, table, sessionsTable, dir);
        const entries = new Map<string, { isDir: boolean; size: number }>();
        const prefix = dir === "/" ? "/" : `${dir}/`;
        for (const row of rows) {
          const path = row["path"] as string;
          if (!path.startsWith(prefix) && dir !== "/") continue;
          const rest = dir === "/" ? path.slice(1) : path.slice(prefix.length);
          const slash = rest.indexOf("/");
          const name = slash === -1 ? rest : rest.slice(0, slash);
          if (!name) continue;
          const existing = entries.get(name);
          if (slash !== -1) {
            if (!existing) entries.set(name, { isDir: true, size: 0 });
          } else {
            entries.set(name, { isDir: false, size: (row["size_bytes"] as number) ?? 0 });
          }
        }

        if (entries.size > 0) {
          const lines: string[] = [];
          for (const [name, info] of [...entries].sort((a, b) => a[0].localeCompare(b[0]))) {
            if (isLong) {
              const type = info.isDir ? "drwxr-xr-x" : "-rw-r--r--";
              const size = info.isDir ? "0" : String(info.size).padStart(6);
              lines.push(`${type} 1 user user ${size} ${name}${info.isDir ? "/" : ""}`);
            } else {
              lines.push(name + (info.isDir ? "/" : ""));
            }
          }
          return buildHandledSuccess(lines.join("\n"), rewritten, "ls");
        }

        return buildHandledFailure(`ls: cannot access '${dir}': No such file or directory\n`, 2, rewritten);
      }

      // Anchor to the exact shape the VFS serves (optionally piped to wc -l);
      // a prefix match would accept `find … -name '*.md' -delete` and silently
      // drop the suffix. Everything else falls through to block+guidance.
      // No `-type` clause: the VFS find handler can't enforce a type filter, so
      // accepting `-type d` and ignoring it would return wrong results. Such
      // commands fall through to block+guidance instead.
      const findMatch = rewritten.match(/^find\s+(\S+)\s+-name\s+(?:'([^']+)'|"([^"]+)"|([^\s|]+))\s*(?:\|\s*wc\s+-l)?\s*$/);
      if (findMatch) {
        const dir = findMatch[1].replace(/\/+$/, "") || "/";
        const rawPattern = findMatch[2] ?? findMatch[3] ?? findMatch[4] ?? "";
        const namePattern = sqlLike(rawPattern).replace(/\*/g, "%").replace(/\?/g, "_");
        logFn(`direct find: ${dir} -name '${rawPattern}'`);
        const paths = await findVirtualPathsFn(api, table, sessionsTable, dir, namePattern);
        let result = paths.join("\n") || "";
        if (/\|\s*wc\s+-l\s*$/.test(rewritten)) result = String(paths.length);
        return buildHandledSuccess(result || "(no matches)", rewritten, "find");
      }

      const grepParams = parseBashGrep(rewritten);
      if (grepParams) {
        logFn(`direct grep: pattern=${grepParams.pattern} path=${grepParams.targetPath}`);
        const result = await handleGrepDirectFn(api, table, sessionsTable, grepParams);
        if (result !== null) {
          return buildHandledSuccess(result, rewritten, "grep");
        }
      }
    } catch (e: any) {
      logFn(`direct query failed: ${e.message}`);
      return buildHandledFailure(`Memoree command failed: ${e.message}\n`, 1, rewritten);
    }
  }

  // Nothing matched by the inline fast-path. Route through the VFS shell bundle
  // — a sandboxed Node.js interpreter against the SQL backend, no host access.
  // We run it synchronously here so the output is available before returning the
  // decision; the write has already landed in the cloud `memory` table by then.
  //
  // Every command that the sandbox handles is returned as action="allow" with
  // a harmless replacement. Successful replacements print capped output;
  // failed replacements reproduce stdout/stderr and exit nonzero. The original
  // command never reaches the host. action="block" is reserved for commands
  // rejected above by the security policy.
  const isWriteRedirect = /^\s*(echo|printf|tee)\b/.test(rewritten) && /(^|[^0-9&>])>>?/.test(rewritten);
  logFn(`unroutable memory command, falling back to VFS shell: ${rewritten}`);
  try {
    const proc = runVfsShellFn(rewritten);
    if (proc.status === 0) {
      const output = (proc.stdout?.trim() ?? "") || (isWriteRedirect ? "(done)" : "");
      return buildHandledSuccess(output, rewritten, isWriteRedirect ? "write" : "command");
    }
    return buildHandledFailure(proc.stderr ?? "", proc.status, rewritten, proc.stdout ?? "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildHandledFailure(`Memoree sandbox command failed: ${message}\n`, 1, rewritten);
  }
}

/* c8 ignore start */
async function main(): Promise<void> {
  const input = await readStdin<CodexPreToolUseInput>();
  // SkillOpt: codex USES an org skill by shelling a read of its SKILL.md — arm the judgment
  // window on that command. Guarded at the call site too (armSkillOptOnSkillUse is already
  // internally swallowed): a throw here must NOT short-circuit the memory-path gate below, whose
  // top-level catch exits 0 (fail-open). Fail-closed for the SkillOpt side-effect.
  try { armSkillOptOnSkillUse(input.session_id, input.tool_name, input.tool_input, input.tool_use_id); }
  catch { /* never let the SkillOpt arm affect the tool decision */ }
  const decision = await processCodexPreToolUse(input);

  if (decision.action === "pass") return;
  if (decision.action === "allow") {
    // Codex >= 0.136 honors a PreToolUse `permissionDecision: "allow"` with
    // `updatedInput.command` and runs the rewritten command instead of the
    // original. The VFS operation already happened in processCodexPreToolUse.
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: decision.replacementCommand ?? "true" },
      },
    }));
    process.exit(0);
  }
  if (decision.output) process.stderr.write(decision.output);
  process.exit(2);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
}
/* c8 ignore stop */
