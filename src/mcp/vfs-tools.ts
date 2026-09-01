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

export const MEMOREE_MCP_TOOLS = [
  {
    name: "memoree_ls",
    description: "List a directory in Memoree memory (identity, rules, goals, summaries, graph, docs).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Memory-relative path, e.g. \"\" or \"summaries\"" } },
    },
  },
  {
    name: "memoree_read",
    description: "Read a file in Memoree memory. Paths are virtual (identity.json, rules.md, graph/query/<q>, docs/...).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Memory-relative path, e.g. identity.json" } },
      required: ["path"],
    },
  },
  {
    name: "memoree_grep",
    description: "Search Memoree memory with grep. Prefer summaries/ for recall.",
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
    description: "Read the first N lines of a Memoree memory file (same as sandboxed head).",
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
    description: "Read the last N lines of a Memoree memory file (same as sandboxed tail).",
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
    description: "Count lines in a Memoree memory file (wc -l).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "memoree_find",
    description: "Find names under a Memoree memory directory (find <path> -name <pattern>).",
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
    description: "Run jq on a JSON file in Memoree memory. Do not use on rendered session .jsonl views.",
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
    description: "Write a rule, goal, or KPI file. Path encodes lifecycle (rules/active/<uuid>.md, goal/<owner>/<status>/<id>.md).",
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
    description: "Move a rule or goal between lifecycle directories, keeping the same id.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    },
  },
  {
    name: "memoree_rm",
    description: "Mark a rule done or close a goal (lifecycle transition, not a hard delete).",
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
