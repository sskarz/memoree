/**
 * Hybrid discovery for graph query/: lexical substring hits first, then
 * semantic near-misses from the node-embedding sidecar. find/ stays
 * lexical; this module is only used by query/.
 */

import type { GraphNode, GraphSnapshot } from "./types.js";

/** Max semantic fills after lexical hits. */
export const SEMANTIC_TOP_K = 20;
/** Drop weak cosine hits so random sidecar rows don't pollute query/. */
export const SEMANTIC_SCORE_FLOOR = 0.25;
/** Same budget as memory grep's embed round-trip. */
const DEFAULT_QUERY_EMBED_TIMEOUT_MS = 500;
export const QUERY_EMBED_TIMEOUT_MS = Number(process.env.MEMOREE_SEMANTIC_EMBED_TIMEOUT_MS ?? String(DEFAULT_QUERY_EMBED_TIMEOUT_MS));

export type QueryEmbedder = (text: string) => Promise<number[] | null>;

/** Packed sidecar: `data[i * dim + j]` is dimension j of `ids[i]`. */
export interface NodeEmbeddingIndex {
  dim: number;
  ids: string[];
  data: Float32Array;
}

export interface HybridFindOptions {
  queryEmbedding?: number[] | null;
  sidecar?: Record<string, number[]> | null;
  index?: NodeEmbeddingIndex | null;
}

/**
 * Plain-text-ish pattern → candidate for semantic search.
 * Skip regex-heavy queries (many metachars) where cosine is not what
 * the caller asked for. `+` is query/'s AND separator, not a regex quantifier.
 */
export function patternIsSemanticFriendly(pattern: string): boolean {
  if (!pattern || pattern.length < 2) return false;
  const metaMatches = pattern.match(/[|()\[\]{}^$?\\]/g);
  if (!metaMatches) return true;
  return metaMatches.length <= 1;
}

/**
 * Substring search on node id + label, ranked (exact label > prefix > id
 * contains > label contains), tie-broken by id. Shared by find/ and query/.
 * Returns ALL matches sorted; callers cap as needed.
 *
 * Multi-token: a pattern may carry several tokens separated by whitespace
 * or `+`. A node matches only when EVERY token appears in its id or label
 * (AND), ranked by the summed per-token rank.
 */
export function findMatches(snap: GraphSnapshot, pattern: string): GraphNode[] {
  const tokens = pattern.toLowerCase().split(/[\s+]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return [];

  if (tokens.length === 1) {
    const needle = tokens[0]!;
    const matches: GraphNode[] = [];
    for (const n of snap.nodes) {
      if (n.id.toLowerCase().includes(needle) || n.label.toLowerCase().includes(needle)) matches.push(n);
    }
    matches.sort((a, b) => {
      const ra = rank(a, needle);
      const rb = rank(b, needle);
      if (ra !== rb) return ra - rb;
      return a.id.localeCompare(b.id);
    });
    if (matches.length === 0) return fuzzyMatches(snap, needle);
    return matches;
  }

  const matches: GraphNode[] = [];
  for (const n of snap.nodes) {
    const id = n.id.toLowerCase();
    const lbl = n.label.toLowerCase();
    if (tokens.every((t) => id.includes(t) || lbl.includes(t))) matches.push(n);
  }
  const score = (n: GraphNode): number => tokens.reduce((s, t) => s + rank(n, t), 0);
  matches.sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    if (sa !== sb) return sa - sb;
    return a.id.localeCompare(b.id);
  });
  return matches;
}

function rank(n: GraphNode, needle: string): number {
  const lbl = n.label.toLowerCase();
  const id = n.id.toLowerCase();
  if (lbl === needle) return 0;
  if (lbl.startsWith(needle)) return 1;
  if (lbl.includes(needle)) return 2;
  if (id.includes(needle)) return 3;
  return 4;
}

