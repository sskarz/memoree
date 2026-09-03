/**
 * Hooks sometimes report cwd as the Memoree plugin install directory
 * (Claude marketplace cache `.../memoree/<semver>`, Codex `~/.codex/memoree`,
 * Antigravity plugin dir) instead of the user's workspace. Using that path
 * for `project` / `project_key` siloes the session away from the real repo.
 */

export type WorkspaceEnv = Record<string, string | undefined>;

function posix(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * True when `cwd` is a Memoree plugin/runtime install, not a user workspace.
 *
 * Matchers are contained to known install roots so a real repo named
 * `memoree-runtime` or a random `plugins/<semver>/bundle` tree is not flagged.
 * Nested paths under those roots (hooks, harness bundle, skills) still match.
 */
export function isPluginInstallCwd(
  cwd: string | undefined | null,
  env: WorkspaceEnv = process.env,
): boolean {
  if (!cwd) return false;
  const n = posix(cwd);
  if (/\/\.claude\/plugins\/cache\/memoree\/memoree\/\d+\.\d+\.\d+(?:\/|$)/.test(n)) return true;
  if (/\/\.codex\/memoree(?:\/|$)/.test(n)) return true;
  if (/\/\.gemini\/(?:config|antigravity-cli)\/plugins\/memoree(?:\/|$)/.test(n)) return true;
  if (/\/\.local\/share\/memoree-runtime(?:\/|$)/.test(n)) return true;
  const runtimeDir = posix((env.MEMOREE_RUNTIME_DIR ?? "").trim());
  if (runtimeDir && (n === runtimeDir || n.startsWith(`${runtimeDir}/`))) return true;
  return false;
}

function firstNonPlugin(
  candidates: Array<string | undefined | null>,
  env: WorkspaceEnv,
): string | null {
  for (const c of candidates) {
    const v = (c ?? "").trim();
    if (!v) continue;
    if (!isPluginInstallCwd(v, env)) return v;
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
  const hookCwd = raw && !isPluginInstallCwd(raw, env) && !underPluginRoot ? raw : undefined;
  const resolved = firstNonPlugin([
    hookCwd,
    env.CLAUDE_PROJECT_DIR,
    env.CURSOR_PROJECT_DIR,
    env.CURSOR_WORKSPACE,
    env.PWD,
    fallback,
  ], env);
  return resolved ?? (raw || fallback);
}
