/**
 * Claude Code helper for spawning the detached wiki-worker.js process.
 * Called from session-end.ts (always) and capture.ts (periodic trigger).
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { Config } from "../config.js";
import { makeWikiLogger } from "../utils/wiki-log.js";
import { resolveCliBin } from "../utils/resolve-cli-bin.js";
import { spawnWikiWorkerCore } from "./shared/wiki-spawn.js";
import { WIKI_PROMPT_TEMPLATE } from "./shared/wiki-prompt.js";

export { bundleDirFromImportMeta } from "../utils/bundle-dir.js";
export { WIKI_PROMPT_TEMPLATE };

const HOME = homedir();
const wikiLogger = makeWikiLogger(join(HOME, ".claude", "hooks"));
export const WIKI_LOG = wikiLogger.path;
export const wikiLog = wikiLogger.log;

export function findClaudeBin(): string {
  return resolveCliBin("claude");
}

export interface SpawnOptions {
  config: Config;
  sessionId: string;
  cwd: string;
  bundleDir: string;
  reason: string;
  /** Value written to the summary's `agent` column. Defaults to "claude_code". */
  agent?: string;
}

export function spawnWikiWorker(opts: SpawnOptions): void {
  const hooksDir = join(HOME, ".claude", "hooks");
  spawnWikiWorkerCore({
    config: opts.config,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    bundleDir: opts.bundleDir,
    reason: opts.reason,
    hooksDir,
    pluginMarker: ".claude-plugin",
    promptTemplate: WIKI_PROMPT_TEMPLATE,
    wikiLog: WIKI_LOG,
    extraConfig: {
      orgName: opts.config.orgName,
      agent: opts.agent ?? "claude_code",
      claudeBin: findClaudeBin(),
    },
    log: wikiLog,
  });
}
