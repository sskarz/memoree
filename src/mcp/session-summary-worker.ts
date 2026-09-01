#!/usr/bin/env node
/**
 * Detached Antigravity MCP summary worker.
 *
 * Invoked as: node session-summary-worker.js <config.json>
 * Writes /summaries/<user>/<sessionId>.md and embeds it. Must not run on
 * the MCP tools/call hot path.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../config.js";
import { embeddingsDisabled } from "../embeddings/disable.js";
import { embedSummaryWithWarmup } from "../embeddings/embed-summary.js";
import { createWorkerStorage, queryWorkerStorage } from "../hooks/worker-storage.js";
import { isDirectRun } from "../utils/direct-run.js";
import { log as _log } from "../utils/debug.js";
import { deriveProjectKey } from "../utils/repo-identity.js";
import { projectNameFromCwd } from "../utils/project-name.js";
import { writeMcpSessionSummary } from "./session-summary.js";

const dlog = (msg: string) => _log("mcp-session-summary", msg);

export interface McpSessionSummaryWorkerConfig {
  sessionId: string;
  cwd: string;
  project?: string;
  projectKey?: string;
}

export async function runMcpSessionSummaryWorker(configPath: string): Promise<void> {
  const cfg = JSON.parse(readFileSync(configPath, "utf-8")) as McpSessionSummaryWorkerConfig;
  if (!cfg.sessionId) {
    dlog("missing sessionId — exiting");
    return;
  }
  const base = loadConfig();
  if (!base) {
    dlog("storage configuration unavailable — exiting");
    return;
  }
  const cwd = cfg.cwd || process.cwd();
  const project = cfg.project || projectNameFromCwd(cwd);
  const projectKey = cfg.projectKey || deriveProjectKey(cwd).key;
  const storage = createWorkerStorage({
    storage: { kind: base.storage.kind },
    memoryTable: base.tableName,
    sessionsTable: base.sessionsTableName,
    userName: base.userName,
  }, dlog);
  const query = (sql: string) => queryWorkerStorage(storage, sql);
  try {
    const embedText = embeddingsDisabled()
      ? undefined
      : async (text: string): Promise<number[] | null> => {
        const daemonEntry = join(dirname(fileURLToPath(import.meta.url)), "embeddings", "embed-daemon.js");
        return embedSummaryWithWarmup(text, "document", { daemonEntry, log: dlog });
      };
    const result = await writeMcpSessionSummary({
      query,
      memoryTable: base.tableName,
      sessionsTable: base.sessionsTableName,
      sessionId: cfg.sessionId,
      userName: base.userName,
      project,
      projectKey,
      agent: "antigravity",
      embedText,
      dialect: storage.dialect,
    });
    dlog(`summary ${result.path} for ${cfg.sessionId}`);
  } finally {
    await storage.close().catch(() => undefined);
  }
}

if (isDirectRun(import.meta.url, "session-summary-worker")) {
  const configPath = process.argv[2];
  if (!configPath) {
    dlog("usage: session-summary-worker.js <config.json>");
    process.exit(2);
  }
  runMcpSessionSummaryWorker(configPath).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    dlog(`failed: ${message}`);
    process.exit(1);
  });
}
