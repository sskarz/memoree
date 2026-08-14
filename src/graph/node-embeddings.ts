/**
 * Per-snapshot node embedding sidecar.
 *
 * Vectors MUST NOT live in GraphSnapshot JSON: snapshot_sha256 hashes the
 * NetworkX-shaped payload (nodes/links/graph) and excludes observation.
 * Putting embeddings in the snapshot would churn the content hash and
 * break NetworkX consumers.
 *
 * Layout (next to the per-repo AST cache):
 *   ~/.memoree/graphs/<repo>/.cache/node-embeddings/<snapshot_sha256>.json
 *     { schema, snapshot_sha256, vectors: { node_id: float[] } }
 *   ~/.memoree/graphs/<repo>/.cache/node-embed-vectors/<text_sha256>.json
 *     { schema, content_sha256, vector: float[] }
 *
 * The text-hash cache is the same trick as the per-file AST cache: unchanged
 * symbol documents skip the daemon on rebuild. Missing sidecar → lexical query/.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fileContentHash } from "./cache.js";
import type { GraphNode, GraphSnapshot } from "./types.js";
import { EmbedClient } from "../embeddings/client.js";
import { embeddingsDisabled } from "../embeddings/disable.js";

export const NODE_EMBED_SCHEMA = 1;

export type NodeEmbedder = (text: string) => Promise<number[] | null>;
export type NodeBatchEmbedder = (texts: string[]) => Promise<Array<number[] | null>>;

export interface NodeEmbeddingSidecar {
  schema: number;
  snapshot_sha256: string;
  vectors: Record<string, number[]>;
}

export interface WriteNodeEmbeddingsResult {
  written: boolean;
  embedded: number;
  cached: number;
}

export interface WriteNodeEmbeddingsDeps {
  /** Override the per-text embedder (tests). Production uses embed_batch. */
  embed?: NodeEmbedder;
  /** Override the batch embedder (tests). */
  embedBatch?: NodeBatchEmbedder;
  /** When false, skip entirely. Defaults to !embeddingsDisabled(). */
  enabled?: boolean;
}

/**
 * Chunk size for one daemon embed_batch / transformer forward pass.
 *
 * nomic-embed-text-v1.5 + transformers.js FeatureExtractionPipeline both
 * accept `string[]` (tokenizer padding=true, truncation=true). There is no
 * model-card max batch size; cost is pad-to-longest × batch. Graph node
 * documents are short (kind/label/signature/doc/file), so 32 stays well
 * under the 2048 native RoPE window. 128 is the daemon wire cap, not a
 * target here.
 */
export const NODE_EMBED_BATCH_SIZE = 32;
/** Build path is not a hook hot path — wait for a cold model + a full batch. */
export const NODE_EMBED_TIMEOUT_MS = 30_000;

/** Short document embedded per node: kind, label, signature, doc, source_file. */
export function nodeEmbedText(n: GraphNode): string {
  return [n.kind, n.label, n.signature ?? "", n.doc ?? "", n.source_file]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function nodeEmbeddingSidecarPath(baseDir: string, snapshotSha256: string): string {
  return join(baseDir, ".cache", "node-embeddings", `${snapshotSha256}.json`);
}

export function nodeVectorCachePath(baseDir: string, textSha256: string): string {
  return join(baseDir, ".cache", "node-embed-vectors", `${textSha256}.json`);
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

function isFiniteVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

export function readCachedNodeVector(baseDir: string, textSha256: string): number[] | null {
  const path = nodeVectorCachePath(baseDir, textSha256);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      schema?: number;
      content_sha256?: string;
      vector?: unknown;
    };
    if (parsed.schema !== NODE_EMBED_SCHEMA) return null;
    if (parsed.content_sha256 !== textSha256) return null;
    return isFiniteVector(parsed.vector) ? parsed.vector : null;
  } catch {
    return null;
  }
}

export function writeCachedNodeVector(baseDir: string, textSha256: string, vector: number[]): void {
  try {
    atomicWriteJson(nodeVectorCachePath(baseDir, textSha256), {
      schema: NODE_EMBED_SCHEMA,
      content_sha256: textSha256,
      vector,
    });
  } catch {
    // Cache writes are best-effort.
  }
}

/**
 * Load the sidecar for a snapshot. Returns null when missing, corrupt, or
 * schema-mismatched so query/ can fall back to lexical search.
 */
export function readNodeEmbeddings(baseDir: string, snapshotSha256: string): Record<string, number[]> | null {
  const path = nodeEmbeddingSidecarPath(baseDir, snapshotSha256);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<NodeEmbeddingSidecar>;
    if (parsed.schema !== NODE_EMBED_SCHEMA) return null;
    if (parsed.snapshot_sha256 !== snapshotSha256) return null;
    if (parsed.vectors === null || typeof parsed.vectors !== "object" || Array.isArray(parsed.vectors)) {
      return null;
    }
    const vectors: Record<string, number[]> = {};
    for (const [id, vec] of Object.entries(parsed.vectors)) {
      if (typeof id === "string" && isFiniteVector(vec)) vectors[id] = vec;
    }
    return Object.keys(vectors).length > 0 ? vectors : null;
  } catch {
    return null;
  }
}

