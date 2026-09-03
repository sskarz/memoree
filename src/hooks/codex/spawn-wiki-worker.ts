/**
 * Codex-specific helper for spawning the detached wiki-worker.js.
 * Targets ~/.codex/ paths and codexBin.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { Config } from "../../config.js";
import { makeWikiLogger } from "../../utils/wiki-log.js";
import { resolveCliBin } from "../../utils/resolve-cli-bin.js";
import { spawnWikiWorkerCore } from "../shared/wiki-spawn.js";
import { WIKI_PROMPT_TEMPLATE_COMPACT } from "../shared/wiki-prompt.js";

export { bundleDirFromImportMeta } from "../../utils/bundle-dir.js";
export const WIKI_PROMPT_TEMPLATE = WIKI_PROMPT_TEMPLATE_COMPACT;

const HOME = homedir();
const wikiLogger = makeWikiLogger(join(HOME, ".codex", "hooks"));
export const WIKI_LOG = wikiLogger.path;
export const wikiLog = wikiLogger.log;

export function findCodexBin(): string {
  return resolveCliBin("codex", "codex");
}

export interface SpawnOptions {
  config: Config;
  sessionId: string;
  cwd: string;
  bundleDir: string;
  reason: string;
}

export function spawnCodexWikiWorker(opts: SpawnOptions): void {
  const hooksDir = join(HOME, ".codex", "hooks");
  spawnWikiWorkerCore({
    config: opts.config,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    bundleDir: opts.bundleDir,
    reason: opts.reason,
    hooksDir,
    pluginMarker: ".codex-plugin",
    promptTemplate: WIKI_PROMPT_TEMPLATE,
    wikiLog: WIKI_LOG,
    extraConfig: {
      codexBin: findCodexBin(),
    },
    log: wikiLog,
  });
}
