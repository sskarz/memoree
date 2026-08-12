import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const LOG = join(homedir(), ".memoree", "hook-debug.log");

// Lazy read: the openclaw bundle replaces `process.env.MEMOREE_DEBUG`
// with `globalThis.__memoree_tuning__.MEMOREE_DEBUG` via esbuild
// `define`. The lookup must happen at call-time (not module-init) so it
// picks up the values openclaw populates AFTER this module is imported.
// Was previously `const DEBUG = …` at module top — that would have frozen
// the value to `false` for the openclaw bundle regardless of pluginConfig.
function isDebug(): boolean {
  return process.env.MEMOREE_DEBUG === "1";
}

/** Format a Date (default: now) as `YYYY-MM-DD HH:MM:SS UTC`. */
export function utcTimestamp(d: Date = new Date()): string {
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function log(tag: string, msg: string) {
  if (!isDebug()) return;
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${new Date().toISOString()} [${tag}] ${msg}\n`);
  } catch { /* best-effort */ }
}
