/**
 * Shared summary-upload logic for claude-code + codex wiki workers.
 *
 * Combines the summary, size_bytes and description column writes into a
 * SINGLE UPDATE (or INSERT) statement — the Memoree backend silently
 * drops one of two rapid UPDATEs on the same row, so splitting these
 * across two statements ends up losing the summary column while only
 * description lands.
 */

import { randomUUID } from "node:crypto";
import { embeddingSqlLiteral } from "../embeddings/sql.js";
import { redactSecrets } from "./shared/redact.js";
import type { StorageDialect } from "../storage/schema.js";
import { escapedStringPrefix } from "../storage/sql-dialect.js";

export type QueryFn = (sql: string) => Promise<Array<Record<string, unknown>>>;

export interface UploadParams {
  tableName: string;
  vpath: string;
  fname: string;
  userName: string;
  project: string;
  /** Stable git-remote (or abs-cwd) key. Written on INSERT; left untouched on UPDATE. */
  projectKey?: string;
  agent: string;
  sessionId: string;
  text: string;
  ts?: string;
  /**
   * Pre-computed nomic embedding of `text` to store alongside the summary.
   * Passing `null` or `undefined` writes SQL NULL — the column stays
   * schema-compatible and the row is still reachable via the lexical
   * retrieval branch, it just won't show up in the semantic branch.
   */
  embedding?: number[] | null;
  /** Dialect used by the detached worker's selected storage backend. */
  dialect?: StorageDialect;
  /**
   * Memoree plugin version that produced this summary.
   * - INSERT: omitted lands the column default (''), schema-compatible.
   * - UPDATE: omitted means "don't touch the column" — a refresh from a
   *   legacy spawner that doesn't pass pluginVersion must NOT overwrite
   *   a previously-stored real version with ''. Pass an explicit empty
   *   string when you genuinely want to clear it.
   */
  pluginVersion?: string;
  /**
   * Antigravity MCP digest: never UPDATE a finalized wiki row, and INSERT
   * only when no row exists at `vpath` (avoids duplicate summary paths).
   */
  mcpDigest?: boolean;
}

export interface UploadResult {
  /**
   * Which write path ran. `"skip"` means the finalize-wins guard refused to
   * overwrite an already-finalized row with a placeholder/stub — no SQL was
   * sent.
   */
  path: "update" | "insert" | "skip";
  sql: string;
  descLength: number;
  summaryLength: number;
}

/** PostgreSQL E-string escaper: doubles backslashes and single quotes, strips control chars. */
export function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

const WHAT_HAPPENED_RE = /## What Happened\n([\s\S]*?)(?=\n##|$)/;

/**
 * The SessionStart placeholder sentinel. A row with this description (and no
 * real summary/embedding) is an unfinalized stub created at SessionStart that
 * the wiki worker is expected to replace with a real summary.
 */
export const PLACEHOLDER_DESCRIPTION = "in progress";

/**
 * Legacy `extractDescription` fallback. Never a finalize signal — a stub that
 * lacked `## What Happened` used to land this word in `description` / index.md
 * while the markdown body still said in-progress.
 */
export const STALE_COMPLETED_SENTINEL = "completed";

/** Codex/Claude/Antigravity wiki `execFileSync` budget. */
export const WIKI_EXEC_TIMEOUT_MS = 180_000;

/** Derive the short description from the "## What Happened" section of a wiki summary. */
export function extractDescription(text: string): string {
  const match = text.match(WHAT_HAPPENED_RE);
  const body = match ? match[1].trim().slice(0, 300) : "";
  return body || PLACEHOLDER_DESCRIPTION;
}

/**
 * Is `desc` a finalized (real) description? A finalized row has a description
 * that is non-empty and is NOT the SessionStart placeholder sentinel (or the
 * legacy `"completed"` stub word).
 *
 * Proactive recall only surfaces rows where `description <> 'in progress'`
 * AND `summary <> ''`, so "finalized" here matches exactly what recall needs.
 */
export function isFinalizedDescription(desc: unknown): boolean {
  if (typeof desc !== "string") return false;
  const d = desc.trim();
  return d !== "" && d !== PLACEHOLDER_DESCRIPTION && d.toLowerCase() !== STALE_COMPLETED_SENTINEL;
}

/**
 * Is the EXISTING row (`summary`, `description`) a FINALIZED summary — i.e.
 * one that proactive recall can surface? Requires a non-empty summary body AND
 * a real (non-placeholder) description. Used as the finalize-wins guard: a
 * finalized row must never be clobbered back to a placeholder/stub.
 */
