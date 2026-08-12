#!/usr/bin/env node

/**
 * Codex SessionStart async setup hook:
 * Runs local storage operations (table creation and placeholder creation)
 * in the background so they don't block session startup.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { loadConfig } from "../../config.js";
import { resolveDirConfig } from "../../dir-config.js";
import { createStorageBackend } from "../../storage/factory.js";
import type { StorageBackend } from "../../storage/backend.js";
import { readStdin } from "../../utils/stdin.js";
import { createPlaceholderSummary } from "../shared/placeholder-summary.js";
import { log as _log } from "../../utils/debug.js";
import { makeWikiLogger } from "../../utils/wiki-log.js";
import { getInstalledVersion } from "../../utils/version-check.js";
import { spawnDetachedNodeWorker } from "../../utils/spawn-detached.js";
const log = (msg: string) => _log("codex-session-setup", msg);

const { log: wikiLog } = makeWikiLogger(join(homedir(), ".codex", "hooks"));

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const PLUGIN_VERSION = getInstalledVersion(__bundleDir, ".codex-plugin") ?? "";

/** Create a placeholder summary via the shared race-safe writer (see placeholder-summary.ts). */
async function createPlaceholder(api: StorageBackend, table: string, sessionId: string, cwd: string, userName: string, orgName: string, workspaceId: string): Promise<void> {
  await createPlaceholderSummary(
    (sql) => api.query(sql),
    { table, sessionId, cwd, userName, orgName, workspaceId, agent: "codex", pluginVersion: PLUGIN_VERSION, dialect: api.dialect },
    wikiLog,
  );
}

interface CodexSessionStartInput {
  session_id: string;
  transcript_path?: string | null;
  cwd: string;
  hook_event_name: string;
  model: string;
  source?: string;
}

async function main(): Promise<void> {
  if (process.env.MEMOREE_WIKI_WORKER === "1") return;

  const input = await readStdin<CodexSessionStartInput>();

  // Provision the code-graph tree-sitter parsers into the shared embed-deps
  // dir so the graph-on-stop hook can auto-build the graph. Spawned as a
  // DETACHED worker — NOT run inline — because a cold provision runs npm +
  // a from-source native compile that can exceed this hook's ~120s async
  // timeout; the worker outlives the hook and finishes in the background.
  // Provisioning is purely local and does not depend on authentication.
  // Best-effort — the spawn helper swallows any
  // failure, and ensureGraphDeps inside the worker serializes via its own lock.
  spawnDetachedNodeWorker(join(__bundleDir, "graph-deps-worker.js"));
  const baseStorageConfig = loadConfig();
  if (!baseStorageConfig) { log("no storage configuration"); return; }

  // Table setup + sync — always sync, only skip placeholder when capture disabled
  const captureEnabled = process.env.MEMOREE_CAPTURE !== "false";
  if (input.session_id) {
    try {
      const base = baseStorageConfig;
      if (base) {
        const dirRes = resolveDirConfig(base, input.cwd ?? process.cwd());
        const config = dirRes.config;
        if (captureEnabled && dirRes.collect) {
          const api = createStorageBackend(config, config.tableName);
          await api.ensureTable();
          await api.ensureSessionsTable(config.sessionsTableName);
          await createPlaceholder(api, config.tableName, input.session_id, input.cwd ?? "", config.userName, config.orgName, config.workspaceId);
          log("setup complete");
        } else {
          log(!dirRes.collect
            ? `setup skipped — .memoree collect:false (${dirRes.found?.path})`
            : "setup skipped — MEMOREE_CAPTURE=false");
        }
      }
    } catch (e: any) {
      log(`setup failed: ${e.message}`);
      wikiLog(`SessionSetup: failed for ${input.session_id}: ${e.message}`);
    }
  }
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
