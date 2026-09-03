import { basename } from "node:path";
import { isPluginInstallCwd, resolveWorkspaceCwd, type WorkspaceEnv } from "./workspace-cwd.js";

/**
 * Derive a project display name from a working directory.
 *
 * Uses path.basename, which is platform-aware: on Windows it splits on BOTH
 * `\` and `/`, on POSIX on `/`. The previous `cwd.split("/").pop()` form only
 * split on `/`, so on Windows a cwd like `C:\work\repo` (no forward slashes)
 * returned the entire path instead of `repo`, polluting the `project` field
 * threaded into capture rows, session rows, and worker summaries.
 *
 * Plugin-install directories (Claude cache `0.7.153`, Codex/Antigravity
 * plugin copies) are not workspaces — remap via {@link resolveWorkspaceCwd}
 * or return "unknown" rather than a version number.
 *
 * Returns "unknown" for an empty/undefined cwd (basename("") === "").
 */
export function projectNameFromCwd(
  cwd: string | undefined | null,
  env: WorkspaceEnv = process.env,
): string {
  const raw = (cwd ?? "").trim();
  if (!raw) {
    for (const key of ["CLAUDE_PROJECT_DIR", "CURSOR_PROJECT_DIR", "CURSOR_WORKSPACE"] as const) {
      const v = (env[key] ?? "").trim();
      if (v && !isPluginInstallCwd(v)) return basename(v) || "unknown";
    }
    return "unknown";
  }
  const workspace = resolveWorkspaceCwd(raw, env, raw);
  if (isPluginInstallCwd(workspace)) return "unknown";
  return basename(workspace) || "unknown";
}
