/**
 * Detached MCP session summary: after Antigravity MCP capture returns, a
 * background worker writes (or refreshes) `/summaries/<user>/<sessionId>.md`
 * with a search vector so proactive recall can inject it.
 *
 * The hot `tools/call` path must not wait on the embed daemon — capture
 * already stores the raw session row with `{ embed: false }`. This module
 * is the follow-up that makes those rows recall-eligible.
 *
 * Wiki summaries (agy -p / Stop) stay the richer write. This helper never
 * overwrites a finalized wiki row; it only inserts or refreshes its own
 * marked digest.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { uploadSummary, isFinalizedRow, isFinalizedSummaryText, type QueryFn, type UploadResult } from "../hooks/upload-summary.js";
import { sqlIdent, sqlStr } from "../utils/sql.js";
import { spawnDetachedNodeWorker } from "../utils/spawn-detached.js";
import { projectNameFromCwd } from "../utils/project-name.js";
import { deriveProjectKey } from "../utils/repo-identity.js";
import { escapedStringPrefix } from "../storage/sql-dialect.js";
import type { StorageDialect } from "../storage/schema.js";

export const MCP_SUMMARY_MARKER = "<!-- memoree-mcp-summary -->";

const MAX_EVENTS = 40;

export interface WriteMcpSessionSummaryOpts {
  query: QueryFn;
  memoryTable: string;
  sessionsTable: string;
  sessionId: string;
  userName: string;
  project: string;
  projectKey: string;
  agent?: string;
  embedding?: number[] | null;
  dialect?: StorageDialect;
  pluginVersion?: string;
  /** When `embedding` is omitted, embed the markdown before upload. */
  embedText?: (text: string) => Promise<number[] | null>;
}

export type WriteMcpSessionSummaryResult =
  | UploadResult
  | { path: "empty" }
  | { path: "skip-wiki" };

export function formatMcpEventLine(message: unknown): string {
  let obj: unknown = message;
  if (typeof message === "string") {
    try { obj = JSON.parse(message); } catch { return `- ${message.slice(0, 200)}`; }
  }
  if (obj && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    if (typeof rec.tool_name === "string" && rec.tool_name.length > 0) {
      const args = rec.tool_input !== undefined ? JSON.stringify(rec.tool_input).slice(0, 180) : "";
      return `- ${rec.tool_name}${args ? `: ${args}` : ""}`;
    }
    if (typeof rec.content === "string" && rec.content.trim()) {
      return `- ${rec.content.trim().slice(0, 200)}`;
    }
    if (typeof rec.type === "string") return `- ${rec.type}`;
  }
  return `- ${String(message).slice(0, 200)}`;
}

export function buildMcpSessionSummaryMarkdown(opts: {
  sessionId: string;
  project: string;
  sessionPath: string;
  events: unknown[];
}): string {
  const lines = opts.events.map(formatMcpEventLine).filter(line => line.length > 2).slice(-MAX_EVENTS);
  const happened = lines.length > 0
    ? `Antigravity MCP tools ran in this session.\n${lines.join("\n")}`
    : "Antigravity MCP tools ran in this session.";
  return [
    `# Session ${opts.sessionId}`,
    `- **Source**: ${opts.sessionPath}`,
    `- **Project**: ${opts.project}`,
    MCP_SUMMARY_MARKER,
    "",
    "## What Happened",
    happened,
    "",
    "## Key Facts",
    lines.length > 0 ? lines.join("\n") : "- MCP tool activity was captured for this session.",
    "",
  ].join("\n");
}

export async function writeMcpSessionSummary(opts: WriteMcpSessionSummaryOpts): Promise<WriteMcpSessionSummaryResult> {
  const dialect = opts.dialect ?? "sqlite";
  const stringPrefix = escapedStringPrefix(dialect);
  const memoryTable = sqlIdent(opts.memoryTable);
  const sessionsTable = sqlIdent(opts.sessionsTable);
  const likePat = `/sessions/%${opts.sessionId}%`;
  const rows = await opts.query(
    `SELECT message, path FROM "${sessionsTable}" ` +
    `WHERE path LIKE ${stringPrefix}'${sqlStr(likePat)}' ` +
    `ORDER BY creation_date DESC LIMIT ${MAX_EVENTS}`,
  );
  if (rows.length === 0) return { path: "empty" };

  const chronological = [...rows].reverse();
  const sessionPath = typeof chronological[0]?.path === "string"
    ? chronological[0].path
    : `/sessions/${opts.userName}/${opts.sessionId}.jsonl`;
  const text = buildMcpSessionSummaryMarkdown({
    sessionId: opts.sessionId,
    project: opts.project,
    sessionPath,
    events: chronological.map(r => r.message),
  });

  const vpath = `/summaries/${opts.userName}/${opts.sessionId}.md`;
  const existing = await opts.query(
    `SELECT summary, description FROM "${memoryTable}" WHERE path = '${sqlStr(vpath)}' LIMIT 1`,
  );
  if (existing.length > 0) {
    const summary = existing[0]?.summary;
    const description = existing[0]?.description;
    const ownsWiki = isFinalizedRow(summary, description)
      && isFinalizedSummaryText(summary)
      && typeof summary === "string"
      && !summary.includes(MCP_SUMMARY_MARKER);
    if (ownsWiki) return { path: "skip-wiki" };
  }

  let embedding = opts.embedding ?? null;
  if (opts.embedding === undefined && opts.embedText) {
    embedding = await opts.embedText(text);
  }

  return uploadSummary(opts.query, {
    tableName: opts.memoryTable,
    vpath,
    fname: `${opts.sessionId}.md`,
    userName: opts.userName,
    project: opts.project,
    projectKey: opts.projectKey,
    agent: opts.agent ?? "antigravity",
    sessionId: opts.sessionId,
    text,
    embedding,
    dialect,
    pluginVersion: opts.pluginVersion,
  });
}

export interface SpawnMcpSessionSummaryInput {
  sessionId: string;
  cwd: string;
}

/**
 * Fire-and-forget spawn. Best-effort: missing worker / EPERM must never
 * delay or fail the MCP `tools/call` reply. No-ops under Vitest unless
 * `MEMOREE_TEST_SPAWN_MCP_SUMMARY=1` so unit tests do not leak processes.
 */
export function spawnMcpSessionSummaryWorker(
  input: SpawnMcpSessionSummaryInput,
  deps: { spawn?: typeof spawnDetachedNodeWorker } = {},
): void {
  if (process.env.VITEST && process.env.MEMOREE_TEST_SPAWN_MCP_SUMMARY !== "1" && !deps.spawn) return;
  try {
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), "session-summary-worker.js");
    const tmpDir = join(tmpdir(), `memoree-mcp-summary-${input.sessionId}-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const configFile = join(tmpDir, "config.json");
    writeFileSync(configFile, JSON.stringify({
      sessionId: input.sessionId,
      cwd: input.cwd,
      project: projectNameFromCwd(input.cwd),
      projectKey: deriveProjectKey(input.cwd || process.cwd()).key,
    }));
    const spawn = deps.spawn ?? spawnDetachedNodeWorker;
    spawn(workerPath, [configFile]);
  } catch {
    // best-effort
  }
}
