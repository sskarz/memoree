/**
 * `memoree uninstall` — unwire harnesses. `--purge` also deletes leftover
 * plugin copies, the staged package, Memoree-managed skills, and ~/.memoree.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { uninstallClaude } from "./install-claude.js";
import { uninstallCodex } from "./install-codex.js";
import { uninstallAntigravity } from "./install-antigravity.js";
import {
  confirm,
  detectPlatforms,
  isLink,
  log,
  warn,
  type PlatformId,
} from "./util.js";
import { killEmbedDaemon } from "./embeddings.js";
import { loadManifest, type PulledManifest } from "../skillify/manifest.js";
import { runUnpull } from "../skillify/unpull.js";
import { readLocalManifest, type LocalManifest } from "../skillify/local-manifest.js";
import { uninstallPostCommitHook, type UninstallStatus } from "../graph/git-hook-install.js";
import { readUserConfig, type UserConfig } from "../user-config.js";

export const PURGE_CONFIRM_PROMPT =
  "This deletes ~/.memoree (sessions, rules, goals, embeddings) and leftover plugin files. Continue?";

export const PURGE_NON_TTY_ERROR =
  "memoree uninstall --purge requires --yes when stdin is not a TTY.";

export const CLAUDE_HOOK_LOGS = ["skillify.log", "mine-local.log", "backfill-memory.log"] as const;

export interface UninstallRuntime {
  uninstallClaude: typeof uninstallClaude;
  uninstallCodex: typeof uninstallCodex;
  uninstallAntigravity: typeof uninstallAntigravity;
  detectPlatforms: typeof detectPlatforms;
  confirm: typeof confirm;
  isInteractive: () => boolean;
  homedir: () => string;
  cwd: () => string;
  log: typeof log;
  warn: typeof warn;
  killEmbedDaemon: typeof killEmbedDaemon;
  loadManifest: typeof loadManifest;
  runUnpull: typeof runUnpull;
  readLocalManifest: (path?: string) => LocalManifest | null;
  uninstallPostCommitHook: typeof uninstallPostCommitHook;
  readUserConfig: typeof readUserConfig;
  stagedPackageHome: () => string | undefined;
}

export interface UninstallFlags {
  purge: boolean;
  yes: boolean;
}

export function parseUninstallArgs(args: string[]): UninstallFlags {
  return {
    purge: args.includes("--purge"),
    yes: args.includes("--yes"),
  };
}

/**
 * Paths `--purge` deletes under `home`, besides `~/.memoree` itself.
 * `stagedOverride` is `MEMOREE_PKG_HOME` when it points outside the default
 * `~/.local/share/memoree` tree.
 */
export function leftoverPurgePaths(home: string, stagedOverride?: string): string[] {
  const share = join(home, ".local", "share", "memoree");
  const paths = [
    share,
    join(home, ".codex", "memoree"),
    join(home, ".gemini", "config", "plugins", "memoree"),
    join(home, ".gemini", "antigravity-cli", "plugins", "memoree"),
    join(home, ".claude", "plugins", "cache", "memoree"),
    join(home, ".claude", "memoree"),
    ...CLAUDE_HOOK_LOGS.map(name => join(home, ".claude", "hooks", name)),
    join(home, ".agents", "skills", "memoree-memory"),
  ];
  if (stagedOverride && stagedOverride !== share && stagedOverride !== join(share, "pkg")) {
    paths.push(stagedOverride);
  }
  return paths;
}

function resolveRuntime(overrides: Partial<UninstallRuntime> = {}): UninstallRuntime {
  return {
    uninstallClaude,
    uninstallCodex,
    uninstallAntigravity,
    detectPlatforms,
    confirm,
    isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    homedir,
    cwd: () => process.cwd(),
    log,
    warn,
    killEmbedDaemon,
    loadManifest,
    runUnpull,
    readLocalManifest: (path?: string) => readLocalManifest(path ?? join(homedir(), ".claude", "memoree", "local-mined.json")),
    uninstallPostCommitHook,
    readUserConfig,
    stagedPackageHome: () => process.env.MEMOREE_PKG_HOME,
    ...overrides,
  };
}

function uninstallOne(runtime: UninstallRuntime, id: PlatformId, removeMarketplace: boolean): void {
  if (id === "claude") runtime.uninstallClaude({ removeMarketplace });
  else if (id === "codex") runtime.uninstallCodex();
  else runtime.uninstallAntigravity();
}

