#!/usr/bin/env node

/**
 * Codex SessionEnd hook — marks the session ended and spawns the wiki worker.
 *
 * Codex Stop still captures the turn and may spawn a summary (the historical
 * end-of-session path, because SessionEnd is advisory and capped at 3s).
 * This hook is the Claude SessionEnd equivalent: markSessionEnded, usage
 * recap, skillify, then a locked wiki spawn. Duplicate spawns are suppressed
 * by the per-session summary lock.
 *
 * Codex input:  { session_id, transcript_path, cwd, hook_event_name, reason }
 * Codex output: none (advisory; output does not steer Codex)
 */

import { readStdin } from "../../utils/stdin.js";
import { loadConfig } from "../../config.js";
import { resolveDirConfig } from "../../dir-config.js";
import { log as _log } from "../../utils/debug.js";
import { bundleDirFromImportMeta, spawnCodexWikiWorker, wikiLog } from "./spawn-wiki-worker.js";
import { tryAcquireLock, releaseLock, markSessionEnded } from "../summary-state.js";
import { pruneStaleSessionEventCaches } from "../session-event-cache.js";
import { forceSessionEndTrigger } from "../../skillify/triggers.js";
import { parseTranscript } from "../../notifications/transcript-parser.js";
import { appendUsageRecord } from "../../notifications/usage-tracker.js";
import { isMemoreePluginEnabled } from "../../utils/plugin-state.js";

const log = (msg: string) => _log("codex-session-end", msg);

interface CodexSessionEndInput {
  session_id: string;
  cwd?: string;
  hook_event_name?: string;
  transcript_path?: string | null;
  reason?: string;
}

function recordSessionUsage(transcriptPath: string | undefined, sessionId: string): void {
  if (!transcriptPath) return;
  try {
    const record = parseTranscript(transcriptPath, sessionId);
    if (record.memorySearchCount === 0 && record.memorySearchBytes === 0) {
      log(`no memory searches in session ${sessionId} — skipping usage record`);
      return;
    }
    appendUsageRecord(record);
  } catch (e: any) {
    log(`recordSessionUsage failed: ${e?.message ?? String(e)}`);
  }
}

async function main(): Promise<void> {
  if (process.env.MEMOREE_WIKI_WORKER === "1") return;
  if (process.env.MEMOREE_CAPTURE === "false") return;
  if (!isMemoreePluginEnabled()) { log("plugin disabled, skipping session-end"); return; }

  const input = await readStdin<CodexSessionEndInput>();
  const sessionId = input.session_id;
  const cwd = input.cwd ?? "";
  if (!sessionId) return;

  markSessionEnded(sessionId);

  try { pruneStaleSessionEventCaches(); } catch { /* best-effort */ }

  const base = loadConfig();
  if (!base) { log("no config"); return; }

  const resolved = resolveDirConfig(base, cwd || process.cwd());
  if (!resolved.collect) {
    log(`session-end capture disabled for cwd=${cwd || "?"} via ${resolved.found?.path}`);
    return;
  }
  const config = resolved.config;

  recordSessionUsage(input.transcript_path ?? undefined, sessionId);

  forceSessionEndTrigger({
    config,
    cwd: cwd || process.cwd(),
    bundleDir: bundleDirFromImportMeta(import.meta.url),
    agent: "codex",
    sessionId,
  });

  if (!tryAcquireLock(sessionId)) {
    wikiLog(`SessionEnd: periodic worker already running for ${sessionId}, skipping`);
    return;
  }

  wikiLog(`SessionEnd: triggering summary for ${sessionId}`);
  try {
    spawnCodexWikiWorker({
      config,
      sessionId,
      cwd,
      bundleDir: bundleDirFromImportMeta(import.meta.url),
      reason: "SessionEnd",
    });
  } catch (e: any) {
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
