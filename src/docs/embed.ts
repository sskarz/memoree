/**
 * Doc-content embedder — the search vector for `content_embedding`.
 *
 * Mirrors the capture-hook pattern (src/hooks/capture.ts): one nomic embedding
 * per doc via the shared daemon, `document` kind (applies DOC_PREFIX). Reuses a
 * single `EmbedClient` across a bulk generate run. Best-effort and null-safe —
 * disabled embeddings or any daemon failure yield `null`, which lands as a NULL
 * `content_embedding` (lexical `docs/find/` still works; semantic is guarded by
 * `ARRAY_LENGTH(content_embedding,1) > 0`). NEVER blocks or fails a doc write.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EmbedClient } from "../embeddings/client.js";
import { embeddingsDisabled } from "../embeddings/disable.js";

/** A best-effort text → vector function; returns null when unavailable. */
export type DocEmbedder = (text: string) => Promise<number[] | null>;

function embedClient(): EmbedClient {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "embeddings", "embed-daemon.js");
  // Agent harnesses ship a daemon beside their bundle. The standalone CLI
  // does not, so omitting the explicit path lets EmbedClient select the
  // canonical ~/.memoree/embed-deps/embed-daemon.js installed at onboarding.
  return new EmbedClient(existsSync(bundled) ? { daemonEntry: bundled } : {});
}

/**
 * Build a reusable doc embedder. When embeddings are globally disabled, returns
 * a no-op that always yields null (no daemon round-trip). Otherwise reuses one
 * `EmbedClient` and swallows failures to null.
 */
export function makeDocEmbedder(): DocEmbedder {
  if (embeddingsDisabled()) return async () => null;
  const client = embedClient();
  let warmup: Promise<boolean> | null = null;
  return async (text: string) => {
    try {
      // Document generation/backfill is a batch path, so wait for a cold
      // daemon instead of accepting EmbedClient's hot-hook behavior (return
      // null while spawning in the background). Share one warmup across the
      // whole batch and retry once if startup was still settling.
      warmup ??= client.warmup();
      await warmup;
      let vector = await client.embed(text, "document");
      if (vector && vector.length > 0) return vector;
      vector = await client.embed(text, "document");
      return vector && vector.length > 0 ? vector : null;
    } catch {
      return null;
    }
  };
}

/**
 * Query-side embedder for `docs/find/` (kind='query' → QUERY_PREFIX, the nomic
 * asymmetric search convention). Null when embeddings are disabled/unreachable
 * → `docs/find/` degrades to lexical search.
 */
export function makeQueryEmbedder(): DocEmbedder {
  if (embeddingsDisabled()) return async () => null;
  const client = embedClient();
  return async (text: string) => {
    try {
      return await client.embed(text, "query");
    } catch {
      return null;
    }
  };
}
