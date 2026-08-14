/**
 * Virtual filesystem handler for graph queries under
 * ~/.memoree/memory/graph/ — same intercept pattern as the
 * memory mount's BM25 grep. Synthesizes text responses on the fly
 * from the local snapshot; no real files exist at these paths.
 *
 * Endpoints (v1.1 trimmed surface — codex review recommended limit):
 *   index.md           - overview: commit, counts, file stats, edge kinds
 *   find/<pattern>     - case-insensitive substring search on node ids
 *                        + labels. Emits numbered handles [N] persisted
 *                        in .find-handles.json for the current worktree.
 *   show/<key>         - <key> is either a digit (handle from last find)
 *                        OR a substring pattern. Returns node detail +
 *                        1-hop neighborhood grouped by edge relation.
 *
 * Intentionally NOT shipped in v1.1: callers/, callees/, importers/.
 * They're just filtered views of show. Prematurely freezing the path
 * taxonomy makes future API evolution painful (codex P1 review).
 *
 * Privacy: the handler reads the local snapshot file on disk. find/show/impact
 * stay CPU-only. query/ may ask the local embed daemon for a query vector
 * when a sidecar exists; daemon failure falls back to lexical search.
 * Backend synchronization happens in a separate async worker
 * (src/hooks/graph-pull-worker.ts).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";

import { readLastBuild } from "./last-build.js";
import { repoDir } from "./snapshot.js";
import { deriveProjectKey } from "../utils/repo-identity.js";
import type { GraphSnapshot, GraphNode, GraphEdge } from "./types.js";
import { renderNeighborhood } from "./render/neighborhood.js";
import { renderLayers } from "./render/layers.js";
import { renderTour } from "./render/tour.js";
import { renderPath } from "./render/path.js";
import { renderImpact } from "./render/impact.js";
import {
  embedQueryWithTimeout,
  findMatches,
  hybridFindNodes,
  patternIsSemanticFriendly,
  type QueryEmbedder,
} from "./hybrid-find.js";
import { loadNodeEmbeddingIndex } from "./node-embeddings.js";
import { embeddingsDisabled } from "../embeddings/disable.js";
import { EmbedClient } from "../embeddings/client.js";
import { fileURLToPath } from "node:url";

function workTreeIdFor(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

export type GraphVfsResult =
  | { kind: "ok"; body: string }
  | { kind: "not-found"; message: string }
  | { kind: "no-graph"; message: string };

export interface GraphVfsAsyncDeps {
  /** Override query embedder (tests). Production uses the nomic daemon. */
  embedQuery?: QueryEmbedder;
  /** Injected sidecar; when omitted, read the packed index from disk. */
  sidecar?: Record<string, number[]> | null;
  /** When false, skip semantic even if a sidecar exists. */
  embeddingsEnabled?: boolean;
}

function defaultQueryEmbedder(): QueryEmbedder {
  if (embeddingsDisabled()) return async () => null;
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "..", "embeddings", "embed-daemon.js");
  const client = new EmbedClient(
    existsSync(bundled) ? { daemonEntry: bundled, timeoutMs: 500 } : { timeoutMs: 500 },
  );
  return async (text: string) => {
    try {
      const vector = await client.embed(text, "query");
      return vector && vector.length > 0 ? vector : null;
    } catch {
      return null;
    }
  };
}

/**
 * Top-level dispatcher. `subpath` is whatever comes after
 * <memory>/graph/ — e.g. "index.md", "find/pushSnapshot", "show/3".
 *
 * Best-effort: any error returns a "no-graph" result with the reason
 * inline; this keeps the agent unblocked even when the graph isn't
 * available (e.g. on a fresh checkout that hasn't built yet).
 *
 * `query/` on this sync path is lexical only (exists/stat, tests).
 * Production reads go through handleGraphVfsAsync so query/ can union
 * sidecar embeddings without blocking find/show/impact.
 */
