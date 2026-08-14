#!/usr/bin/env node

/**
 * Detached skill-catalog hygiene worker.
 *
 * Invoked as: node hygiene-worker.js <config.json>
 * The parent SessionStart hook already acquired the hygiene lock and
 * passed the 24h quiet period; this process releases the lock when done.
 */

import { readFileSync } from "node:fs";
import { runHygieneCycle } from "./hygiene.js";
import { releaseWorkerLock } from "./state.js";
import { hygieneLockKey } from "./hygiene.js";
import type { Agent } from "./gate-runner.js";

process.env.MEMOREE_SKILLIFY_WORKER = "1";
process.env.MEMOREE_CAPTURE = "false";

interface WorkerConfig {
  cwd: string;
  projectKey: string;
  project: string;
  agent: Agent;
  tmpDir: string;
  gateBin?: string;
}

async function main(): Promise<void> {
  const cfg = JSON.parse(readFileSync(process.argv[2]!, "utf-8")) as WorkerConfig;
  const lockKey = hygieneLockKey(cfg.projectKey);
  try {
    await runHygieneCycle({
      cwd: cfg.cwd,
      projectKey: cfg.projectKey,
      agent: cfg.agent,
      lockHeld: true,
      force: true,
    });
  } finally {
    try { releaseWorkerLock(lockKey); } catch { /* best effort */ }
  }
}

main().catch(() => {
  process.exit(0);
});