export function isFinalizedRow(summary: unknown, description: unknown): boolean {
  const hasSummary = typeof summary === "string" && summary.trim() !== "";
  return hasSummary && isFinalizedDescription(description);
}

/**
 * Does `text` look like a REAL (finalized) wiki summary, as opposed to the
 * SessionStart placeholder or an empty/content-free stub?
 *
 * The wiki worker's prompt always emits a populated "## What Happened" section;
 * the SessionStart placeholder never does. So the presence of a non-empty
 * "## What Happened" body is the reliable signal that this write carries a real
 * summary. A missing `## What Happened` is always a stub — never treat
 * `"completed"` as a finalize signal.
 */
export function isFinalizedSummaryText(text: unknown): boolean {
  if (typeof text !== "string" || text.trim() === "") return false;
  const match = text.match(WHAT_HAPPENED_RE);
  return match ? match[1].trim() !== "" : false;
}

export type WikiUploadDecision = "upload" | "skip-missing" | "skip-stub" | "skip-unchanged";

export interface WikiUploadOptions {
  /** False when execFileSync threw (timeout, non-zero, kill). */
  execSucceeded?: boolean;
  /** Tmp summary contents captured *before* exec, or null if the file was missing. */
  previous?: string | null;
}

/**
 * After wiki `execFileSync` (including timeout), upload a body that has a
 * populated `## What Happened`. On exec failure, also require the tmp file to
 * have *changed* — resume runs pre-seed the prior finalized summary, and
 * salvaging that unchanged file would stampOffset/finalizeSummary past events
 * that were never summarized.
 */
export function decideWikiUpload(
  raw: string | null | undefined,
  options: WikiUploadOptions = {},
): WikiUploadDecision {
  if (typeof raw !== "string" || raw.trim() === "") return "skip-missing";
  if (!isFinalizedSummaryText(raw)) return "skip-stub";
  if (options.execSucceeded === false) {
    const previous = options.previous ?? null;
    if (previous !== null && raw === previous) return "skip-unchanged";
  }
  return "upload";
}

/**
 * Marker MCP digest rows carry so a later wiki write stays distinguishable.
 * Keep in sync with `MCP_SUMMARY_MARKER` in src/mcp/session-summary.ts.
 */
export const MCP_DIGEST_MARKER = "<!-- memoree-mcp-summary -->";

function isMcpDigestSummary(summary: unknown): boolean {
  return typeof summary === "string" && summary.includes(MCP_DIGEST_MARKER);
}

/** SQL: row is an MCP digest or is not yet a finalized wiki write-up. */
function mcpDigestReplaceableSql(): string {
  return (
    `(summary LIKE '%${MCP_DIGEST_MARKER}%' ` +
    `OR summary NOT LIKE '%## What Happened%' ` +
    `OR description = '${PLACEHOLDER_DESCRIPTION}' ` +
    `OR description = '')`
  );
}

/**
 * Upload or refresh a wiki summary row.
 *
 * IMPORTANT: summary and description must stay in the SAME SQL statement.
 * See module docstring for the rationale.
 */