export function handleGraphVfs(subpath: string, cwd: string): GraphVfsResult {
  // Normalize leading slash so callers can pass either "/find/X" or "find/X".
  const path = subpath.replace(/^\/+/, "");

  // Empty path → directory listing (so `ls` and bare reads work).
  if (path === "" || path === "/") {
    return { kind: "ok", body: dirListing() };
  }

  // index.md: cheap, no snapshot parsing for the common case.
  if (path === "index.md" || path === "index") {
    return loadSnapshotOrError(cwd, (snap, baseDir) => ({
      kind: "ok",
      body: renderIndex(snap, baseDir, cwd),
    }));
  }

  // find/<pattern> — pattern may contain anything except literal "/" which
  // is the next path segment. We accept the rest of the string verbatim.
  if (path.startsWith("find/")) {
    const pattern = path.slice("find/".length);
    if (pattern === "") {
      return { kind: "not-found", message: "find/ requires a pattern: cat memory/graph/find/<keyword>" };
    }
    return loadSnapshotOrError(cwd, (snap, baseDir) => ({
      kind: "ok",
      body: renderFind(snap, pattern, baseDir, workTreeIdFor(cwd)),
    }));
  }

  // show/<key> — key is either a digit handle (from a prior find) or a
  // substring pattern (when the agent already knows the symbol).
  if (path.startsWith("show/")) {
    const key = path.slice("show/".length);
    if (key === "") {
      return { kind: "not-found", message: "show/ requires a handle or pattern" };
    }
    return loadSnapshotOrError(cwd, (snap, baseDir) => ({
      kind: "ok",
      body: renderShow(snap, key, baseDir, workTreeIdFor(cwd)),
    }));
  }

  // query/<pattern> — 2-in-1: find + 1-hop expand of the top matches.
  if (path.startsWith("query/")) {
    const pattern = path.slice("query/".length);
    if (pattern === "") {
      return { kind: "not-found", message: "query/ requires a pattern: cat memory/graph/query/<keyword>" };
    }
    return loadSnapshotOrError(cwd, (snap, baseDir) => ({
      kind: "ok",
      body: renderQuery(snap, pattern, baseDir, workTreeIdFor(cwd), findMatches(snap, pattern), {
        kind: "lexical",
        reason: "sync",
      }),
    }));
  }

  // impact/<pattern> — transitive dependents (blast radius) of a symbol.
  if (path.startsWith("impact/")) {
    const pattern = path.slice("impact/".length);
    if (pattern === "") {
      return { kind: "not-found", message: "impact/ requires a pattern: cat memory/graph/impact/<symbol>" };
    }
    return loadSnapshotOrError(cwd, (snap) => ({ kind: "ok", body: renderImpact(snap, pattern) }));
  }

  // neighborhood/<file> — symbols in a file + its cross-file neighbors.
  if (path.startsWith("neighborhood/")) {
    const file = path.slice("neighborhood/".length);
    if (file === "") {
      return { kind: "not-found", message: "neighborhood/ requires a file path: cat memory/graph/neighborhood/<file>" };
    }
    return loadSnapshotOrError(cwd, (snap) => ({ kind: "ok", body: renderNeighborhood(snap, file) }));
  }

  // layers[/] — architectural subsystem grouping by path heuristic.
  if (path === "layers" || path === "layers/" || path === "layers/index.md") {
    return loadSnapshotOrError(cwd, (snap) => ({ kind: "ok", body: renderLayers(snap) }));
  }

  // tour[/index.md] — deterministic dependency-ordered walkthrough.
  if (path === "tour" || path === "tour/" || path === "tour/index.md") {
    return loadSnapshotOrError(cwd, (snap) => ({ kind: "ok", body: renderTour(snap) }));
  }

  // path/<from>/<to> — shortest path between two symbol patterns. Both are
  // SUBSTRING patterns matched against node id + label (renderPath resolves
  // them), so a bare symbol name is enough — you don't need the file-qualified
  // id, and the `from` pattern therefore shouldn't contain a slash. We split
  // on the first slash after the prefix; if `from` needs a slash, use a
  // narrower unique substring instead.
  if (path.startsWith("path/")) {
    const rest = path.slice("path/".length);
    const slash = rest.indexOf("/");
    if (slash <= 0 || slash === rest.length - 1) {
      return { kind: "not-found", message: "path/ needs two patterns: cat memory/graph/path/<from>/<to> (each a symbol-name substring, no slash)" };
    }
    const fromPattern = rest.slice(0, slash);
    const toPattern = rest.slice(slash + 1);
    return loadSnapshotOrError(cwd, (snap) => ({ kind: "ok", body: renderPath(snap, fromPattern, toPattern) }));
  }

  return {
    kind: "not-found",
    message: `Unknown endpoint: graph/${path}\nAvailable: index.md, find/<pattern>, query/<pattern>, show/<handle-or-pattern>, impact/<pattern>, neighborhood/<file>, layers, tour, path/<from>/<to>`,
  };
}

