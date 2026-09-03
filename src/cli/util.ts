import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, symlinkSync, unlinkSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

export const HOME = homedir();

// Walk up from this module's location to the package root. Robust across
// three layouts:
//   - source (src/cli/util.ts) → project root
//   - local bundle (bundle/cli.js)              → project root
//   - npm-installed (node_modules/@sskarz/memoree/bundle/cli.js
//     or node_modules/memoree/bundle/cli.js)
//                                               → install dir
// Without the walk-up, the source path resolved to `src/` (one dir up
// from src/cli/util.ts), so unit tests importing the installers couldn't
// find the per-agent bundles at project_root/harnesses/<agent>/bundle/.
const PACKAGE_NAMES = new Set(["@sskarz/memoree", "memoree", "memoree-codex"]);

/** True when `dir/package.json` is a named Memoree package (not an ESM `{type:module}` stub). */
export function isNamedMemoreePackageDir(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    return PACKAGE_NAMES.has(pkg.name) && typeof pkg.version === "string" && pkg.version.length > 0;
  } catch {
    return false;
  }
}

function isMemoreeRootDir(dir: string): boolean {
  return isNamedMemoreePackageDir(dir) || existsSync(join(dir, ".memoree_version"));
}

export function pkgRoot(): string {
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (isMemoreeRootDir(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Do not treat one-level-up from command/memoree.js as the package root when
  // that directory only has an unnamed ESM `{type:module}` stub.
  const fallback = fileURLToPath(new URL("..", import.meta.url));
  if (isMemoreeRootDir(fallback)) return fallback;
  return fallback;
}

/** `{name, version, type:module}` written into the *installed* Codex/Antigravity plugin bundle so `getVersion()` is not 0.0.0. Build-time esbuild outdirs stay an unnamed `{type:module}` stub so checkout hooks still walk up to the real package root. */
export function bundleEsmPackageJson(version: string): string {
  return JSON.stringify({ name: "memoree", version, type: "module" }, null, 2) + "\n";
}

export function writeBundleEsmPackageJson(bundleDir: string, version: string): void {
  ensureDir(bundleDir);
  writeFileSync(join(bundleDir, "package.json"), bundleEsmPackageJson(version));
}

export function ensureDir(path: string, mode: number = 0o755): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode });
}

export function copyDir(src: string, dst: string): void {
  cpSync(src, dst, { recursive: true, force: true, dereference: false });
}

export function symlinkForce(target: string, link: string): void {
  ensureDir(dirname(link));
  if (existsSync(link) || isLink(link)) unlinkSync(link);
  symlinkSync(target, link);
}

export function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

export function readJson<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return null; }
}

export function writeJson(path: string, obj: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

/**
 * Write JSON only if the serialized result differs from what's already on
 * disk. Returns true if it wrote, false if the file already matched.
 *
 * Why: Codex fingerprints each hook *definition* and re-prompts the user to
 * "review & trust" whenever a hook it sees has changed. Our installer used to
 * rewrite hooks.json unconditionally on every install/update — even when the
 * merged result was byte-identical — which re-triggered that trust prompt for
 * no reason. Skipping the write when nothing changed keeps the file (and its
 * fingerprint) stable, so Codex stops re-asking after the first trust.
 */
export function writeJsonIfChanged(path: string, obj: unknown): boolean {
  const next = JSON.stringify(obj, null, 2) + "\n";
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf-8") === next) return false; // unchanged → no write
    } catch { /* unreadable → fall through and rewrite */ }
  }
  ensureDir(dirname(path));
  writeFileSync(path, next);
  return true;
}

export { readVersionStamp, writeVersionStamp } from "../utils/version-check.js";

export type PlatformId = "claude" | "codex" | "antigravity";

export interface DetectedPlatform {
  id: PlatformId;
  markerDir: string;
}

export function allPlatformIds(): PlatformId[] {
  return ["claude", "codex", "antigravity"];
}

/**
 * Gemini CLI and Antigravity both live under `~/.gemini`. Only treat the
 * tree as Antigravity when an Antigravity-specific directory exists, so
 * `memoree install` does not merge hooks.json / mcp_config.json into a
 * Gemini-CLI-only home.
 */
export function isAntigravityHome(home: string): boolean {
  const gemini = join(home, ".gemini");
  return existsSync(join(gemini, "antigravity-cli"))
    || existsSync(join(gemini, "antigravity"));
}

export function detectPlatformsAt(home: string): DetectedPlatform[] {
  const found: DetectedPlatform[] = [];
  const claude = join(home, ".claude");
  const codex = join(home, ".codex");
  if (existsSync(claude)) found.push({ id: "claude", markerDir: claude });
  if (existsSync(codex)) found.push({ id: "codex", markerDir: codex });
  if (isAntigravityHome(home)) found.push({ id: "antigravity", markerDir: join(home, ".gemini") });
  return found;
}

export function detectPlatforms(): DetectedPlatform[] {
  return detectPlatformsAt(HOME);
}

export function log(msg: string): void {
  process.stdout.write(msg + "\n");
}

export function warn(msg: string): void {
  process.stderr.write(msg + "\n");
}

// Interactive y/n prompt. Renders the hint based on the default so a bare
// Enter is unambiguous. Writes the question to stderr (same channel as warn)
// so log piping stays clean. Callers must check process.stdin.isTTY first —
// readline on closed stdin would hang the process.
export function confirm(message: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(`${message} ${hint} `, answer => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "") resolve(defaultYes);
      else resolve(a === "y" || a === "yes");
    });
  });
}

