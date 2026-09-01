#!/usr/bin/env node
/**
 * Antigravity Stop — capture last assistant message, spawn wiki + skillify.
 * stdout must never be `{ decision: "continue" }` (that re-enters the loop).
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readStdin } from "../../utils/stdin.js";
import { isDirectRun } from "../../utils/direct-run.js";
import { loadConfig } from "../../config.js";
import { resolveDirConfig } from "../../dir-config.js";
import { log as _log } from "../../utils/debug.js";
import { forceSessionEndTrigger } from "../../skillify/triggers.js";
import { tryAcquireLock, releaseLock } from "../summary-state.js";
import { getInstalledVersion } from "../../utils/version-check.js";
import { normalizeAntigravityInput, type AntigravityHookInput } from "./payload.js";
import { lastTurn, readTranscriptTurns } from "./transcript.js";
import { captureAntigravityEvent } from "./capture.js";
import { bundleDirFromImportMeta, spawnAntigravityWikiWorker, wikiLog } from "./spawn-wiki-worker.js";

const log = (msg: string) => _log("agy-stop", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
void getInstalledVersion(__bundleDir, ".antigravity-plugin");

export function stopDecision(): Record<string, unknown> {
  return { decision: "stop" };
}

export async function processStop(input: unknown): Promise<Record<string, unknown>> {
  if (process.env.MEMOREE_WIKI_WORKER === "1") return stopDecision();
  const normalized = normalizeAntigravityInput(input);
  const sessionId = normalized.conversationId?.trim();
  if (!sessionId) return stopDecision();

  const cwd = normalized.workspacePaths?.[0]?.trim() || process.cwd();
  const base = loadConfig();
  if (!base) { log("no config"); return stopDecision(); }
  const dirRes = resolveDirConfig(base, cwd);
  if (!dirRes.collect) { log(`capture disabled for cwd=${cwd}`); return stopDecision(); }
  const config = dirRes.config;

  if (process.env.MEMOREE_CAPTURE !== "false") {
    const assistant = lastTurn(readTranscriptTurns(normalized.transcriptPath), "assistant");
    try {
      await captureAntigravityEvent(normalized, "Stop", {
        type: "assistant_message",
        content: assistant.slice(0, 4000),
      });
    } catch (error: any) {
      log(`capture failed: ${error.message}`);
    }
  }

  if (process.env.MEMOREE_CAPTURE === "false") return stopDecision();

  forceSessionEndTrigger({
    config,
    cwd,
    bundleDir: bundleDirFromImportMeta(import.meta.url),
    agent: "antigravity",
    sessionId,
  });

  if (!tryAcquireLock(sessionId)) {
    wikiLog(`Stop: periodic worker already running for ${sessionId}, skipping`);
    return stopDecision();
  }

  wikiLog(`Stop: triggering summary for ${sessionId}`);
  try {
    spawnAntigravityWikiWorker({
      config,
      sessionId,
      cwd,
      bundleDir: bundleDirFromImportMeta(import.meta.url),
      reason: "Stop",
    });
  } catch (error: any) {
    log(`spawn failed: ${error.message}`);
    try { releaseLock(sessionId); } catch { /* ignore */ }
  }
  return stopDecision();
}

/* c8 ignore start */
async function main(): Promise<void> {
  const input = await readStdin<AntigravityHookInput>();
  process.stdout.write(JSON.stringify(await processStop(input)) + "\n");
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(JSON.stringify(stopDecision()) + "\n");
  });
}
/* c8 ignore stop */
