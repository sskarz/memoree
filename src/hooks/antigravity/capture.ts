#!/usr/bin/env node
/**
 * Antigravity capture — maps camelCase hook payloads onto the shared session INSERT.
 */

import { readStdin } from "../../utils/stdin.js";
import { isDirectRun } from "../../utils/direct-run.js";
import { type Config } from "../../config.js";
import { resolveCaptureConfig } from "../shared/dir-gate.js";
import { redactSecrets } from "../shared/redact.js";
import { createStorageBackend } from "../../storage/factory.js";
import { projectNameFromCwd } from "../../utils/project-name.js";
import { log as _log } from "../../utils/debug.js";
import { buildSessionPath } from "../../utils/session-path.js";
import { EmbedClient } from "../../embeddings/client.js";
import { embeddingSqlLiteral } from "../../embeddings/sql.js";
import { embeddingsDisabled } from "../../embeddings/disable.js";
import { ensurePluginNodeModulesLink } from "../../embeddings/self-heal.js";
import { buildDirectSessionInsertSql } from "../shared/session-insert-sql.js";
import { isMissingTableError } from "../../storage/schema.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  bumpTotalCount,
  loadTriggerConfig,
  shouldTrigger,
  tryAcquireLock,
  markSummaryAttempt,
  releaseLock,
} from "../summary-state.js";
import { getInstalledVersion } from "../../utils/version-check.js";
import { isMemoreePluginEnabled } from "../../utils/plugin-state.js";
import { reactSkillOpt } from "../shared/skillopt-hook.js";
import { eventNameFromArgv, normalizeAntigravityInput, sessionIdOf, workspaceCwd, type AntigravityHookInput } from "./payload.js";
import { bundleDirFromImportMeta, spawnAntigravityWikiWorker, wikiLog } from "./spawn-wiki-worker.js";

const log = (msg: string) => _log("agy-capture", msg);

function resolveEmbedDaemonPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "embeddings", "embed-daemon.js");
}

const __bundleDir = dirname(fileURLToPath(import.meta.url));
const PLUGIN_VERSION = getInstalledVersion(__bundleDir, ".antigravity-plugin") ?? "";

if (!embeddingsDisabled()) {
  try { ensurePluginNodeModulesLink({ bundleDir: __bundleDir }); } catch { /* best-effort */ }
}

export interface CaptureEvent {
  type: "user_message" | "tool_call" | "assistant_message";
  content?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

export async function captureAntigravityEvent(
  input: AntigravityHookInput,
  eventName: string,
  event: CaptureEvent,
): Promise<void> {
  if (process.env.MEMOREE_CAPTURE === "false") return;
  if (!isMemoreePluginEnabled()) return;
  input = normalizeAntigravityInput(input);
  const cwd = workspaceCwd(input);
  const config = resolveCaptureConfig(cwd, log);
  if (!config) return;
  const sessionId = sessionIdOf(input);
  if (!sessionId || sessionId === "unknown") return;

  const api = createStorageBackend(config, config.sessionsTableName);
  const ts = new Date().toISOString();
  const entry: Record<string, unknown> = {
    id: crypto.randomUUID(),
    session_id: sessionId,
    transcript_path: input.transcriptPath,
    cwd,
    hook_event_name: eventName,
    timestamp: ts,
    ...event,
  };
  const sessionPath = buildSessionPath(config, sessionId);
  const line = redactSecrets(JSON.stringify(entry));
  const jsonForSql = line.replace(/'/g, "''");
  const embedding = embeddingsDisabled()
    ? null
    : await new EmbedClient({ daemonEntry: resolveEmbedDaemonPath() }).embed(line, "document");
  const insertSql = buildDirectSessionInsertSql(config.sessionsTableName, {
    id: entry.id as string,
    sessionPath,
    filename: sessionPath.split("/").pop() ?? "",
    jsonForSql,
    embeddingSql: embeddingSqlLiteral(embedding, api.dialect),
    userName: config.userName,
    sizeBytes: Buffer.byteLength(line, "utf-8"),
    projectName: projectNameFromCwd(cwd),
    description: eventName,
    agent: "antigravity",
    pluginVersion: PLUGIN_VERSION,
    timestamp: ts,
  }, api.dialect);
  try {
    await api.query(insertSql);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingTableError(message) || /permission denied/i.test(message)) {
      await api.ensureSessionsTable(config.sessionsTableName);
      await api.query(insertSql);
    } else {
      throw error;
    }
  }
  if (event.type === "user_message") reactSkillOpt(sessionId, event.content, "antigravity");
  maybeTriggerPeriodicSummary(sessionId, cwd, config);
}

function maybeTriggerPeriodicSummary(sessionId: string, cwd: string, config: Config): void {
  if (process.env.MEMOREE_WIKI_WORKER === "1") return;
  try {
    const state = bumpTotalCount(sessionId);
    const cfg = loadTriggerConfig();
    if (!shouldTrigger(state, cfg)) return;
    if (!tryAcquireLock(sessionId)) return;
    wikiLog(`Periodic: threshold hit (total=${state.totalCount})`);
    try {
      markSummaryAttempt(sessionId);
      spawnAntigravityWikiWorker({
        config,
        sessionId,
        cwd,
        bundleDir: bundleDirFromImportMeta(import.meta.url),
        reason: "Periodic",
      });
    } catch (error: any) {
      try { releaseLock(sessionId); } catch { /* ignore */ }
      log(`periodic spawn failed: ${error.message}`);
    }
  } catch (error: any) {
    log(`periodic trigger error: ${error.message}`);
  }
}

export async function captureFromHook(input: unknown, eventName: string): Promise<void> {
  const normalized = normalizeAntigravityInput(input);
  if (eventName === "PostToolUse" && normalized.toolCall?.name) {
    await captureAntigravityEvent(normalized, eventName, {
      type: "tool_call",
      tool_name: normalized.toolCall.name,
      tool_input: normalized.toolCall.args,
      tool_response: normalized.error ? { error: normalized.error } : {},
    });
    return;
  }
  if (eventName === "UserPromptSubmit" && normalized) {
    /* user capture is driven from PreInvocation with transcript text */
  }
}

/* c8 ignore start */
async function main(): Promise<void> {
  if (process.env.MEMOREE_WIKI_WORKER === "1") return;
  const eventName = eventNameFromArgv();
  const input = await readStdin<AntigravityHookInput>();
  await captureFromHook(input, eventName);
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write("{}\n");
  });
}
/* c8 ignore stop */
