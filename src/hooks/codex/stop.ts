#!/usr/bin/env node

/**
 * Codex Stop hook — captures the turn and may spawn a session summary.
 *
 * Codex SessionEnd now exists but is advisory and capped at 3s, so Stop keeps
 * the historical wiki spawn. SessionEnd also spawns under the same per-session
 * lock, so a turn that already summarized will not double-write.
 *
 * 1. Captures the stop event to the sessions table (like Claude capture.ts)
 * 2. Spawns the wiki worker to generate the session summary (like session-end.ts)
 *
 * Codex input:  { session_id, transcript_path, cwd, hook_event_name, model,
 *                 last_assistant_message? }
 * Codex output: JSON with optional { decision: "block", reason: "..." } to continue
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readStdin } from "../../utils/stdin.js";
import { loadConfig } from "../../config.js";
import { resolveDirConfig } from "../../dir-config.js";
import { createStorageBackend } from "../../storage/factory.js";
import { projectNameFromCwd } from "../../utils/project-name.js";
import { deriveProjectKey } from "../../utils/repo-identity.js";
import { log as _log } from "../../utils/debug.js";
import { bundleDirFromImportMeta, spawnCodexWikiWorker, wikiLog } from "./spawn-wiki-worker.js";
import { forceSessionEndTrigger } from "../../skillify/triggers.js";
import { tryAcquireLock, releaseLock } from "../summary-state.js";
import { buildSessionPath } from "../../utils/session-path.js";
import { EmbedClient } from "../../embeddings/client.js";
import { embeddingSqlLiteral } from "../../embeddings/sql.js";
import { embeddingsDisabled } from "../../embeddings/disable.js";
import { buildDirectSessionInsertSql } from "../shared/session-insert-sql.js";
import { getInstalledVersion } from "../../utils/version-check.js";
import { resolveCodexAssistantMessage } from "./transcript.js";

const log = (msg: string) => _log("codex-stop", msg);

function resolveEmbedDaemonPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "embeddings", "embed-daemon.js");
}

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const PLUGIN_VERSION = getInstalledVersion(__bundleDir, ".codex-plugin") ?? "";

interface CodexStopInput {
  session_id: string;
  transcript_path?: string | null;
  cwd: string;
  hook_event_name: string;
  model: string;
  last_assistant_message?: string | null;
}

const CAPTURE = process.env.MEMOREE_CAPTURE !== "false";

async function main(): Promise<void> {
  if (process.env.MEMOREE_WIKI_WORKER === "1") return;

  const input = await readStdin<CodexStopInput>();
  const sessionId = input.session_id;
  if (!sessionId) return;

  const base = loadConfig();
  if (!base) { log("no config"); return; }
  const dirRes = resolveDirConfig(base, input.cwd ?? process.cwd());
  if (!dirRes.collect) { log(`capture disabled for cwd=${input.cwd ?? "?"} via ${dirRes.found?.path}`); return; }
  const config = dirRes.config;

  // 1. Capture the stop event (try to extract last assistant message from transcript)
  if (CAPTURE) {
    try {
      const sessionsTable = config.sessionsTableName;
      const api = createStorageBackend(config, sessionsTable);
      const ts = new Date().toISOString();

      // Prefer last_assistant_message from the payload (Codex >= current
      // hooks schema). Fall back to parsing transcript_path JSONL.
      const lastAssistantMessage = resolveCodexAssistantMessage(input);
      if (lastAssistantMessage) log(`assistant message (${lastAssistantMessage.length} chars)`);

      const entry = {
        id: crypto.randomUUID(),
        session_id: sessionId,
        transcript_path: input.transcript_path,
        cwd: input.cwd,
        hook_event_name: input.hook_event_name,
        model: input.model,
        timestamp: ts,
        type: lastAssistantMessage ? "assistant_message" : "assistant_stop",
        content: lastAssistantMessage,
      };
      const line = JSON.stringify(entry);
      const sessionPath = buildSessionPath(config, sessionId);
      const projectName = projectNameFromCwd(input.cwd);
      const projectKey = deriveProjectKey(input.cwd || process.cwd()).key;
      const filename = sessionPath.split("/").pop() ?? "";
      // For JSONB: only escape single quotes for the SQL literal, keep JSON structure intact.
      // sqlStr() would also escape backslashes and strip control chars, corrupting the JSON.
      const jsonForSql = line.replace(/'/g, "''");

      // Best-effort embed: if the daemon is unavailable (no @huggingface/transformers
      // or MEMOREE_EMBEDDINGS=false), embed() returns null and the column lands NULL.
      const embedding = embeddingsDisabled()
        ? null
        : await new EmbedClient({ daemonEntry: resolveEmbedDaemonPath() }).embed(line, "document");
      const embeddingSql = embeddingSqlLiteral(embedding, api.dialect);

      const insertSql = buildDirectSessionInsertSql(sessionsTable, {
        // Reuse the event id already embedded in the message JSON so the row PK
        // matches the payload's id (and keeps the dedup key = the logical event).
        id: entry.id,
        sessionPath,
        filename,
        jsonForSql,
        embeddingSql,
        userName: config.userName,
        sizeBytes: Buffer.byteLength(line, "utf-8"),
        projectName,
        projectKey,
        description: "Stop",
        agent: "codex",
        pluginVersion: PLUGIN_VERSION,
        timestamp: ts,
      }, api.dialect);

      await api.query(insertSql);
      log("stop event captured");
    } catch (e: any) {
      log(`capture failed: ${e.message}`);
    }
  }

  // 2. Spawn wiki worker — skip when capture disabled
  if (!CAPTURE) return;

  // Coordinate with the periodic worker: if one is already running for this
  // session, skip. Two workers writing the same summary row trip the
  // SQL UPDATE-coalescing quirk (see CLAUDE.md) and drop one write.
  const cwd = input.cwd || process.cwd();

  // Skillify has its own per-project lock — fire before the wiki-worker lock
  // check so a Periodic trigger that already holds the lock doesn't suppress
  // skill mining.
  forceSessionEndTrigger({
    config,
    cwd,
    bundleDir: bundleDirFromImportMeta(import.meta.url),
    agent: "codex",
    sessionId,
  });

  if (!tryAcquireLock(sessionId)) {
    wikiLog(`Stop: periodic worker already running for ${sessionId}, skipping`);
    return;
  }

  wikiLog(`Stop: triggering summary for ${sessionId}`);
  try {
    spawnCodexWikiWorker({
      config,
      sessionId,
      cwd,
      bundleDir: bundleDirFromImportMeta(import.meta.url),
      reason: "Stop",
    });
  } catch (e: any) {
    // Spawn threw before the worker took ownership of the lock: release
    // it here so a --resume can retrigger periodic summaries without
    // waiting for the 10-minute stale reclaim.
    log(`spawn failed: ${e.message}`);
    try {
      releaseLock(sessionId);
    } catch (releaseErr: any) {
      log(`releaseLock after spawn failure also failed: ${releaseErr.message}`);
    }
    throw e;
  }
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