export async function uploadSummary(query: QueryFn, params: UploadParams): Promise<UploadResult> {
  const { tableName, vpath, fname, userName, project, agent } = params;
  const projectKey = params.projectKey ?? "";
  // Mask any secret a summary may have quoted before it's stored/indexed.
  const text = redactSecrets(params.text);
  const ts = params.ts ?? new Date().toISOString();
  const desc = extractDescription(text);
  const sizeBytes = Buffer.byteLength(text);
  const dialect = params.dialect ?? "postgres";
  const embSql = embeddingSqlLiteral(params.embedding ?? null, dialect);
  const stringPrefix = escapedStringPrefix(dialect);
  // Keep undefined sentinel for UPDATE conditional. INSERT still defaults to ''.
  const pluginVersion = params.pluginVersion;

  const existing = await query(
    `SELECT path, summary, description FROM "${tableName}" WHERE path = '${esc(vpath)}' LIMIT 1`
  );

  if (params.mcpDigest) {
    const pluginVersionSet = pluginVersion === undefined
      ? ""
      : `plugin_version = '${esc(pluginVersion)}', `;
    const updateSql =
      `UPDATE "${tableName}" SET ` +
      `summary = ${stringPrefix}'${esc(text)}', ` +
      `summary_embedding = ${embSql}, ` +
      `size_bytes = ${sizeBytes}, ` +
      `description = ${stringPrefix}'${esc(desc)}', ` +
      pluginVersionSet +
      `last_update_date = '${ts}' ` +
      `WHERE path = '${esc(vpath)}' AND ${mcpDigestReplaceableSql()}`;
    await query(updateSql);
    const afterUpdate = await query(
      `SELECT summary, description FROM "${tableName}" WHERE path = '${esc(vpath)}' LIMIT 1`,
    );
    if (afterUpdate.length > 0) {
      if (isMcpDigestSummary(afterUpdate[0]?.["summary"])) {
        return { path: "update", sql: updateSql, descLength: desc.length, summaryLength: text.length };
      }
      return { path: "skip", sql: updateSql, descLength: desc.length, summaryLength: text.length };
    }
    const pluginVersionForInsert = pluginVersion ?? "";
    const insertSql =
      `INSERT INTO "${tableName}" (id, path, filename, summary, summary_embedding, author, mime_type, size_bytes, project, project_key, description, agent, plugin_version, creation_date, last_update_date) ` +
      `SELECT '${randomUUID()}', '${esc(vpath)}', '${esc(fname)}', ${stringPrefix}'${esc(text)}', ${embSql}, '${esc(userName)}', 'text/markdown', ` +
      `${sizeBytes}, '${esc(project)}', '${esc(projectKey)}', ${stringPrefix}'${esc(desc)}', '${esc(agent)}', '${esc(pluginVersionForInsert)}', '${ts}', '${ts}' ` +
      `WHERE NOT EXISTS (SELECT 1 FROM "${tableName}" WHERE path = '${esc(vpath)}')`;
    await query(insertSql);
    const afterInsert = await query(
      `SELECT summary FROM "${tableName}" WHERE path = '${esc(vpath)}' LIMIT 1`,
    );
    if (isMcpDigestSummary(afterInsert[0]?.["summary"])) {
      return { path: "insert", sql: insertSql, descLength: desc.length, summaryLength: text.length };
    }
    return { path: "skip", sql: insertSql, descLength: desc.length, summaryLength: text.length };
  }

  if (!isFinalizedSummaryText(text)) {
    // Stubs stay SessionStart placeholders. Stamping JSONL offset onto a stub
    // used to UPDATE description to the old `"completed"` fallback.
    return { path: "skip", sql: "", descLength: desc.length, summaryLength: text.length };
  }

  if (existing.length > 0) {
    // FINALIZE-WINS: a finalized row (real summary + non-placeholder
    // description) must never be clobbered back to a placeholder/stub.
    // Incoming writes without `## What Happened` are rejected above.

    // Only include plugin_version in the SET clause when the caller
    // explicitly provided a value (including ''). A legacy spawner that
    // omits pluginVersion would otherwise erase a previously-stored
    // real version on every refresh. Keeping the column out of SET
    // leaves the existing row value untouched.
    const pluginVersionSet = pluginVersion === undefined
      ? ""
      : `plugin_version = '${esc(pluginVersion)}', `;
    const sql =
      `UPDATE "${tableName}" SET ` +
      `summary = ${stringPrefix}'${esc(text)}', ` +
      `summary_embedding = ${embSql}, ` +
      `size_bytes = ${sizeBytes}, ` +
      `description = ${stringPrefix}'${esc(desc)}', ` +
      pluginVersionSet +
      `last_update_date = '${ts}' ` +
      `WHERE path = '${esc(vpath)}'`;
    await query(sql);
    return { path: "update", sql, descLength: desc.length, summaryLength: text.length };
  }

  // INSERT path: new row, no previous value to preserve — default to ''.
  const pluginVersionForInsert = pluginVersion ?? "";
  const sql =
    `INSERT INTO "${tableName}" (id, path, filename, summary, summary_embedding, author, mime_type, size_bytes, project, project_key, description, agent, plugin_version, creation_date, last_update_date) ` +
    `VALUES ('${randomUUID()}', '${esc(vpath)}', '${esc(fname)}', ${stringPrefix}'${esc(text)}', ${embSql}, '${esc(userName)}', 'text/markdown', ` +
    `${sizeBytes}, '${esc(project)}', '${esc(projectKey)}', ${stringPrefix}'${esc(desc)}', '${esc(agent)}', '${esc(pluginVersionForInsert)}', '${ts}', '${ts}')`;
  await query(sql);
  return { path: "insert", sql, descLength: desc.length, summaryLength: text.length };
}
