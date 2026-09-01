/**
 * Memoree MCP tools — wrap the existing VFS sandbox so Antigravity (and any
 * MCP client) can read/write ~/.memoree/memory without host-command rewrite.
 *
 * Each tool builds a sandboxed command and runs it through the Codex VFS
 * path (processCodexPreToolUse), which already implements graph/docs/rules/
 * goals/KPI/index/summaries.
 */

import { processCodexPreToolUse } from "../hooks/codex/pre-tool-use.js";
import { TILDE_PATH, touchesMemory } from "../hooks/memory-path-utils.js";

/** Sandboxed VFS command → MCP tool. echo/printf/tee all write. */
export const SANDBOXED_COMMAND_MCP_TOOLS: Record<string, string> = {
  cat: "memoree_read",
  ls: "memoree_ls",
  grep: "memoree_grep",
  head: "memoree_head",
  tail: "memoree_tail",
  wc: "memoree_wc",
  find: "memoree_find",
  jq: "memoree_jq",
  echo: "memoree_write",
  printf: "memoree_write",
  tee: "memoree_write",
  mv: "memoree_mv",
  rm: "memoree_rm",
};

export const MEMOREE_MCP_TOOL_NAMES = [
  "memoree_ls",
  "memoree_read",
  "memoree_grep",
  "memoree_head",
  "memoree_tail",
  "memoree_wc",
  "memoree_find",
  "memoree_jq",
  "memoree_write",
  "memoree_mv",
  "memoree_rm",
] as const;

/**
 * Unique product job for each MCP tool, plus why it is not an alias of a
 * sibling. echo/printf/tee collapse to memoree_write: they are three shell
 * spellings of the same lifecycle write. Dropping any other tool would break
 * the published sandbox contract (Claude/Codex SKILL.md + MEMORY_COMMAND_GUIDANCE).
 */
export const MCP_TOOL_UNIQUENESS = {
  memoree_ls: {
    job: "Inventory a directory without opening file bodies.",
    unlike: "memoree_read opens file bodies; ls only lists names.",
  },
  memoree_read: {
    job: "Read a whole virtual file (identity, rules.md, summaries, graph/query, docs).",
    unlike: "head/tail/wc slice or measure a file; ls lists names; grep searches contents.",
  },
  memoree_grep: {
    job: "Search file contents across a subtree (recall).",
    unlike: "memoree_find matches filenames, not bodies.",
  },
  memoree_head: {
    job: "Read the start of a large file without loading all of it.",
    unlike: "memoree_read is the whole file; memoree_tail is the end.",
  },
  memoree_tail: {
    job: "Read the end of a large file (recent index/session lines).",
    unlike: "memoree_head is the start; memoree_read is the whole file.",
  },
  memoree_wc: {
    job: "Measure line count before deciding to cat a huge transcript.",
    unlike: "memoree_read returns the body; wc returns a count.",
  },
  memoree_find: {
    job: "Locate files by name, not by content.",
    unlike: "memoree_grep searches bodies; find searches names.",
  },
  memoree_jq: {
    job: "Extract fields from real JSON (identity.json). Not session .jsonl views.",
    unlike: "memoree_read dumps the whole JSON document.",
  },
  memoree_write: {
    job: "Create or overwrite a rule, goal, or KPI file (printf/echo/tee).",
    unlike: "memoree_mv transitions an existing id; memoree_rm closes it.",
  },
  memoree_mv: {
    job: "Move a rule or goal between lifecycle dirs, keeping the same id.",
    unlike: "memoree_write creates; memoree_rm closes without choosing the destination.",
  },
  memoree_rm: {
    job: "Mark a rule done or close a goal (lifecycle, not a hard delete).",
    unlike: "memoree_mv is an explicit status move; rm is close/done. Neither unlinks.",
  },
} as const satisfies Record<(typeof MEMOREE_MCP_TOOL_NAMES)[number], { job: string; unlike: string }>;

export const MCP_TOOL_JOBS = Object.fromEntries(
  MEMOREE_MCP_TOOL_NAMES.map(name => [name, MCP_TOOL_UNIQUENESS[name].job]),
) as Record<(typeof MEMOREE_MCP_TOOL_NAMES)[number], string>;