function defaultNodeBatchEmbedder(): NodeBatchEmbedder {
  if (embeddingsDisabled()) return async (texts) => texts.map(() => null);
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "..", "embeddings", "embed-daemon.js");
  const client = new EmbedClient(
    existsSync(bundled)
      ? { daemonEntry: bundled, timeoutMs: NODE_EMBED_TIMEOUT_MS }
      : { timeoutMs: NODE_EMBED_TIMEOUT_MS },
  );
  let warmed: Promise<boolean> | null = null;
  return async (texts: string[]) => {
    try {
      warmed ??= client.warmup();
      await warmed;
      const rows = await client.embedBatch(texts, "document");
      return rows.map((v) => (v && v.length > 0 ? v : null));
    } catch {
      return texts.map(() => null);
    }
  };
}

function sequentialBatch(embed: NodeEmbedder): NodeBatchEmbedder {
  return async (texts) => {
    const out: Array<number[] | null> = [];
    for (const text of texts) {
      try {
        const vector = await embed(text);
        out.push(vector && vector.length > 0 ? vector : null);
      } catch {
        out.push(null);
      }
    }
    return out;
  };
}

/**
 * Embed every node after writeSnapshot. Best-effort: daemon failure leaves
 * no sidecar and query/ stays lexical. Cached by text hash so a rebuild of
 * identical symbols does not call embed again. Uncached texts go to the
 * daemon in chunks of NODE_EMBED_BATCH_SIZE (one forward pass each).
 */
export async function writeNodeEmbeddings(
  snapshot: GraphSnapshot,
  baseDir: string,
  snapshotSha256: string,
  deps: WriteNodeEmbeddingsDeps = {},
): Promise<WriteNodeEmbeddingsResult> {
  const enabled = deps.enabled ?? !embeddingsDisabled();
  if (!enabled) return { written: false, embedded: 0, cached: 0 };

  const embedBatch = deps.embedBatch
    ?? (deps.embed ? sequentialBatch(deps.embed) : defaultNodeBatchEmbedder());
  const vectors: Record<string, number[]> = {};
  let embedded = 0;
  let cached = 0;

  type Pending = { id: string; text: string; hash: string };
  const pending: Pending[] = [];
  const hashToVector = new Map<string, number[]>();

  for (const node of snapshot.nodes) {
    const text = nodeEmbedText(node);
    if (text.length === 0) continue;
    const hash = fileContentHash(text);
    const fromThisBuild = hashToVector.get(hash);
    const vector = fromThisBuild ?? readCachedNodeVector(baseDir, hash);
    if (vector) {
      hashToVector.set(hash, vector);
      vectors[node.id] = vector;
      cached += 1;
      continue;
    }
    pending.push({ id: node.id, text, hash });
  }

  const unique: Array<{ text: string; hash: string; ids: string[] }> = [];
  const hashIndex = new Map<string, number>();
  for (const item of pending) {
    const existing = hashIndex.get(item.hash);
    if (existing !== undefined) {
      unique[existing]!.ids.push(item.id);
      continue;
    }
    hashIndex.set(item.hash, unique.length);
    unique.push({ text: item.text, hash: item.hash, ids: [item.id] });
  }

  const productionDaemon = deps.embed === undefined && deps.embedBatch === undefined;
  for (let i = 0; i < unique.length; i += NODE_EMBED_BATCH_SIZE) {
    const chunk = unique.slice(i, i + NODE_EMBED_BATCH_SIZE);
    let rows: Array<number[] | null>;
    try {
      rows = await embedBatch(chunk.map((c) => c.text));
    } catch {
      rows = chunk.map(() => null);
    }
    let anyOk = false;
    for (let j = 0; j < chunk.length; j++) {
      const item = chunk[j]!;
      const vector = rows[j];
      if (!vector || vector.length === 0) continue;
      anyOk = true;
      writeCachedNodeVector(baseDir, item.hash, vector);
      hashToVector.set(item.hash, vector);
      embedded += 1;
      cached += item.ids.length - 1;
      for (const id of item.ids) vectors[id] = vector;
    }
    // Default daemon path: an all-null batch means the daemon is down —
    // don't wait on every remaining chunk. Injected embedders keep going.
    if (!anyOk && productionDaemon) break;
  }

  if (Object.keys(vectors).length === 0) {
    return { written: false, embedded, cached };
  }

  try {
    atomicWriteJson(nodeEmbeddingSidecarPath(baseDir, snapshotSha256), {
      schema: NODE_EMBED_SCHEMA,
      snapshot_sha256: snapshotSha256,
      vectors,
    } satisfies NodeEmbeddingSidecar);
    return { written: true, embedded, cached };
  } catch {
    return { written: false, embedded, cached };
  }
}
