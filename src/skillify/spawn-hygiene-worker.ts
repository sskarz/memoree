/**
 * Detached spawn for the skill-catalog hygiene worker.
 *
 * SessionStart calls maybeSpawnHygieneWorker after auto-pull. A 24h quiet
 * period plus the per-project hygiene lock prevent overlapping runs.
 * Recursion: MEMOREE_SKILLIFY_WORKER=1 (same guard as the session miner).
 */

import { join } from "node:path";
import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnDetachedNodeWorker } from "../utils/spawn-detached.js";
import { deriveProjectKey } from "../utils/repo-identity.js";
import { findAgentBin, type Agent } from "./gate-runner.js";
import { skillifyLog } from "./spawn-skillify-worker.js";
import {
  hygieneLockKey,
  HYGIENE_QUIET_MS,
  readHygieneLastRun,
} from "./hygiene.js";
import { tryAcquireWorkerLock, releaseWorkerLock } from "./state.js";

export interface HygieneSpawnOptions {
  cwd: string;
  bundleDir: string;
  agent: Agent;
  now?: () => number;
  spawnFn?: typeof spawnDetachedNodeWorker;
}

export type HygieneSpawnResult =
  | { triggered: true }
  | { triggered: false; reason: "recursion" | "quiet" | "lock" | "spawn-failed" };

export function maybeSpawnHygieneWorker(opts: HygieneSpawnOptions): HygieneSpawnResult {
  if (process.env.MEMOREE_SKILLIFY_WORKER === "1") {
    return { triggered: false, reason: "recursion" };
  }
  if (!opts.cwd) return { triggered: false, reason: "spawn-failed" };

  let projectKey: string;
  let project: string;
  try {
    const id = deriveProjectKey(opts.cwd);
    projectKey = id.key;
    project = id.project;
  } catch {
    return { triggered: false, reason: "spawn-failed" };
  }

  const now = (opts.now ?? Date.now)();
  const last = readHygieneLastRun(projectKey);
  if (last !== null && now - last < HYGIENE_QUIET_MS) {
    return { triggered: false, reason: "quiet" };
  }

  const lockKey = hygieneLockKey(projectKey);
  if (!tryAcquireWorkerLock(lockKey)) {
    return { triggered: false, reason: "lock" };
  }

  try {
    const tmpDir = join(tmpdir(), `memoree-hygiene-${projectKey}-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const configFile = join(tmpDir, "config.json");
    writeFileSync(configFile, JSON.stringify({
      cwd: opts.cwd,
      projectKey,
      project,
      agent: opts.agent,
      tmpDir,
      gateBin: findAgentBin(opts.agent),
    }), { mode: 0o600 });
    try { chmodSync(configFile, 0o600); } catch { /* best effort */ }

    const spawn = opts.spawnFn ?? spawnDetachedNodeWorker;
    spawn(join(opts.bundleDir, "hygiene-worker.js"), [configFile]);
    skillifyLog(`hygiene: spawned worker for project=${project} key=${projectKey}`);
    return { triggered: true };
  } catch (e) {
    try { releaseWorkerLock(lockKey); } catch { /* best effort */ }
    skillifyLog(`hygiene spawn failed: ${e instanceof Error ? e.message : String(e)}`);
    return { triggered: false, reason: "spawn-failed" };
  }
}

export { bundleDirFromImportMeta } from "../utils/bundle-dir.js";
