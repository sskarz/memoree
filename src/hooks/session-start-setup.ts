#!/usr/bin/env node

/**
 * SessionStart async setup hook:
 * Runs local storage operations (table creation and embedding warmup)
 * in the background so they don't block session startup.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { loadRoutedConfig } from "../dir-config.js";
import { createStorageBackend } from "../storage/factory.js";
import { readStdin } from "../utils/stdin.js";
import { log as _log } from "../utils/debug.js";
import { makeWikiLogger } from "../utils/wiki-log.js";
import { EmbedClient } from "../embeddings/client.js";
import { embeddingsDisabled, embeddingsStatus } from "../embeddings/disable.js";
import { spawnDetachedNodeWorker } from "../utils/spawn-detached.js";
const log = (msg: string) => _log("session-setup", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const { log: wikiLog } = makeWikiLogger(join(homedir(), ".claude", "hooks"));

interface SessionStartInput {
  session_id: string;
  cwd?: string;
}

async function main(): Promise<void> {
  if (process.env.MEMOREE_WIKI_WORKER === "1") return;

  const input = await readStdin<SessionStartInput>();

  // Provision the code-graph tree-sitter parsers into the shared embed-deps
  // dir so the graph-on-stop hook can auto-build the graph. Spawned as a
  // DETACHED worker — NOT run inline — because a cold provision runs npm +
  // a from-source native compile that can exceed this hook's ~120s async
  // timeout; the worker outlives the hook and finishes in the background.
  // Provisioning is purely local and does not depend on authentication.
  // Best-effort — the spawn helper swallows any
  // failure, and ensureGraphDeps inside the worker serializes via its own lock.
  spawnDetachedNodeWorker(join(__bundleDir, "graph-deps-worker.js"));
  const storageConfig = loadRoutedConfig(input.cwd ?? process.cwd());
  if (!storageConfig) { log("no storage configuration"); return; }

  if (input.session_id) {
    try {
      const config = storageConfig;
      if (config) {
        const api = createStorageBackend(config, config.tableName);
        await api.ensureTable();
        await api.ensureSessionsTable(config.sessionsTableName);
        log("setup complete");
      }
    } catch (e: any) {
      log(`setup failed: ${e.message}`);
      wikiLog(`SessionSetup: failed for ${input.session_id}: ${e.message}`);
    }
  }

  // Warm up the embedding daemon so the nomic-embed-text-v1.5 model is
  // cached and loaded before the first Grep call. The daemon eagerly
  // calls `embedder.load()` on startup (fire-and-forget), which downloads
  // the model to ~/.memoree/models/ on first run (~130 MB q8 /
  // ~500 MB fp32) and keeps it resident for the lifetime of the process.
  // `warmup()` itself just ensures the socket is accepting connections;
  // the actual model download runs in the daemon's background — so this
  // hook stays quick even on a cold install. Opt-out via
  // MEMOREE_EMBED_WARMUP=false for sessions that will never touch the
  // memory path (lightweight CC runs, no-network CI).
  if (embeddingsDisabled()) {
    const status = embeddingsStatus();
    const reason = status === "no-transformers"
      ? "@huggingface/transformers not installed (run `memoree embeddings install` to enable)"
      : "embeddings disabled in ~/.memoree/config.json (run `memoree embeddings enable` to opt in)";
    log(`embed daemon warmup skipped: ${reason}`);
  } else if (process.env.MEMOREE_EMBED_WARMUP !== "false") {
    try {
      const daemonEntry = join(__bundleDir, "embeddings", "embed-daemon.js");
      const client = new EmbedClient({ daemonEntry, timeoutMs: 300, spawnWaitMs: 5000 });
      const ok = await client.warmup();
      log(`embed daemon warmup: ${ok ? "ok" : "failed"}`);
    } catch (e: any) {
      log(`embed daemon warmup threw: ${e.message}`);
    }
  } else {
    log("embed daemon warmup skipped via MEMOREE_EMBED_WARMUP=false");
  }
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
