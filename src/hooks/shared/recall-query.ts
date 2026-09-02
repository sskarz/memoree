/**
 * Proactive-recall query — a focused semantic search over the summaries
 * (`memory`) table that returns ONE scored, attributed hit.
 *
 * Distinct from grep-core's searchMemoreeTables (which returns grep-shaped
 * {path,content} with no score): recall needs the cosine score to threshold
 * on relevance and the author/date/project to attribute the hit. Mirrors the
 * proven cosine pattern: `(summary_embedding <#> vec) AS score ORDER BY score
 * DESC`, where `<#>` is normalized similarity (0..1, higher = closer).
 */

import { serializeFloat4Array } from "../../shell/grep-core.js";
import { sqlStr } from "../../utils/sql.js";
import { isInjectableRecallHit, type RecallHit } from "./recall-format.js";
import { scoreVectorRows, vectorScanLimit } from "../../storage/vector-search.js";

// `summary` is selected alongside `description` so recall can inject a
// high-signal EXCERPT (the ## Key Facts / ## Entities sections carry the
// verbatim identifiers and values that the gist-only `description` drops).
// See recall-format.ts:pickExcerpt for how the excerpt is chosen.
const SELECT_COLS = "path, author, project, summary, description, last_update_date";

// Deterministic tie-break. Scores tie often on the lexical path (overlap is a
// small integer) and we inject only the top row, so without a stable secondary
// sort Postgres could return an arbitrary tied summary — surfacing a STALE fix
// instead of the newest. Prefer the most recently updated summary, then path
// as a final total order so the same prompt always recalls the same row.
const TIE_BREAK = "last_update_date DESC, path ASC";

/**
 * Restrict recall to this project's summaries. Empty `project_key` rows are
 * admitted only as a cold-start fallback — once the current key has any
 * embedded `/summaries/%` row, they stay out of the candidate pool.
 */
export function recallProjectKeySql(
  table: string,
  projectKey: string,
  embeddedRowPredicate: string,
): string {
  const key = sqlStr(projectKey);
  return (
    `(project_key = '${key}' OR (project_key = '' AND NOT EXISTS (` +
    `SELECT 1 FROM "${table}" AS _pk WHERE _pk.path LIKE '/summaries/%' ` +
    `AND ${embeddedRowPredicate} AND _pk.project_key = '${key}')))`
  );
}

export interface RecallQueryOptions {
  /** Restrict to this project basename when set. Prefer `projectKey`. */
  project?: string;
  /**
   * Stable git-remote (or abs-cwd) key. When set, recall only sees this
   * project's summaries. Legacy empty `project_key` rows are admitted only
   * when this key has no embedded summaries yet (cold-start fallback).
   */
  projectKey?: string;
  /** Exclude this exact summary path (e.g. the current session's own row). */
  excludePath?: string;
  /** Top-K rows to fetch before taking the best. */
  limit?: number;
}

type QueryFn = (sql: string) => Promise<Array<Record<string, unknown>>>;

/**
 * Return the best-scoring *injectable* summary for `queryEmbedding`, or null
 * when the table has no embedded rows. SessionStart stubs (`completed` /
 * `in progress`, empty wiki bodies) are skipped so a placeholder sitting at
 * the top of the LIMIT window cannot hide a real prior-work hit. If every
 * candidate is a stub, the raw top row is still returned so telemetry can
 * record a near-miss instead of `none`.
 */
export async function recallTopHit(
  query: QueryFn,
  memoryTable: string,
  queryEmbedding: number[],
  opts: RecallQueryOptions = {},
): Promise<RecallHit | null> {
  const vecLit = serializeFloat4Array(queryEmbedding);
  if (vecLit === "NULL") return null;

  // Only session SUMMARIES — the memory table also holds notes/goals/files;
  // a non-summary row must never be injected as "prior work".
  const filters = [`path LIKE '/summaries/%'`, `ARRAY_LENGTH(summary_embedding, 1) > 0`];
  if (opts.projectKey) {
    filters.push(recallProjectKeySql(memoryTable, opts.projectKey, "ARRAY_LENGTH(_pk.summary_embedding, 1) > 0"));
  } else if (opts.project) filters.push(`project = '${sqlStr(opts.project)}'`);
  if (opts.excludePath) filters.push(`path <> '${sqlStr(opts.excludePath)}'`);

  const sql =
    `SELECT ${SELECT_COLS}, ` +
    `(summary_embedding <#> ${vecLit}) AS score ` +
    `FROM "${memoryTable}" WHERE ${filters.join(" AND ")} ` +
    `ORDER BY score DESC, ${TIE_BREAK} LIMIT ${Math.max(1, opts.limit ?? 3)}`;

  try {
    return pickRecallHit(await query(sql), "semantic");
  } catch (error) {
    // SQLite and vanilla PostgreSQL intentionally have no vector operator.
    // Preserve Memoree's server path, but fall back to a bounded candidate
    // scan when the provider rejects `<#>`.
    const localFilters = [`path LIKE '/summaries/%'`, `summary_embedding IS NOT NULL`];
    if (opts.projectKey) {
      localFilters.push(recallProjectKeySql(memoryTable, opts.projectKey, "_pk.summary_embedding IS NOT NULL"));
    } else if (opts.project) localFilters.push(`project = '${sqlStr(opts.project)}'`);
    if (opts.excludePath) localFilters.push(`path <> '${sqlStr(opts.excludePath)}'`);
    const rows = await query(
      `SELECT ${SELECT_COLS}, summary_embedding FROM "${memoryTable}" ` +
        `WHERE ${localFilters.join(" AND ")} LIMIT ${vectorScanLimit()}`,
    ).catch(() => { throw error; });
    const scored = scoreVectorRows(rows, "summary_embedding", queryEmbedding)
      .sort((a, b) => b.score - a.score ||
        String(b.row.last_update_date ?? "").localeCompare(String(a.row.last_update_date ?? "")) ||
        String(a.row.path ?? "").localeCompare(String(b.row.path ?? "")));
    if (scored.length === 0) return null;
    return pickRecallHit(
      scored.map(item => ({ ...item.row, score: item.score })),
      "semantic",
    );
  }
}

function mapRow(r: Record<string, unknown>, mode: "semantic"): RecallHit {
  const score = Number(r["score"]);
  return {
    path: String(r["path"] ?? ""),
    author: String(r["author"] ?? ""),
    project: String(r["project"] ?? ""),
    summary: String(r["summary"] ?? ""),
    description: String(r["description"] ?? ""),
    lastUpdate: String(r["last_update_date"] ?? ""),
    score: Number.isFinite(score) ? score : 0,
    mode,
  };
}

/** Prefer the first injectable row; fall back to the raw top hit for telemetry. */
function pickRecallHit(rows: Array<Record<string, unknown>>, mode: "semantic"): RecallHit | null {
  if (!rows.length) return null;
  const hits = rows.map(row => mapRow(row, mode));
  return hits.find(hit => isInjectableRecallHit(hit)) ?? hits[0] ?? null;
}
