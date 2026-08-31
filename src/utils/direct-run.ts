import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

function canonical(path: string): string {
  const resolved = resolve(path);
  try { return realpathSync.native(resolved); } catch { return resolved; }
}

function stem(name: string): string {
  return basename(name).replace(/\.(?:[cm]?js|ts)$/i, "");
}

/**
 * True when this module is the process entry. Pass `entryName` when the
 * module may be bundled into another file (esbuild inlines import.meta.url
 * to the output), so a Codex PreToolUse `main()` cannot steal MCP stdin.
 */
export function isDirectRun(metaUrl: string, entryName?: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;

  try {
    if (canonical(fileURLToPath(metaUrl)) !== canonical(entry)) return false;
    if (!entryName) return true;
    return stem(entry) === stem(entryName);
  } catch {
    return false;
  }
}