export function unwireHarnesses(
  runtime: UninstallRuntime,
  options: { removeMarketplace: boolean },
): void {
  const detected = runtime.detectPlatforms().map(platform => platform.id);
  const targets: PlatformId[] = detected.length > 0 ? detected : ["claude", "codex", "antigravity"];
  for (const target of [...new Set(targets)]) {
    try {
      uninstallOne(runtime, target, options.removeMarketplace);
    } catch (error) {
      runtime.warn(`  ${target}        uninstall failed: ${(error as Error).message}`);
    }
  }
}

function pathExists(path: string): boolean {
  return existsSync(path) || isLink(path);
}

function removeExisting(path: string, runtime: UninstallRuntime): void {
  if (!pathExists(path)) return;
  rmSync(path, { recursive: true, force: true });
  runtime.log(`  removed ${path}`);
}

function removeEmptyDir(dir: string, runtime: UninstallRuntime): void {
  try {
    if (!existsSync(dir)) return;
    if (readdirSync(dir).length > 0) return;
    rmSync(dir, { recursive: true, force: true });
    runtime.log(`  removed empty ${dir}`);
  } catch {
    /* missing, not a directory, or raced */
  }
}

function isSkillPath(path: string): boolean {
  return path.includes(`${sep}skills${sep}`) || path.endsWith(`${sep}skills`);
}

function unpullManagedSkills(runtime: UninstallRuntime): void {
  try {
    const manifest: PulledManifest = runtime.loadManifest();
    const seen = new Set<string>();
    for (const entry of manifest.entries) {
      const key = `${entry.install}\0${entry.installRoot}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cwd = entry.install === "project" ? dirname(dirname(entry.installRoot)) : undefined;
      runtime.runUnpull({ install: entry.install, cwd, users: [] });
    }
    // Hex-named leftover dirs only. Do not pass --all: that treats any
    // flat ~/.claude/skills/<name> as locally-mined and would delete
    // hand-written skills.
    runtime.runUnpull({ install: "global", users: [], legacyCleanup: true });
  } catch (error) {
    runtime.warn(`  skillify unpull skipped: ${(error as Error).message}`);
  }

  try {
    const local = runtime.readLocalManifest(
      join(runtime.homedir(), ".claude", "memoree", "local-mined.json"),
    );
    for (const entry of local?.entries ?? []) {
      if (typeof entry.canonical_path === "string" && isSkillPath(entry.canonical_path)) {
        removeExisting(entry.canonical_path, runtime);
      }
      for (const link of entry.symlinks ?? []) {
        if (typeof link === "string" && isSkillPath(link)) removeExisting(link, runtime);
      }
    }
  } catch (error) {
    runtime.warn(`  local-mined skill cleanup skipped: ${(error as Error).message}`);
  }
}

export function purgeLeftovers(runtime: UninstallRuntime): void {
  unpullManagedSkills(runtime);

  const config: UserConfig = runtime.readUserConfig();
  if (config.storage?.provider === "postgres") {
    runtime.warn(
      "  PostgreSQL schema was not dropped. Purge removes local files only; drop the schema separately if you want it gone.",
    );
  }

  try { runtime.killEmbedDaemon(); }
  catch (error) { runtime.warn(`  embeddings daemon: ${(error as Error).message}`); }

  try {
    const status: UninstallStatus = runtime.uninstallPostCommitHook(runtime.cwd());
    if (status.kind === "removed") {
      runtime.log(`  Graph          removed post-commit hook ${status.path}`);
    } else if (status.kind === "not-ours") {
      runtime.log(`  Graph          skipped foreign post-commit hook (${status.path})`);
    }
  } catch (error) {
    runtime.warn(`  graph hook uninstall skipped: ${(error as Error).message}`);
  }

  const home = runtime.homedir();
  for (const path of leftoverPurgePaths(home, runtime.stagedPackageHome())) {
    removeExisting(path, runtime);
  }
  removeEmptyDir(join(home, ".agents", "skills"), runtime);

  removeExisting(join(home, ".memoree"), runtime);
}

export async function runUninstall(
  args: string[],
  overrides: Partial<UninstallRuntime> = {},
): Promise<void> {
  const runtime = resolveRuntime(overrides);
  const { purge, yes } = parseUninstallArgs(args);
  unwireHarnesses(runtime, { removeMarketplace: purge });
  if (!purge) return;

  if (!yes) {
    if (!runtime.isInteractive()) throw new Error(PURGE_NON_TTY_ERROR);
    const ok = await runtime.confirm(PURGE_CONFIRM_PROMPT, false);
    if (!ok) {
      runtime.log("Purge cancelled. Integrations are unwired; ~/.memoree was not deleted.");
      return;
    }
  }

  purgeLeftovers(runtime);
}
