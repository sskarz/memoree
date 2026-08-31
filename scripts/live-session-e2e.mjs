#!/usr/bin/env node
/**
 * Live Claude Code + Codex session harness.
 *
 * Unlike runtime-validate's `--bare` capture turn, this runs `claude -p` and
 * `codex exec` WITH plugin/hooks enabled so SessionStart, capture, recall,
 * PreToolUse VFS, Stop, and SessionEnd fire on their own. Isolated HOME/DB only.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { runtimePaths } from "./runtime-manager.mjs";
import {
  assertAgentResponseContainsIdentifier,
  classifyAgentCommandError,
  copyCodexAuthentication,
  createValidationWorkspace,
  lexicalValidationPrompt,
  linkSharedEmbeddingRuntime,
  waitForCapture,
} from "./runtime-validate.mjs";

function status(message) {
  process.stdout.write(`  ${message}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
      timeout: options.timeout ?? 300_000,
    });
  } catch (cause) {
    const error = /** @type {Error & { stdout?: unknown; stderr?: unknown }} */ (cause);
    const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    const details = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join("\n");
    throw new Error(details ? `${error.message}\n${details}` : error.message, { cause: error });
  }
}

function runCodex(args, options) {
  try {
    return run("codex", args, options);
  } catch (error) {
    const classified = classifyAgentCommandError(error);
    throw classified ? new Error(classified, { cause: error }) : error;
  }
}

function vectorLength(value) {
  if (Array.isArray(value)) return value.length;
  if (typeof value !== "string") return 0;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function inspectLiveDatabase(databasePath, harborId, lanternId) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
    const journal = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
    const events = db.prepare("SELECT message, message_embedding FROM sessions").all();
    const summaries = db.prepare("SELECT path, summary, summary_embedding FROM memory WHERE path LIKE '/summaries/%'").all();
    assert(String(integrity).toLowerCase() === "ok", "SQLite integrity_check failed");
    assert(String(journal).toLowerCase() === "wal", "SQLite is not in WAL mode");
    const eventText = events.map(row => String(row.message ?? "")).join("\n");
    const summaryText = summaries.map(row => String(row.summary ?? "")).join("\n");
    assert(events.length > 0, "Live session captured zero session events — plugin hooks did not persist");
    assert(
      eventText.includes(harborId) || summaryText.includes(harborId),
      "Harbor kite identifier missing from isolated sessions/summaries",
    );
    if (lanternId) {
      assert(
        eventText.includes(lanternId) || summaryText.includes(lanternId),
        "Codex lantern identifier missing from isolated sessions/summaries",
      );
    }
    assert(summaries.length > 0, "Wiki/session reflection produced no summaries");
    assert(
      [...events.map(row => row.message_embedding), ...summaries.map(row => row.summary_embedding)]
        .some(value => vectorLength(value) === 768),
      "No 768-element embedding was stored",
    );
    return { events: events.length, summaries: summaries.length };
  } finally {
    db.close();
  }
}

function claudeLivePrompt(harborId, ruleId) {
  return [
    "You are in a Memoree live-harness session. Hooks are enabled. Complete EVERY step with tools.",
    `1. Remember this private fact and include the UUID in your final answer: the harbor kite code is ${harborId}.`,
    "2. Run: cat ~/.memoree/memory/identity.json",
    "3. Run: cat ~/.memoree/memory/index.md",
    "4. Run: cat ~/.memoree/memory/rules.md",
    "5. Run: cat ~/.memoree/memory/goals.md",
    `6. Create a rule with: printf '%s' 'live-e2e keep harbor kite identifiers' > ~/.memoree/memory/rules/active/${ruleId}.md`,
    "7. Run: cat ~/.memoree/memory/graph/layers",
    "8. Run: cat ~/.memoree/memory/graph/query/store",
    "9. Run: cat ~/.memoree/memory/docs/index.md",
    "Reply with a short confirmation that includes the harbor kite UUID. Do not invent a different UUID.",
  ].join("\n");
}

function claudeRecallPrompt() {
  return [
    "Search Memoree memory for the harbor kite code from earlier work.",
    "Use the Bash tool: grep -ri \"harbor kite\" ~/.memoree/memory/",
    "Answer with only the matching UUID. Do not invent an identifier.",
  ].join("\n");
}

