import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { InstallLocation } from "./scope-config.js";

export interface DetectAgentSkillsRootsOpts {
  home?: string;
  cwd?: string;
  install?: InstallLocation;
}

/**
 * Return non-Claude skill directories to symlink into.
 *
 * Canonical writes stay under `~/.claude/skills` (global) or
 * `<cwd>/.claude/skills` (project). Other agents load from their own
 * trees, so we fan out **symlinks** (never copies):
 *   - Global: `~/.agents/skills` if Codex or `~/.agents` exists;
 *     `~/.gemini/skills` if `~/.gemini` exists.
 *   - Project: `<cwd>/.agents/skills` and `<cwd>/.gemini/skills`.
 *     Never leak project skills into `~/.agents/skills`.
 *
 * The second argument remains a home string for existing callers.
 */
export function detectAgentSkillsRoots(
  canonicalRoot: string,
  homeOrOpts: string | DetectAgentSkillsRootsOpts = homedir(),
): string[] {
  const opts: DetectAgentSkillsRootsOpts = typeof homeOrOpts === "string"
    ? { home: homeOrOpts }
    : homeOrOpts;
  const home = opts.home ?? homedir();
  const install = opts.install ?? inferInstall(canonicalRoot, home);
  if (install === null) return [];

  const roots: string[] = [];
  if (install === "global") {
    if (existsSync(join(home, ".codex")) || existsSync(join(home, ".agents"))) {
      roots.push(join(home, ".agents", "skills"));
    }
    if (existsSync(join(home, ".gemini"))) {
      roots.push(join(home, ".gemini", "skills"));
    }
  } else {
    const cwd = opts.cwd ?? dirname(dirname(canonicalRoot));
    roots.push(join(cwd, ".agents", "skills"));
    roots.push(join(cwd, ".gemini", "skills"));
  }
  return roots.filter(root => root !== canonicalRoot);
}

function inferInstall(canonicalRoot: string, home: string): InstallLocation | null {
  if (canonicalRoot === join(home, ".claude", "skills")) return "global";
  const normalized = canonicalRoot.replace(/\\/g, "/");
  if (normalized.endsWith("/.claude/skills")) return "project";
  return null;
}

/**
 * Make `<root>/<dirName>` point at `canonicalDir` for each detected
 * non-Claude agent root. Returns the absolute paths of every symlink
 * that ended up pointing correctly (existing or newly created), in the
 * order of `agentRoots`. Caller stores this in the manifest entry so
 * unpull can reverse the fan-out without rescanning the disk.
 *
 * Refusal cases (path NOT in the returned list, no exception thrown):
 *  - A non-symlink file or directory already sits at the link path. We
 *    never clobber user data.
 *  - symlink() raises (Windows non-developer mode, read-only fs,
 *    permission denied).
 *
 * Idempotency: re-running with the same agentRoots is a no-op for links
 * that already point at the right target. Stale links are unlinked and
 * recreated.
 */
export function fanOutSymlinks(
  canonicalDir: string,
  dirName: string,
  agentRoots: string[],
): string[] {
  const out: string[] = [];
  for (const root of agentRoots) {
    const link = join(root, dirName);
    let existing;
    try { existing = lstatSync(link); } catch { existing = null; }
    if (existing) {
      if (!existing.isSymbolicLink()) {
        continue;
      }
      let current: string | null;
      try { current = readlinkSync(link); } catch { current = null; }
      if (current === canonicalDir) {
        out.push(link);
        continue;
      }
      try { unlinkSync(link); } catch { continue; }
    }
    try {
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(canonicalDir, link, "dir");
      out.push(link);
    } catch {
      // Best-effort. The canonical dir exists either way.
    }
  }
  return out;
}

/** Fan out a skill that was just written under `skillsRoot/<dirName>/`. */
export function fanOutWrittenSkill(skillsRoot: string, dirName: string): void {
  const roots = detectAgentSkillsRoots(skillsRoot);
  if (roots.length === 0) return;
  fanOutSymlinks(join(skillsRoot, dirName), dirName, roots);
}
