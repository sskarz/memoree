/**
 * Copy the published (or built checkout) layout to a durable directory so
 * Claude's marketplace source and hook bundles survive npx cache eviction.
 *
 * End-user installs live at ~/.local/share/memoree/pkg. The operator
 * git worktree at ~/.local/share/memoree-runtime is a different path on
 * purpose — this module never writes there.
 */

import { copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { copyDir, ensureDir, pkgRoot } from "./util.js";

/** Relative paths that a published tarball must be able to stage. */
export const STAGED_ENTRIES = [
  "package.json",
  "bundle",
  ".claude-plugin",
  "harnesses/claude-code",
  "harnesses/codex",
  "embeddings",
  "scripts/ensure-tree-sitter.mjs",
] as const;

export function defaultStagedPackageDir(home: string = homedir()): string {
  return join(home, ".local", "share", "memoree", "pkg");
}

/** Destination for the durable copy. Override with MEMOREE_PKG_HOME in tests. */
export function stagedPackageDir(): string {
  return process.env.MEMOREE_PKG_HOME ?? defaultStagedPackageDir();
}

/** Source to copy from. Override with MEMOREE_PACKAGE_ROOT in tests. */
export function packageRootForInstall(): string {
  return process.env.MEMOREE_PACKAGE_ROOT ?? pkgRoot();
}

export interface StagePackageOptions {
  sourceRoot?: string;
  destRoot?: string;
}

function copyEntry(src: string, dst: string): void {
  const info = statSync(src);
  if (info.isDirectory()) {
    if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
    copyDir(src, dst);
    return;
  }
  ensureDir(dirname(dst));
  copyFileSync(src, dst);
}

/**
 * Mirror the installable package into destRoot. Skips missing optional
 * build outputs (bundle/, embeddings/) so a source checkout can still
 * register marketplace files. Idempotent when source and dest resolve
 * to the same directory (running the staged CLI).
 */
export function stagePackage(opts: StagePackageOptions = {}): string {
  const sourceRoot = resolve(opts.sourceRoot ?? packageRootForInstall());
  const destRoot = resolve(opts.destRoot ?? stagedPackageDir());
  if (sourceRoot === destRoot) return destRoot;

  ensureDir(destRoot);
  for (const rel of STAGED_ENTRIES) {
    const src = join(sourceRoot, rel);
    if (!existsSync(src)) continue;
    copyEntry(src, join(destRoot, rel));
  }

  const marketplace = join(destRoot, ".claude-plugin", "marketplace.json");
  if (!existsSync(marketplace)) {
    throw new Error(
      `Staged package is missing ${marketplace}. The install source at ${sourceRoot} is not a Memoree package.`,
    );
  }
  return destRoot;
}

export function codexBundleExists(root: string): boolean {
  return existsSync(join(root, "harnesses", "codex", "bundle"));
}
