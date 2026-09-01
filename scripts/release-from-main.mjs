// NOTE: no shebang — imported by tests (same constraint as sync-versions.mjs).
// Decide a version bump from Conventional Commit subjects, then (in CI)
// sync manifests, publish @sskarz/memoree, and push the release commit+tag.
// Never calls runtime:promote.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncVersions } from "./sync-versions.mjs";

const RELEASE_SUBJECT = /^chore\(release\):\s+/;
const BREAKING = /BREAKING CHANGE|^[\w.]+!:|^[\w.]+(\([^)]+\))!:/;
const RELEASE_WORTHY = /^(feat|fix|perf|revert)(\([^)]+\))?:/i;

export function isReleaseCommitSubject(subject) {
  return RELEASE_SUBJECT.test(String(subject ?? "").trim());
}

/**
 * Highest bump implied by commit subjects.
 * On 0.x: feat/fix/perf/revert → patch; breaking (`feat!:` / BREAKING CHANGE) → minor.
 * Returns null when the batch is docs/chore/test-only or already a release commit.
 */
export function chooseReleaseBump(subjects, currentVersion = "0.0.0") {
  const messages = (subjects ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (messages.length === 0) return null;
  if (messages.every((s) => isReleaseCommitSubject(s))) return null;

  let bump = null;
  for (const subject of messages) {
    if (isReleaseCommitSubject(subject)) continue;
    if (BREAKING.test(subject)) {
      bump = "minor";
      continue;
    }
    if (RELEASE_WORTHY.test(subject)) {
      if (bump !== "minor") bump = "patch";
    }
  }
  if (!bump) return null;
  return bump;
}

export function nextVersion(current, bump) {
  const parts = String(current).split(".").map((n) => Number(n));
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`invalid version: ${current}`);
  }
  let [major, minor, patch] = parts;
  if (bump === "major") {
    if (major === 0) return `${major}.${minor + 1}.0`;
    return `${major + 1}.0.0`;
  }
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`invalid bump: ${bump}`);
}

export function commitSubjectsSince(fromRef, cwd = process.cwd()) {
  if (!fromRef || /^0+$/.test(fromRef)) {
    return execFileSync("git", ["log", "-20", "--format=%s"], { cwd, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
  }
  return execFileSync("git", ["log", "--format=%s", `${fromRef}..HEAD`], {
    cwd,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(detail ? `${command} ${args.join(" ")} failed:\n${detail}` : `${command} ${args.join(" ")} failed`);
  }
  return result;
}

export function writePackageVersion(root, version) {
  const path = resolve(root, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * Trusted Publishing only runs when npm sees no classic token. setup-node
 * with registry-url injects NODE_AUTH_TOKEN (often empty) and that yields
 * E404 on PUT instead of an OIDC exchange.
 */
export function envForTrustedPublish(env = process.env) {
  const next = { ...env };
  delete next.NODE_AUTH_TOKEN;
  delete next.NPM_TOKEN;
  return next;
}

/** Drop `_authToken=` lines so an empty placeholder cannot mask OIDC. */
export function stripNpmrcAuthToken(npmrcPath) {
  if (!npmrcPath) return false;
  try {
    const text = readFileSync(npmrcPath, "utf8");
    const next = text
      .split(/\r?\n/)
      .filter((line) => !/_authToken/i.test(line))
      .join("\n");
    if (next === text) return false;
    writeFileSync(npmrcPath, next);
    return true;
  } catch {
    return false;
  }
}

export function writeLockfileVersion(root, version) {
  const path = resolve(root, "package-lock.json");
  let text = readFileSync(path, "utf8");
  let replacements = 0;
  text = text.replace(
    /("name": "@sskarz\/memoree",\s*"version": ")[^"]+"/g,
    (_m, keep) => {
      replacements += 1;
      return `${keep}${version}"`;
    },
  );
  if (replacements < 1) {
    throw new Error("package-lock.json has no @sskarz/memoree version to update");
  }
  writeFileSync(path, text);
}

export function publishRelease(options = {}) {
  const root = options.root ?? process.cwd();
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const subjects = options.subjects ?? commitSubjectsSince(options.fromRef, root);
  const bump = chooseReleaseBump(subjects, pkg.version);
  if (!bump) {
    process.stdout.write("release-from-main: no publishable commits; skipping\n");
    return { skipped: true, version: pkg.version };
  }
  const version = nextVersion(pkg.version, bump);
  writePackageVersion(root, version);
  writeLockfileVersion(root, version);
  syncVersions({ root });
  process.stdout.write(`release-from-main: ${pkg.version} -> ${version} (${bump})\n`);

  if (options.dryRun) return { skipped: false, version, bump };

  run("git", ["config", "user.name", "github-actions[bot]"], { cwd: root });
  run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], { cwd: root });
  run("git", ["add", "--", "package.json", "package-lock.json"], { cwd: root });
  run("git", [
    "add",
    "--",
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    "harnesses/claude-code/.claude-plugin/plugin.json",
    "harnesses/codex/package.json",
    "harnesses/codex/.codex-plugin/plugin.json",
  ], { cwd: root });
  run("git", ["commit", "-m", `chore(release): ${version}`], { cwd: root });
  run("git", ["tag", "-a", `v${version}`, "-m", `chore(release): ${version}`], { cwd: root });
  const publishEnv = envForTrustedPublish(options.env ?? process.env);
  stripNpmrcAuthToken(publishEnv.NPM_CONFIG_USERCONFIG);
  run("npm", ["publish", "--access", "public", "--provenance"], {
    cwd: root,
    env: publishEnv,
  });
  run("git", ["push", "origin", "HEAD", `v${version}`], { cwd: root });
  return { skipped: false, version, bump };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    publishRelease({
      fromRef: process.env.RELEASE_FROM_REF,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-from-main: ${message}\n`);
    process.exitCode = 1;
  }
}
