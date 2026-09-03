/**
 * Shared spawn path for the detached wiki-worker.js process.
 * Each harness supplies hooks dir, plugin marker, prompt, and extra
 * config fields (claudeBin / codexBin / agyBin).
 */

import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Config } from "../../config.js";
import { getInstalledVersion } from "../../utils/version-check.js";
import { spawnDetachedNodeWorker } from "../../utils/spawn-detached.js";
import { projectNameFromCwd } from "../../utils/project-name.js";
import { deriveProjectKey } from "../../utils/repo-identity.js";

export interface WikiSpawnCoreOptions {
  config: Config;
  sessionId: string;
  cwd: string;
  bundleDir: string;
  reason: string;
  hooksDir: string;
  pluginMarker: string;
  promptTemplate: string;
  wikiLog: string;
  extraConfig?: Record<string, unknown>;
  log: (msg: string) => void;
  spawnFn?: typeof spawnDetachedNodeWorker;
}

export function spawnWikiWorkerCore(opts: WikiSpawnCoreOptions): string {
  const projectName = projectNameFromCwd(opts.cwd);
  const projectKey = deriveProjectKey(opts.cwd || process.cwd()).key;
  const tmpDir = join(tmpdir(), `memoree-wiki-${opts.sessionId}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const pluginVersion = getInstalledVersion(opts.bundleDir, opts.pluginMarker) ?? "";
  const configFile = join(tmpDir, "config.json");
  writeFileSync(configFile, JSON.stringify({
    storage: {
      kind: opts.config.storage.kind,
    },
    memoryTable: opts.config.tableName,
    sessionsTable: opts.config.sessionsTableName,
    sessionId: opts.sessionId,
    userName: opts.config.userName,
    project: projectName,
    projectKey,
    pluginVersion,
    tmpDir,
    wikiLog: opts.wikiLog,
    hooksDir: opts.hooksDir,
    promptTemplate: opts.promptTemplate,
    ...opts.extraConfig,
  }));

  opts.log(`${opts.reason}: spawning summary worker for ${opts.sessionId}`);
  const spawn = opts.spawnFn ?? spawnDetachedNodeWorker;
  spawn(join(opts.bundleDir, "wiki-worker.js"), [configFile]);
  opts.log(`${opts.reason}: spawned summary worker for ${opts.sessionId}`);
  return configFile;
}
