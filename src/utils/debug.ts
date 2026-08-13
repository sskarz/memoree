import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const LOG = join(homedir(), ".memoree", "hook-debug.log");

// Read at call time so tests and long-running hooks observe configuration
// changes made after module initialization.
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