/**
 * Async dispatcher used by cat/Read. Non-query endpoints match handleGraphVfs
 * exactly (CPU-only). query/ unions lexical findMatches with sidecar cosine
 * hits when embeddings are on and a sidecar exists.
 */
export async function handleGraphVfsAsync(
  subpath: string,
  cwd: string,
  deps: GraphVfsAsyncDeps = {},
): Promise<GraphVfsResult> {
  const path = subpath.replace(/^\/+/, "");
  if (!path.startsWith("query/")) return handleGraphVfs(subpath, cwd);

  const pattern = path.slice("query/".length);
  if (pattern === "") {
    return { kind: "not-found", message: "query/ requires a pattern: cat memory/graph/query/<keyword>" };
  }

  const loaded = loadSnapshot(cwd);
  if (loaded.kind !== "loaded") return loaded;

  const enabled = deps.embeddingsEnabled ?? !embeddingsDisabled();
  const semanticFriendly = patternIsSemanticFriendly(pattern);
  let queryEmbedding: number[] | null = null;
  let sidecar: Record<string, number[]> | null | undefined = deps.sidecar;
  let index = sidecar === undefined
    ? (enabled && semanticFriendly
      ? loadNodeEmbeddingIndex(loaded.baseDir, loaded.snapshotSha256)
      : null)
    : null;
  let lexicalReason: "disabled" | "no-sidecar" | "embed-timeout" | undefined;
  if (!enabled) lexicalReason = "disabled";
  else if (semanticFriendly) {
    const hasVectors = sidecar !== undefined ? Boolean(sidecar) : Boolean(index);
    if (!hasVectors) lexicalReason = "no-sidecar";
    else {
      const embed = deps.embedQuery ?? defaultQueryEmbedder();
      queryEmbedding = await embedQueryWithTimeout(pattern, embed);
      if (!queryEmbedding) lexicalReason = "embed-timeout";
    }
  }
  try {
    const lexical = findMatches(loaded.snap, pattern);
    const matches = hybridFindNodes(loaded.snap, pattern, {
      queryEmbedding,
      sidecar: sidecar === undefined ? null : sidecar,
      index,
    });
    const hybrid = Boolean(queryEmbedding && (index || sidecar));
    return {
      kind: "ok",
      body: renderQuery(
        loaded.snap,
        pattern,
        loaded.baseDir,
        workTreeIdFor(cwd),
        matches,
        hybrid
          ? { kind: "hybrid", semanticAdded: Math.max(0, matches.length - lexical.length) }
          : { kind: "lexical", reason: lexicalReason },
      ),
    };
  } catch (e) {
    return { kind: "no-graph", message: `Failed to render graph view: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── Snapshot loading ───────────────────────────────────────────────────

interface LoadedSnapshot {
  kind: "loaded";
  snap: GraphSnapshot;
  baseDir: string;
  snapshotSha256: string;
}

function loadSnapshot(cwd: string): LoadedSnapshot | GraphVfsResult {
  let key: string;
  let baseDir: string;
  try {
    key = deriveProjectKey(cwd).key;
    baseDir = repoDir(key);
  } catch (e) {
    return { kind: "no-graph", message: `Cannot derive repo identity: ${e instanceof Error ? e.message : String(e)}` };
  }
  const wt = workTreeIdFor(cwd);
  const last = readLastBuild(baseDir, wt);
  if (last === null) {
    return {
      kind: "no-graph",
      message: "No local graph for this worktree yet. Run `memoree graph build` (or `memoree graph pull` if a teammate has built this commit).",
    };
  }
  // CodeRabbit P1: writeSnapshot persists non-git builds under
  // snapshot_sha256 (no commit context). Fall back to that so the VFS
  // is reachable for commitless builds — previously this branch bailed
  // out and the user got "No local graph" even right after a successful
  // build in a loose source directory.
  const fileBase = last.commit_sha ?? last.snapshot_sha256;
  const snapPath = join(baseDir, "snapshots", `${fileBase}.json`);
  if (!existsSync(snapPath)) {
    return { kind: "no-graph", message: `Snapshot file missing on disk: ${snapPath}` };
  }
  let snap: GraphSnapshot;
  try {
    snap = JSON.parse(readFileSync(snapPath, "utf8")) as GraphSnapshot;
  } catch (e) {
    return { kind: "no-graph", message: `Failed to parse snapshot: ${e instanceof Error ? e.message : String(e)}` };
  }
  // CodeRabbit P1: validate schema and wrap the renderer in try/catch.
  // A snapshot file can be syntactically valid JSON but structurally
  // wrong (e.g. truncated by a crash mid-write, or a Phase 1.5 file
  // read by Phase 1 code). The renderers all assume `nodes` and `links`
  // are arrays — without this guard a malformed payload would throw
  // through to the hook caller and surface as "RETRY REQUIRED" instead
  // of the documented best-effort no-graph response.
  if (!Array.isArray((snap as { nodes?: unknown }).nodes) ||
      !Array.isArray((snap as { links?: unknown }).links)) {
    return { kind: "no-graph", message: "Snapshot schema is invalid (missing nodes/links arrays)." };
  }
  return { kind: "loaded", snap, baseDir, snapshotSha256: last.snapshot_sha256 };
}

function loadSnapshotOrError(
  cwd: string,
  fn: (snap: GraphSnapshot, baseDir: string) => GraphVfsResult,
): GraphVfsResult {
  const loaded = loadSnapshot(cwd);
  if (loaded.kind !== "loaded") return loaded;
  try {
    return fn(loaded.snap, loaded.baseDir);
  } catch (e) {
    return { kind: "no-graph", message: `Failed to render graph view: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── Renderers ──────────────────────────────────────────────────────────

function dirListing(): string {
  return [
    "index.md",
    "find/",
    "query/",
    "show/",
    "impact/",
    "neighborhood/",
    "layers",
    "tour",
    "path/",
  ].join("\n");
}

function renderIndex(snap: GraphSnapshot, baseDir: string, cwd: string): string {
  const commit = snap.graph.commit_sha?.slice(0, 7) ?? "no-commit";
  const fullCommit = snap.graph.commit_sha ?? "no-commit";
  const totalNodes = snap.nodes.length;
  const totalEdges = snap.links.length;

  // File breakdown: top 8 files by node count
  const byFile: Record<string, number> = {};
  for (const n of snap.nodes) byFile[n.source_file] = (byFile[n.source_file] ?? 0) + 1;
  const topFiles = Object.entries(byFile)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8);

  // Edge kind breakdown
  const byRel: Record<string, number> = {};
  for (const e of snap.links) byRel[e.relation] = (byRel[e.relation] ?? 0) + 1;

  // Node kind breakdown
  const byKind: Record<string, number> = {};
  for (const n of snap.nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;

  const lines: string[] = [];
  lines.push(`# Code Graph — ${snap.observation.repo_project}`);
  lines.push("");
  lines.push(`Commit:  ${fullCommit}  (built ${snap.observation.ts})`);
  lines.push(`Branch:  ${snap.observation.branch ?? "(detached)"}`);
  lines.push(`Source:  ${join(baseDir, "snapshots", `${commit ? snap.graph.commit_sha : "?"}.json`)}`);
  lines.push("");
  lines.push(`Nodes:   ${totalNodes}    Edges: ${totalEdges}`);
  lines.push("");
  lines.push("## How to query");
  lines.push("  cat ~/.memoree/memory/graph/query/<pattern>");
  lines.push("    2-in-1: search + expand the top matches with their 1-hop");
  lines.push("    neighbors (callers/callees/imports/heritage). Start here.");
  lines.push("    Multi-token AND: query/<a>+<b> requires both tokens.");
  lines.push("");
  lines.push("  cat ~/.memoree/memory/graph/find/<pattern>");
  lines.push("    Case-insensitive substring match on node id + label.");
  lines.push("    Emits numbered handles [1] [2] ... saved for this worktree.");
  lines.push("");
  lines.push("  cat ~/.memoree/memory/graph/show/<handle-or-pattern>");
  lines.push("    <handle>: a digit from a prior `find/`/`query/` (e.g. 3).");
  lines.push("    <pattern>: a substring; resolves to a unique node if possible,");
  lines.push("               or shows candidates if ambiguous.");
  lines.push("    Output: node detail + 1-hop neighbors grouped by edge kind.");
  lines.push("");
  lines.push("  Also: neighborhood/<file> · layers · tour · path/<from>/<to>");
  lines.push("");
  lines.push("## Node kinds");
  for (const [k, n] of Object.entries(byKind).sort(([, a], [, b]) => b - a)) {
    lines.push(`  ${k.padEnd(12)} ${n}`);
  }
  lines.push("");
  lines.push("## Edge kinds");
  for (const [k, n] of Object.entries(byRel).sort(([, a], [, b]) => b - a)) {
    lines.push(`  ${k.padEnd(12)} ${n}`);
  }
  lines.push("");
  lines.push("## Top files by node count");
  for (const [f, n] of topFiles) {
    lines.push(`  ${String(n).padStart(4)}  ${f}`);
  }
  lines.push("");
  lines.push(`Limitations:`);
  lines.push(`  - TypeScript / JavaScript / Python. AST-based, no semantic similarity edges yet.`);
  lines.push(`  - Cross-file 'calls'/'imports'/'extends' ARE resolved for relative named/namespace`);
  lines.push(`    imports; bare (npm)/aliased/barrel/dynamic imports stay unresolved. So a node`);
  lines.push(`    with "Incoming (0)" is not proof of dead code — a caller may reach it via an`);
  lines.push(`    unresolved import path. (Python cross-file resolution is a follow-up; Python is`);
  lines.push(`    intra-file + structure only for now.)`);
  lines.push(`  - Stale after edits — if a file's mtime is newer than the build, read the live source.`);
  // Touch `cwd` so unused-param lint is quiet (we don't use cwd in render but the
  // caller wires it for symmetry with the find/show paths).
  void cwd;
  return lines.join("\n");
}

function renderFind(snap: GraphSnapshot, pattern: string, baseDir: string, worktreeId: string): string {
  // Caps at 50 results to keep output short.
  const matches = findMatches(snap, pattern);
  const capped = matches.slice(0, 50);

  if (capped.length === 0) {
    return `No matches for "${pattern}" in ${snap.nodes.length} nodes.\nTry a shorter or different substring.`;
  }

  // Persist handle table for this find. Indices are 1-based.
  saveHandles(baseDir, worktreeId, capped.map((n) => n.id), pattern);

  const lines: string[] = [];
  lines.push(`${matches.length} match${matches.length === 1 ? "" : "es"} for "${pattern}"${matches.length > capped.length ? ` (showing first ${capped.length})` : ""}:`);
  lines.push("");
  for (let i = 0; i < capped.length; i++) {
    const n = capped[i]!;
    const tag = n.exported ? "exported" : "internal";
    lines.push(`  [${i + 1}]  ${n.id}   ${n.kind} (${tag})`);
  }
  lines.push("");
  lines.push("Use: cat ~/.memoree/memory/graph/show/<N> to see node + 1-hop neighbors");
  return lines.join("\n");
}

/** Max matches expanded by query/ in one shot. */
const QUERY_TOP_N = 5;
/** Max neighbors shown per relation per match. */
const QUERY_NEIGHBOR_CAP = 8;

/**
 * query/<pattern> — the 2-in-1: find + show in a single read. Searches like
 * find/, takes the top matches, and expands each with its 1-hop neighborhood
 * (callers/callees/imports/heritage) grouped by relation. Saves handles so a
 * follow-up show/<N> works exactly like after find/. Optional `matches`
 * lets the async hybrid path pass a lexical∪semantic list.
 */
type QuerySearchMode =
  | { kind: "lexical"; reason?: "sync" | "disabled" | "no-sidecar" | "embed-timeout" }
  | { kind: "hybrid"; semanticAdded: number };

function queryModeSuffix(mode?: QuerySearchMode): string {
  if (!mode || mode.kind === "lexical") {
    if (mode?.reason === "no-sidecar") return " · lexical only (no sidecar)";
    if (mode?.reason === "embed-timeout") return " · lexical only (embed timeout)";
    if (mode?.reason === "disabled") return " · lexical only (embeddings off)";
    return " · lexical only";
  }
  return ` · lexical+semantic (+${mode.semanticAdded} semantic)`;
}

function renderQuery(
  snap: GraphSnapshot,
  pattern: string,
  baseDir: string,
  worktreeId: string,
  matches: GraphNode[] = findMatches(snap, pattern),
  mode?: QuerySearchMode,
): string {
  if (matches.length === 0) {
    return `No matches for "${pattern}" in ${snap.nodes.length} nodes.${queryModeSuffix(mode)}\nTry a shorter or different substring, or cat memory/graph/find/<pattern>.`;
  }
  const top = matches.slice(0, QUERY_TOP_N);
  saveHandles(baseDir, worktreeId, top.map((n) => n.id), pattern);

  // Single pass over links: collect incoming/outgoing for the top node ids.
  const topIds = new Set(top.map((n) => n.id));
  const outByNode = new Map<string, GraphEdge[]>();
  const inByNode = new Map<string, GraphEdge[]>();
  for (const e of snap.links) {
    if (topIds.has(e.source)) (outByNode.get(e.source) ?? setGet(outByNode, e.source)).push(e);
    if (topIds.has(e.target)) (inByNode.get(e.target) ?? setGet(inByNode, e.target)).push(e);
  }

  const lines: string[] = [];
  lines.push(`Query "${pattern}" — ${matches.length} match${matches.length === 1 ? "" : "es"}, expanded top ${top.length} (1 hop)${queryModeSuffix(mode)}`);
  lines.push("");

  for (let i = 0; i < top.length; i++) {
    const n = top[i]!;
    const tags = [n.exported ? "exported" : "internal"];
    if (n.is_entrypoint) tags.push("entrypoint");
    if (n.fan_in !== undefined) tags.push(`fan_in=${n.fan_in}`);
    if (n.fan_out !== undefined) tags.push(`fan_out=${n.fan_out}`);
    lines.push(`[${i + 1}] ${n.id}  ${n.kind} (${tags.join(", ")})`);
    if (n.signature) lines.push(`      ${n.signature}`);
    renderHopGroup(lines, outByNode.get(n.id) ?? [], "OUT", "target");
    renderHopGroup(lines, inByNode.get(n.id) ?? [], "IN", "source");
    lines.push("");
  }
  lines.push("Use: cat ~/.memoree/memory/graph/show/<N> for full detail on a match.");
  return lines.join("\n");
}

function setGet(m: Map<string, GraphEdge[]>, key: string): GraphEdge[] {
  const list: GraphEdge[] = [];
  m.set(key, list);
  return list;
}

/** Render one direction's edges grouped by relation, bounded. */
function renderHopGroup(lines: string[], edges: GraphEdge[], dir: "IN" | "OUT", otherField: "source" | "target"): void {
  if (edges.length === 0) return;
  // Per relation, DEDUP the other endpoint and keep a count — a function that
  // calls errorOutcome() 3 times should read `errorOutcome ×3`, not list it
  // three times (multigraph edges; live-test polish).
  const byRel = new Map<string, Map<string, number>>();
  for (const e of edges) {
    let counts = byRel.get(e.relation);
    if (!counts) { counts = new Map(); byRel.set(e.relation, counts); }
    const id = e[otherField];
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [rel, counts] of [...byRel.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const arrow = dir === "OUT" ? `--${rel}-->` : `<--${rel}--`;
    const ids = [...counts.keys()].sort();
    const shown = ids.slice(0, QUERY_NEIGHBOR_CAP).map((id) => {
      const c = counts.get(id)!;
      return c > 1 ? `${id} ×${c}` : id;
    });
    const more = ids.length > shown.length ? `  (+${ids.length - shown.length} more)` : "";
    lines.push(`      ${arrow} ${shown.join(", ")}${more}`);
  }
}

function renderShow(snap: GraphSnapshot, key: string, baseDir: string, worktreeId: string): string {
  // 1. Digit → resolve via handle map from last find.
  if (/^\d+$/.test(key)) {
    const idx = parseInt(key, 10);
    const handles = loadHandles(baseDir, worktreeId);
    if (handles === null) {
      return `Handle [${idx}] not resolvable: no recent find/ in this worktree. Run cat memory/graph/find/<pattern> first.`;
    }
    if (idx < 1 || idx > handles.ids.length) {
      return `Handle [${idx}] out of range. Last find/${handles.pattern} produced ${handles.ids.length} matches.`;
    }
    const nodeId = handles.ids[idx - 1]!;
    const node = snap.nodes.find((n) => n.id === nodeId);
    if (!node) {
      return `Handle [${idx}] points at "${nodeId}" but that node is no longer in the snapshot (graph rebuilt since last find?). Re-run find.`;
    }
    return renderNodeDetail(snap, node);
  }

  // 2. Pattern → unique match? Show. Multiple? Disambiguation.
  const needle = key.toLowerCase();
  const matches = snap.nodes.filter((n) => n.id.toLowerCase().includes(needle));
  if (matches.length === 0) {
    return `No node matches "${key}". Try cat memory/graph/find/${key} for fuzzy search.`;
  }
  if (matches.length === 1) {
    return renderNodeDetail(snap, matches[0]!);
  }
  // Save these as handles too — agent can drill via show/N
  saveHandles(baseDir, worktreeId, matches.slice(0, 50).map((n) => n.id), key);
  const lines: string[] = [];
  lines.push(`"${key}" matches ${matches.length} nodes. Pick one:`);
  lines.push("");
  for (let i = 0; i < Math.min(matches.length, 50); i++) {
    lines.push(`  [${i + 1}]  ${matches[i]!.id}`);
  }
  lines.push("");
  lines.push("Use: cat ~/.memoree/memory/graph/show/<N>");
  return lines.join("\n");
}

function renderNodeDetail(snap: GraphSnapshot, node: GraphNode): string {
  const incoming: GraphEdge[] = [];
  const outgoing: GraphEdge[] = [];
  for (const e of snap.links) {
    if (e.target === node.id) incoming.push(e);
    if (e.source === node.id) outgoing.push(e);
  }
  const groupBy = (es: GraphEdge[]): Map<string, GraphEdge[]> => {
    const m = new Map<string, GraphEdge[]>();
    for (const e of es) {
      const list = m.get(e.relation) ?? [];
      list.push(e);
      m.set(e.relation, list);
    }
    return m;
  };
  const inGrp = groupBy(incoming);
  const outGrp = groupBy(outgoing);

  const lines: string[] = [];
  lines.push(`Node: ${node.id}`);
  lines.push(`  source: ${node.source_file}:${node.source_location}`);
  lines.push(`  kind:   ${node.kind}`);
  lines.push(`  label:  ${node.label}`);
  if (node.signature) lines.push(`  sig:    ${node.signature}`);
  if (node.doc) lines.push(`  doc:    ${node.doc}`);
  // B4 metadata — printed only when present (older snapshots omit them).
  const tags = [node.exported ? "exported" : "internal"];
  if (node.is_entrypoint) tags.push("entrypoint");
  if (node.fan_in !== undefined) tags.push(`fan_in=${node.fan_in}`);
  if (node.fan_out !== undefined) tags.push(`fan_out=${node.fan_out}`);
  lines.push(`  ${tags.join("  ")}`);
  lines.push("");
  // Honest caveat: cross-file `calls` are resolved for relative NAMED/namespace
  // imports, but NOT for bare (npm) / aliased / barrel / dynamic imports. So
  // "Incoming (0)" is not proof of dead code — a caller may reach this symbol
  // through an unresolved import path.
  const inHint = incoming.length === 0
    ? "  — no resolved callers (cross-file resolution is partial; not proof of dead code)"
    : ":";
  lines.push(`Incoming (${incoming.length})${inHint}`);
  for (const [rel, es] of [...inGrp.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${rel} (${es.length}):`);
    for (const e of es.slice(0, 20)) {
      lines.push(`    ${e.source}`);
    }
    if (es.length > 20) lines.push(`    ... and ${es.length - 20} more`);
  }
  lines.push("");
  lines.push(`Outgoing (${outgoing.length})${outgoing.length === 0 ? "  — this node has no edges out" : ":"}`);
  for (const [rel, es] of [...outGrp.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${rel} (${es.length}):`);
    for (const e of es.slice(0, 20)) {
      lines.push(`    ${e.target}`);
    }
    if (es.length > 20) lines.push(`    ... and ${es.length - 20} more`);
  }
  return lines.join("\n");
}

// ── Handle map persistence ─────────────────────────────────────────────

interface HandleMap {
  pattern: string;
  ts: number;
  ids: string[];
}

function handlesPath(baseDir: string, worktreeId: string): string {
  return join(baseDir, "worktrees", worktreeId, ".find-handles.json");
}

function saveHandles(baseDir: string, worktreeId: string, ids: string[], pattern: string): void {
  const path = handlesPath(baseDir, worktreeId);
  const payload: HandleMap = { pattern, ts: Date.now(), ids };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(payload));
    renameSync(tmp, path);
  } catch {
    // best-effort: a handle-map write failure means show/<N> won't work
    // until the next find/, but doesn't break find/ itself.
  }
}

function loadHandles(baseDir: string, worktreeId: string): HandleMap | null {
  const path = handlesPath(baseDir, worktreeId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const o = parsed as Partial<HandleMap>;
    if (typeof o.pattern !== "string") return null;
    if (typeof o.ts !== "number") return null;
    if (!Array.isArray(o.ids)) return null;
    if (!o.ids.every((s) => typeof s === "string")) return null;
    return { pattern: o.pattern, ts: o.ts, ids: o.ids };
  } catch {
    return null;
  }
}