function fuzzyMatches(snap: GraphSnapshot, needle: string): GraphNode[] {
  if (needle.length < 3) return [];
  const maxDist = Math.max(1, Math.floor(needle.length / 4));
  const scored: Array<{ n: GraphNode; d: number }> = [];
  for (const n of snap.nodes) {
    const d = editDistance(needle, n.label.toLowerCase(), maxDist);
    if (d <= maxDist) scored.push({ n, d });
  }
  scored.sort((a, b) => (a.d !== b.d ? a.d - b.d : a.n.id.localeCompare(b.n.id)));
  return scored.slice(0, 25).map((s) => s.n);
}

function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j]! < rowMin) rowMin = cur[j]!;
    }
    if (rowMin > cap) return cap + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/**
 * Lexical hits first (stable findMatches order), then semantic fills by
 * node id. Dedupes so a node that substring-matches is not listed twice.
 */
export function mergeHybridMatches(
  lexical: GraphNode[],
  semantic: GraphNode[],
): GraphNode[] {
  const seen = new Set<string>();
  const out: GraphNode[] = [];
  for (const n of lexical) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  for (const n of semantic) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}

export function sidecarRecordToIndex(sidecar: Record<string, number[]>): NodeEmbeddingIndex | null {
  const ids = Object.keys(sidecar);
  if (ids.length === 0) return null;
  const dim = sidecar[ids[0]!]!.length;
  if (dim === 0) return null;
  const data = new Float32Array(ids.length * dim);
  for (let i = 0; i < ids.length; i++) {
    const vec = sidecar[ids[i]!]!;
    if (vec.length !== dim) return null;
    data.set(vec, i * dim);
  }
  return { dim, ids, data };
}

export function semanticMatchesFromIndex(
  snap: GraphSnapshot,
  queryEmbedding: readonly number[],
  index: NodeEmbeddingIndex,
): GraphNode[] {
  if (queryEmbedding.length !== index.dim || index.dim === 0) return [];
  const byId = new Map(snap.nodes.map((n) => [n.id, n]));
  const scored: Array<{ i: number; score: number }> = [];
  for (let i = 0; i < index.ids.length; i++) {
    const score = cosineAt(index.data, index.dim, i, queryEmbedding);
    if (score === null || score < SEMANTIC_SCORE_FLOOR) continue;
    scored.push({ i, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const out: GraphNode[] = [];
  for (const { i } of scored) {
    const node = byId.get(index.ids[i]!);
    if (!node) continue;
    out.push(node);
    if (out.length >= SEMANTIC_TOP_K) break;
  }
  return out;
}

function cosineAt(
  data: Float32Array,
  dim: number,
  row: number,
  query: readonly number[],
): number | null {
  const off = row * dim;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let j = 0; j < dim; j++) {
    const a = data[off + j]!;
    const b = query[j]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return null;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function semanticMatchesFromSidecar(
  snap: GraphSnapshot,
  queryEmbedding: readonly number[],
  sidecar: Record<string, number[]>,
): GraphNode[] {
  const index = sidecarRecordToIndex(sidecar);
  if (!index) return [];
  return semanticMatchesFromIndex(snap, queryEmbedding, index);
}

/**
 * Union lexical findMatches with sidecar cosine hits. Missing vector /
 * sidecar → identical to today's lexical query/.
 */
export function hybridFindNodes(
  snap: GraphSnapshot,
  pattern: string,
  opts: HybridFindOptions = {},
): GraphNode[] {
  const lexical = findMatches(snap, pattern);
  const embedding = opts.queryEmbedding;
  if (!embedding || embedding.length === 0) return lexical;
  const index = opts.index ?? (opts.sidecar ? sidecarRecordToIndex(opts.sidecar) : null);
  if (!index) return lexical;
  const semantic = semanticMatchesFromIndex(snap, embedding, index);
  return mergeHybridMatches(lexical, semantic);
}

export async function embedQueryWithTimeout(
  pattern: string,
  embedQuery: QueryEmbedder,
  timeoutMs: number = Number.isFinite(QUERY_EMBED_TIMEOUT_MS) ? QUERY_EMBED_TIMEOUT_MS : DEFAULT_QUERY_EMBED_TIMEOUT_MS,
): Promise<number[] | null> {
  const budget = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : DEFAULT_QUERY_EMBED_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      embedQuery(pattern),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budget);
      }),
    ]);
    return result && result.length > 0 ? result : null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