function codexLivePrompt() {
  return [
    "Search Memoree memory for the harbor kite code from earlier work.",
    "Use the shell: grep -ri \"harbor kite\" ~/.memoree/memory/summaries/",
    "Answer with only the matching UUID. Do not invent an identifier. Do not say none was provided.",
  ].join("\n");
}

export async function runLiveSessionE2E() {
  const { runtimeDir } = runtimePaths();
  const cli = join(runtimeDir, "bundle", "cli.js");
  assert(existsSync(cli), `Promoted runtime CLI missing: ${cli}`);

  const root = createValidationWorkspace();
  const repository = join(root, "repo");
  const state = join(root, "state");
  const isolatedHome = join(root, "home");
  const isolatedTmp = join(root, "tmp");
  const isolatedCodexHome = join(isolatedHome, ".codex");
  const databasePath = join(state, "memoree.sqlite3");
  const realHome = homedir();
  const realClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(realHome, ".claude");
  const harborId = crypto.randomUUID();
  const lanternId = crypto.randomUUID();
  const ruleId = crypto.randomUUID();
  const kpiId = crypto.randomUUID();
  let passed = false;

  const env = {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    CLAUDE_CONFIG_DIR: realClaudeConfigDir,
    CODEX_HOME: isolatedCodexHome,
    TMPDIR: isolatedTmp,
    TMP: isolatedTmp,
    TEMP: isolatedTmp,
    MEMOREE_BACKEND: "sqlite",
    MEMOREE_SQLITE_PATH: databasePath,
    MEMOREE_CONFIG_PATH: join(state, "config.json"),
    MEMOREE_MEMORY_PATH: join(state, "memory"),
    MEMOREE_STATE_DIR: join(state, "agent-state"),
    MEMOREE_GRAPHS_HOME: join(state, "graphs"),
    MEMOREE_REPOSITORY_KEY: "live-session-e2e",
    MEMOREE_USER_NAME: "live-session-e2e",
    MEMOREE_CAPTURE: "true",
    MEMOREE_CAPTURE_ONLY_CLI: "false",
    MEMOREE_EMBEDDINGS: "true",
    MEMOREE_SESSION_EVENT_CACHE: "false",
    MEMOREE_SUMMARY_EVERY_N_MSGS: "1000",
    MEMOREE_RECALL_TIMEOUT_MS: "8000",
    MEMOREE_RECALL_THRESHOLD: "0.4",
    MEMOREE_RUNTIME_VALIDATION: "1",
    MEMOREE_VALIDATION_CLAUDE_HOME: realHome,
    MEMOREE_VALIDATION_CLAUDE_CONFIG_DIR: realClaudeConfigDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };

  try {
    mkdirSync(state, { recursive: true, mode: 0o700 });
    mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
    mkdirSync(isolatedTmp, { recursive: true, mode: 0o700 });
    mkdirSync(join(isolatedHome, ".claude"), { recursive: true, mode: 0o700 });
    linkSharedEmbeddingRuntime(realHome, isolatedHome);
    copyCodexAuthentication(realHome, isolatedCodexHome);

    mkdirSync(join(repository, "src"), { recursive: true });
    run("git", ["init", repository], { env, capture: false });
    run("git", ["config", "user.email", "live-e2e@memoree.local"], { cwd: repository, env });
    run("git", ["config", "user.name", "Memoree Live E2E"], { cwd: repository, env });
    writeFileSync(join(repository, "src", "store.ts"), [
      "export function persistGraph(snapshot: unknown): void {",
      "  void snapshot;",
      "}",
      "export function queryStore(term: string): string {",
      "  return term;",
      "}",
      "",
    ].join("\n"));
    writeFileSync(join(repository, "AGENTS.md"), [
      "# Live session e2e",
      "",
      "When asked to search Memoree, use grep/cat on ~/.memoree/memory.",
      "When a user message already contains a UUID, repeat that exact UUID.",
      "",
    ].join("\n"));
    run("git", ["add", "."], { cwd: repository, env });
    run("git", ["commit", "-m", "live e2e fixture"], { cwd: repository, env });

    status("initializing isolated sqlite + embeddings");
    run(process.execPath, [cli, "backend", "check"], { cwd: repository, env });
    run(process.execPath, [cli, "embeddings", "status"], { cwd: repository, env });

    status("installing Codex hooks into the isolated profile");
    run(process.execPath, [cli, "codex", "install"], { cwd: repository, env });

    status("building graph and seeding docs/rules/goals/kpis/skillify CLI");
    run(process.execPath, [cli, "graph", "build"], { cwd: repository, env });
    run(process.execPath, [cli, "graph", "history"], { cwd: repository, env });
    run(process.execPath, [cli, "docs", "set", "src/store.ts", "# store.ts\npersistGraph writes snapshots.\n"], { cwd: repository, env });
    const docsShow = run(process.execPath, [cli, "docs", "show", "src/store.ts"], { cwd: repository, env });
    assert(docsShow.includes("persistGraph"), `docs show missed persistGraph; stdout=${docsShow.slice(0, 400)}`);
    const createdGoalId = run(process.execPath, [cli, "goal", "add", "live e2e goal keep harbor kite"], { cwd: repository, env }).trim();
    const goals = run(process.execPath, [cli, "goal", "list", "--all"], { cwd: repository, env });
    assert(/live e2e goal/.test(goals), `goal list missed the live goal; stdout=${goals.slice(0, 400)}`);
    run(process.execPath, [cli, "kpi", "add", createdGoalId, kpiId, "1", "count", "live-e2e"], { cwd: repository, env });
    run(process.execPath, [cli, "docs", "wiki", "--dry-run"], { cwd: repository, env });
    const skillify = run(process.execPath, [cli, "skillify"], { cwd: repository, env });
    assert(/scope:/i.test(skillify), `skillify status missing scope; stdout=${skillify.slice(0, 400)}`);
    run(process.execPath, [cli, "context"], { cwd: repository, env });
    run(process.execPath, [cli, "memory", "backfill", "--dry-run"], { cwd: repository, env });
    run(process.execPath, [cli, "sessions", "prune"], { cwd: repository, env });

    status("running a live Claude Code session (hooks enabled, not --bare)");
    const claudeSession = crypto.randomUUID();
    let claudeOut = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      claudeOut = run("claude", [
        "-p",
        claudeLivePrompt(harborId, ruleId),
        "--permission-mode", "bypassPermissions",
        "--output-format", "text",
        "--no-session-persistence",
        "--session-id", attempt === 0 ? claudeSession : crypto.randomUUID(),
      ], { cwd: repository, env, timeout: 300_000 });
      try {
        assertAgentResponseContainsIdentifier(claudeOut, harborId, "live Claude Code session");
        break;
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }

    status("waiting for unaided capture + wiki summary");
    await waitForCapture(databasePath, harborId, { requireSummary: true, timeoutMs: 180_000 });

    status("running a live Claude recall session");
    const recallOut = run("claude", [
      "-p",
      claudeRecallPrompt(),
      "--permission-mode", "bypassPermissions",
      "--output-format", "text",
      "--no-session-persistence",
    ], { cwd: repository, env, timeout: 300_000 });
    assertAgentResponseContainsIdentifier(recallOut, harborId, "live Claude Code recall");

    status("running a live Codex capture session (hooks enabled)");
    const codexCapture = runCodex([
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "-s", "read-only",
      lexicalValidationPrompt(lanternId),
    ], { cwd: repository, env, timeout: 300_000 });
    assertAgentResponseContainsIdentifier(codexCapture, lanternId, "live Codex capture");

    status("running a live Codex recall of the Claude harbor-kite fact");
    const codexRecall = runCodex([
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "-s", "read-only",
      codexLivePrompt(),
    ], { cwd: repository, env, timeout: 300_000 });
    assertAgentResponseContainsIdentifier(codexRecall, harborId, "live Codex harbor-kite recall");

    status("waiting for Codex capture/summary");
    await waitForCapture(databasePath, lanternId, { requireSummary: true, timeoutMs: 180_000 });

    const counts = inspectLiveDatabase(databasePath, harborId, lanternId);
    process.stdout.write(
      `Live session e2e passed: ${counts.events} events, ${counts.summaries} summaries, unaided Claude/Codex hooks, wiki reflection, 768-d embeddings, VFS, graph, docs, skillify CLI.\n`,
    );
    passed = true;
  } finally {
    if (!passed) {
      process.stderr.write(`live session e2e workspace kept for inspection: ${root}\n`);
    } else {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          break;
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
          if (code !== "ENOTEMPTY" && code !== "EBUSY") throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        }
      }
    }
  }
}

async function main() {
  await runLiveSessionE2E();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`memoree live session e2e: ${error.message}\n`);
    process.exitCode = 1;
  });
}
