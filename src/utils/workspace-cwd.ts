/**
 * Hooks sometimes report cwd as the Memoree plugin install directory
 * (Claude marketplace cache `.../memoree/<semver>`, Codex `~/.codex/memoree`,
 * Antigravity plugin dir) instead of the user's workspace. Using that path
 * for `project` / `project_key` siloes the session away from the real repo.
 */

export type WorkspaceEnv = Record<string, string | undefined>;

const SEMVER_DIR = /^\d+\.\d+\.\d+$/;

function posix(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** True when `cwd` is a Memoree plugin/runtime install, not a user workspace. */
export function isPluginInstallCwd(cwd: string | undefined | null): boolean {
  if (!cwd) return false;
  const n = posix(cwd);
  if (/\/plugins\/cache\/memoree\/memoree\/\d+\.\d+\.\d+(?:\/bundle)?$/.test(n)) return true;
  if (/\/\.codex\/memoree(?:\/bundle)?$/.test(n)) return true;
  if (/\/\.gemini\/(?:config|antigravity-cli)\/plugins\/memoree(?:\/bundle)?$/.test(n)) return true;
  if (/\/memoree-runtime(?:\/bundle)?$/.test(n)) return true;
  const parts = n.split("/");
  const base = parts[parts.length - 1] ?? "";
  const parent = parts[parts.length - 2] ?? "";
  if (base === "bundle" && SEMVER_DIR.test(parent) && parts.includes("plugins")) return true;
  if (SEMVER_DIR.test(base) && parent === "memoree" && n.includes("/plugins/cache/")) return true;
  return false;
}

function firstNonPlugin(candidates: Array<string | undefined | null>): string | null {
  for (const c of candidates) {
    const v = (c ?? "").trim();
    if (!v) continue;
    if (!isPluginInstallCwd(v)) return v;
  }
  return null;
}

/**
 * Prefer a real workspace over a plugin-install cwd.
 *
 * Order: hook cwd (if not a plugin dir), then well-known project env vars,
 * then `$PWD`, then `fallback` (`process.cwd()` at the call site).
 */
export function resolveWorkspaceCwd(
  cwd: string | undefined | null,
  env: WorkspaceEnv = process.env,
  fallback: string = process.cwd(),
): string {
  const pluginRoot = (env.CLAUDE_PLUGIN_ROOT ?? "").trim();
  const raw = (cwd ?? "").trim();
  const underPluginRoot = Boolean(pluginRoot && raw && posix(raw).startsWith(posix(pluginRoot)));
  const hookCwd = raw && !isPluginInstallCwd(raw) && !underPluginRoot ? raw : undefined;
  const resolved = firstNonPlugin([
    hookCwd,
    env.CLAUDE_PROJECT_DIR,
    env.CURSOR_PROJECT_DIR,
    env.CURSOR_WORKSPACE,
    env.PWD,
    fallback,
  ]);
  return resolved ?? (raw || fallback);
}