export const MEMOREE_MCP_TOOLS = [
  {
    name: "memoree_ls",
    description: "Inventory a Memoree directory by name only (identity, rules, goals, summaries, graph, docs). Does not open file bodies — use memoree_read for content.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Memory-relative path, e.g. \"\" or \"summaries\"" } },
    },
  },
  {
    name: "memoree_read",
    description: "Read an entire virtual file (identity.json, rules.md, graph/query/<q>, docs/...). Use head/tail/wc for large files instead of loading everything.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Memory-relative path, e.g. identity.json" } },
      required: ["path"],
    },
  },
  {
    name: "memoree_grep",
    description: "Search file CONTENTS across a Memoree subtree (recall). Prefer summaries/. Use memoree_find to locate files by name.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Subtree to search; default is the memory root" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "memoree_head",
    description: "First N lines of a large Memoree file without a full read. Use memoree_tail for the end.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        lines: { type: "number", description: "Line count; default 10" },
      },
      required: ["path"],
    },
  },
  {
    name: "memoree_tail",
    description: "Last N lines of a large Memoree file (recent index/session text) without a full read. Use memoree_head for the start.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        lines: { type: "number", description: "Line count; default 10" },
      },
      required: ["path"],
    },
  },
  {
    name: "memoree_wc",
    description: "Line count of a Memoree file (wc -l). Returns a count, not the body — use before deciding to memoree_read a huge transcript.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "memoree_find",
    description: "Locate files by NAME glob (find <path> -name <pattern>). Use memoree_grep to search file contents.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to search; default is the memory root" },
        name: { type: "string", description: "find -name pattern; default *" },
      },
    },
  },
  {
    name: "memoree_jq",
    description: "Extract a JSON field (identity.json). Not a full-document read — do not use on rendered session .jsonl views.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        filter: { type: "string", description: "jq filter; default ." },
      },
      required: ["path"],
    },
  },
  {
    name: "memoree_write",
    description: "Create or overwrite a rule, goal, or KPI (printf/echo/tee). Path encodes lifecycle. Use memoree_mv to change status of an existing id.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "memoree_mv",
    description: "Move a rule or goal between lifecycle directories, keeping the same id (active↔done, opened→in_progress). Not a create and not a close.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    },
  },
  {
    name: "memoree_rm",
    description: "Mark a rule done or close a goal. Lifecycle transition, not a hard delete — the id remains readable under done/closed.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
] as const;

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function positiveLineCount(value: unknown, fallback = 10): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Map a tool path onto ~/.memoree/memory/... so the VFS intercept fires. */
export function normalizeMemoryPath(path: string): string {
  let p = (path ?? "").trim();
  if (!p || p === "." || p === "/") return TILDE_PATH;
  if (p === "~/.memoree/memory" || p.startsWith("~/.memoree/memory/") || p.startsWith("$HOME/.memoree/memory")) {
    return p;
  }
  p = p.replace(/^\/+/, "");
  if (p.startsWith(".memoree/memory/")) p = p.slice(".memoree/memory/".length);
  else if (p === ".memoree/memory") p = "";
  else if (p.startsWith("memory/")) p = p.slice("memory/".length);
  else if (p === "memory") p = "";
  return p ? `${TILDE_PATH}/${p}` : TILDE_PATH;
}

export function buildMemoryCommand(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "memoree_ls":
      return `ls ${normalizeMemoryPath(String(args.path ?? ""))}`;
    case "memoree_read":
      return `cat ${normalizeMemoryPath(String(args.path ?? ""))}`;
    case "memoree_grep":
      return `grep -ri ${shellSingleQuote(String(args.pattern ?? ""))} ${normalizeMemoryPath(String(args.path ?? ""))}`;
    case "memoree_head":
      return `head -n ${positiveLineCount(args.lines)} ${normalizeMemoryPath(String(args.path ?? ""))}`;
    case "memoree_tail":
      return `tail -n ${positiveLineCount(args.lines)} ${normalizeMemoryPath(String(args.path ?? ""))}`;
    case "memoree_wc":
      return `wc -l ${normalizeMemoryPath(String(args.path ?? ""))}`;
    case "memoree_find":
      return `find ${normalizeMemoryPath(String(args.path ?? ""))} -name ${shellSingleQuote(String(args.name ?? "*"))}`;
    case "memoree_jq":
      return `jq ${shellSingleQuote(String(args.filter ?? "."))} ${normalizeMemoryPath(String(args.path ?? ""))}`;
    case "memoree_write":
      return `printf '%s' ${shellSingleQuote(String(args.content ?? ""))} > ${normalizeMemoryPath(String(args.path ?? ""))}`;
    case "memoree_mv":
      return `mv ${normalizeMemoryPath(String(args.from ?? ""))} ${normalizeMemoryPath(String(args.to ?? ""))}`;
    case "memoree_rm":
      return `rm ${normalizeMemoryPath(String(args.path ?? ""))}`;
    default:
      throw new Error(`unknown Memoree MCP tool: ${name}`);
  }
}

export interface MemoreeToolResult {
  ok: boolean;
  text: string;
}

export async function runMemoreeTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string = process.cwd(),
  processFn: typeof processCodexPreToolUse = processCodexPreToolUse,
): Promise<MemoreeToolResult> {
  const command = buildMemoryCommand(name, args);
  if (!touchesMemory(command)) {
    return { ok: false, text: "path is outside Memoree memory" };
  }
  const decision = await processFn({
    session_id: "mcp",
    tool_name: "shell",
    tool_use_id: "mcp",
    tool_input: { command },
    cwd,
    hook_event_name: "pre_tool_use",
    model: "mcp",
  });
  const text = decision.output ?? "";
  if (decision.action === "block") return { ok: false, text: text || "denied" };
  if (decision.action === "pass") return { ok: false, text: text || "not a Memoree memory path" };
  return { ok: true, text };
}
