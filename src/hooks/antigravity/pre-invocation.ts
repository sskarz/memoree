#!/usr/bin/env node
/**
 * Antigravity PreInvocation: first-call session inject + recall, plus user-prompt capture.
 * stdout is injectSteps / {} — never a Stop decision.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readStdin } from "../../utils/stdin.js";
import { isDirectRun } from "../../utils/direct-run.js";
import { loadConfig } from "../../config.js";
import { resolveDirConfig } from "../../dir-config.js";
import { log as _log } from "../../utils/debug.js";
import { getInstalledVersion } from "../../utils/version-check.js";
import { autoPullSkills } from "../../skillify/auto-pull.js";
import { maybeSpawnHygieneWorker } from "../../skillify/spawn-hygiene-worker.js";
import { maybeAutoMineLocal } from "../../skillify/spawn-mine-local-worker.js";
import { maybeAutoBackfillMemory } from "../../skillify/spawn-backfill-memory-worker.js";
import { spawnGraphPullWorker } from "../../graph/spawn-pull-worker.js";
import { embeddingsDisabled } from "../../embeddings/disable.js";
import { createStorageBackend } from "../../storage/factory.js";
import { embedSummaryWithWarmup } from "../../embeddings/embed-summary.js";
import {
  shouldRecall,
  passesThreshold,
  proactiveRecallDisabled,
  parsePositive,
  RECALL_THRESHOLD,
} from "../shared/recall-gate.js";
import { recallTopHit } from "../shared/recall-query.js";
import { formatRecallContext } from "../shared/recall-format.js";
import { withDeadline } from "../shared/with-deadline.js";
import { MEMORY_COMMAND_GUIDANCE } from "../shared/memory-command-contract.js";
import { deriveProjectKey } from "../../utils/repo-identity.js";
import { normalizeAntigravityInput, sessionIdOf, workspaceCwd, type AntigravityHookInput } from "./payload.js";
import { claimFirstInvocation, lastTurn, readTranscriptTurns, takeNewUserPrompt } from "./transcript.js";
import { captureAntigravityEvent } from "./capture.js";

const log = (msg: string) => _log("agy-preinv", msg);
const __bundleDir = dirname(fileURLToPath(import.meta.url));
const RECALL_BUDGET_MS = parsePositive(process.env.MEMOREE_RECALL_TIMEOUT_MS, 1500);

export const ANTIGRAVITY_MEMORY_CONTEXT =
  "MEMOREE MEMORY: Use the Memoree MCP tools — memoree_read, memoree_ls, memoree_grep, " +
  "memoree_head, memoree_tail, memoree_wc, memoree_find, memoree_jq, memoree_write, " +
  "memoree_mv, memoree_rm. Do not cat/ls/grep ~/.memoree/memory with " +
  "run_command or view_file; that path is virtual.\n" +
  "Start with memoree_read path=\"identity.json\", then rules.md and goals.md. " +
  "Past sessions: memoree_read path=\"index.md\", then summaries/<user>/<session>.md.\n" +
  MEMORY_COMMAND_GUIDANCE;

export function isFirstModelCall(invocationNum: number | undefined): boolean {
  return invocationNum === 0 || invocationNum === 1;
}

async function recallSnippet(prompt: string, cwd: string): Promise<string> {
  if (proactiveRecallDisabled() || !shouldRecall(prompt)) return "";
  const base = loadConfig();
  if (!base) return "";
  const config = resolveDirConfig(base, cwd).config;
  try {
    const hit = await withDeadline((async () => {
      const api = createStorageBackend(config, config.tableName);
      const q = (sql: string) => api.query(sql);
      if (embeddingsDisabled()) return null;
      const vec = await embedSummaryWithWarmup(prompt, "query", {
        daemonEntry: join(__bundleDir, "embeddings", "embed-daemon.js"),
        log,
      });
      if (!vec) return null;
      return recallTopHit(q, config.tableName, vec, {
        projectKey: deriveProjectKey(cwd).key,
      });
    })(), RECALL_BUDGET_MS, null);
    if (!hit || !passesThreshold(hit.score, RECALL_THRESHOLD)) return "";
    return formatRecallContext({ hit, currentUser: config.userName, memoryRoot: config.memoryPath, now: Date.now() });
  } catch (error: any) {
    log(`recall skipped: ${error.message}`);
    return "";
  }
}

export async function processPreInvocation(input: unknown): Promise<Record<string, unknown>> {
  if (process.env.MEMOREE_WIKI_WORKER === "1") return {};
  const normalized = normalizeAntigravityInput(input);
  const sessionId = sessionIdOf(normalized);
  const cwd = workspaceCwd(normalized);
  const turns = readTranscriptTurns(normalized.transcriptPath);
  const userText = lastTurn(turns, "user");
  const freshUser = takeNewUserPrompt(sessionId, userText);
  if (freshUser) {
    try {
      await captureAntigravityEvent(normalized, "UserPromptSubmit", { type: "user_message", content: freshUser });
    } catch (error: any) {
      log(`capture user failed: ${error.message}`);
    }
  }

  const inject: string[] = [];
  const first = isFirstModelCall(normalized.invocationNum) && claimFirstInvocation(sessionId);
  if (first) {
    const config = loadConfig();
    const version = getInstalledVersion(__bundleDir, ".antigravity-plugin");
    inject.push(
      `${ANTIGRAVITY_MEMORY_CONTEXT}\nMemoree memory backend: ${config?.storage.kind ?? "unavailable"}.` +
      (version ? `\nMemoree v${version}` : ""),
    );
    try {
      const setup = join(__bundleDir, "session-start-setup.js");
      const child = spawn("node", [setup], {
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
        env: { ...process.env },
      });
      child.stdin?.write(JSON.stringify({
        session_id: sessionId,
        cwd,
        transcript_path: normalized.transcriptPath,
        hook_event_name: "SessionStart",
      }));
      child.stdin?.end();
      child.unref();
    } catch (error: any) {
      log(`setup spawn failed: ${error.message}`);
    }
    try { await autoPullSkills(); } catch { /* administrative */ }
    try { maybeSpawnHygieneWorker({ cwd, bundleDir: __bundleDir, agent: "antigravity" }); } catch { /* ignore */ }
    try { maybeAutoMineLocal(); } catch { /* ignore */ }
    try { maybeAutoBackfillMemory(); } catch { /* ignore */ }
    if (config) spawnGraphPullWorker(cwd, __bundleDir);
  }

  if (freshUser) {
    const recalled = await recallSnippet(freshUser, cwd);
    if (recalled) inject.push(recalled);
  }

  if (inject.length === 0) return {};
  return {
    injectSteps: inject.map(text => ({ ephemeralMessage: text })),
  };
}

/* c8 ignore start */
async function main(): Promise<void> {
  const input = await readStdin<AntigravityHookInput>();
  process.stdout.write(JSON.stringify(await processPreInvocation(input)) + "\n");
}

if (isDirectRun(import.meta.url, "pre-invocation")) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write("{}\n");
  });
}
/* c8 ignore stop */
