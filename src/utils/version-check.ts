/**
 * Shared installed-version helper.
 * Used by both the CC and Codex session-start hooks. Each side differs
 * only in the path of its plugin manifest:
 *   - claude-code  → <bundle>/../.claude-plugin/plugin.json
 *   - codex        → <bundle>/../.codex-plugin/plugin.json
 * Callers pass the plugin-manifest name explicitly.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Read the installed plugin version.
 *
 * Tries three sources, in order:
 *   1. `<bundle>/..<pluginManifestDir>/plugin.json` — claude-code and
 *      codex marketplace/cache layouts pin the version there.
 *   2. `<bundle>/../.memoree_version` — source installers may drop this
 *      plain-text file beside the bundle.
 *   3. Walk up from the bundle dir looking for a `package.json` whose
 *      name matches one of MEMOREE_PKG_NAMES.
 *
 * Returns null if nothing is found.
 */
export function getInstalledVersion(bundleDir: string, pluginManifestDir: string): string | null {
  try {
    const pluginJson = join(bundleDir, "..", pluginManifestDir, "plugin.json");
    const plugin = JSON.parse(readFileSync(pluginJson, "utf-8"));
    if (plugin.version) return plugin.version;
  } catch { /* fall through */ }
  try {
    const stamp = readFileSync(join(bundleDir, "..", ".memoree_version"), "utf-8").trim();
    if (stamp) return stamp;
  } catch { /* fall through */ }
  // Walk up from bundleDir looking for our package's package.json.
  // Recognized source package names.
  const MEMOREE_PKG_NAMES = new Set(["@sskarz/memoree", "memoree", "memoree-codex"]);
  let dir = bundleDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
      if (MEMOREE_PKG_NAMES.has(pkg.name) && pkg.version) return pkg.version;
    } catch { /* not here, keep looking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
