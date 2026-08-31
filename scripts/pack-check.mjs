/**
 * Static check that the npm package metadata and (when present) packed
 * tarball match the end-user `npx memoree install` layout.
 *
 * Default mode (used by `npm run verify`) does not require a build: it
 * checks package.json and git-tracked marketplace/plugin files.
 * Pass --require-artifacts after `npm run build` to also demand hook JS.
 *
 * Intentionally no shebang — Vitest imports this module the same way it
 * imports scripts/sync-versions.mjs.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_FILES_FIELD = [
  "bundle/",
  "harnesses/claude-code/",
  "harnesses/codex/",
  "embeddings/",
  ".claude-plugin/",
  "scripts/ensure-tree-sitter.mjs",
  "README.md",
  "LICENSE",
];

export const REQUIRED_TRACKED_FILES = [
  ".claude-plugin/marketplace.json",
  ".claude-plugin/plugin.json",
  "harnesses/claude-code/.claude-plugin/plugin.json",
  "harnesses/claude-code/hooks/hooks.json",
  "harnesses/codex/.codex-plugin/plugin.json",
  "harnesses/codex/hooks/hooks.json",
  "scripts/ensure-tree-sitter.mjs",
  "README.md",
  "LICENSE",
];

export const TRUSTED_REPOSITORY_URL = "git+https://github.com/sskarz/memoree.git";
export const POSTINSTALL_SCRIPT = "node scripts/ensure-tree-sitter.mjs";

export const REQUIRED_ARTIFACT_FILES = [
  "bundle/cli.js",
  "harnesses/claude-code/bundle/session-start.js",
  "harnesses/claude-code/bundle/capture.js",
  "harnesses/claude-code/bundle/recall.js",
  "harnesses/claude-code/bundle/session-end.js",
  "harnesses/codex/bundle/session-start.js",
  "harnesses/codex/bundle/capture.js",
  "embeddings/embed-daemon.js",
];

export const FORBIDDEN_TARBALL_PREFIXES = [
  "src/",
  "tests/",
  "experimental/pi/",
  "library/",
];

export function loadPackageJson(root) {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
}

export function checkPackageManifest(pkg) {
  const errors = [];
  if (pkg.private === true) errors.push("package.json must not set private: true (npx cannot fetch it)");
  if (pkg.license !== "Apache-2.0") errors.push("package.json license must be Apache-2.0");
  if (pkg.bin?.memoree !== "bundle/cli.js") errors.push("package.json bin.memoree must be bundle/cli.js");
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  if (files.length === 0) errors.push("package.json must declare a files allowlist");
  for (const entry of REQUIRED_FILES_FIELD) {
    if (!files.includes(entry)) errors.push(`package.json files must include ${entry}`);
  }
  for (const entry of files) {
    if (entry === "src" || entry === "src/" || entry.startsWith("src/")) {
      errors.push("package.json files must not include src/");
    }
    if (entry === "experimental/pi" || entry.startsWith("experimental/pi")) {
      errors.push("package.json files must not include experimental/pi");
    }
  }
  if (pkg.scripts?.prepack !== "npm run build") {
    errors.push("package.json scripts.prepack must be npm run build");
  }
  if (pkg.scripts?.postinstall !== POSTINSTALL_SCRIPT) {
    errors.push(`package.json postinstall must be ${POSTINSTALL_SCRIPT} (packed; no-ops on npx without src/)`);
  }
  const repo = pkg.repository;
  const repoUrl = typeof repo === "string" ? repo : repo && typeof repo === "object" ? repo.url : undefined;
  if (repoUrl !== TRUSTED_REPOSITORY_URL) {
    errors.push(`package.json repository.url must be ${TRUSTED_REPOSITORY_URL}`);
  }
  return errors;
}

export function checkTrackedFiles(root) {
  const errors = [];
  for (const rel of REQUIRED_TRACKED_FILES) {
    if (!existsSync(resolve(root, rel))) errors.push(`missing ${rel}`);
  }
  return errors;
}

export function checkArtifactFiles(root) {
  const errors = [];
  for (const rel of REQUIRED_ARTIFACT_FILES) {
    if (!existsSync(resolve(root, rel))) errors.push(`missing built artifact ${rel} (run npm run build)`);
  }
  return errors;
}

/** `names` are tar paths like `package/bundle/cli.js`. */
export function checkTarballListing(names) {
  const errors = [];
  const normalized = names.map(name => name.replace(/^\.\//, ""));
  const has = rel => normalized.includes(`package/${rel}`) || normalized.includes(rel);
  for (const rel of [
    "package.json",
    ".claude-plugin/marketplace.json",
    "harnesses/claude-code/.claude-plugin/plugin.json",
    "harnesses/codex/.codex-plugin/plugin.json",
    "bundle/cli.js",
    "harnesses/claude-code/bundle/session-start.js",
    "harnesses/codex/bundle/session-start.js",
    "scripts/ensure-tree-sitter.mjs",
  ]) {
    if (!has(rel)) errors.push(`tarball missing ${rel}`);
  }
  for (const name of normalized) {
    const rest = name.startsWith("package/") ? name.slice("package/".length) : name;
    for (const prefix of FORBIDDEN_TARBALL_PREFIXES) {
      if (rest === prefix.slice(0, -1) || rest.startsWith(prefix)) {
        errors.push(`tarball must not contain ${rest}`);
      }
    }
  }
  return errors;
}

export function checkPack(root, { requireArtifacts = false } = {}) {
  const pkg = loadPackageJson(root);
  const errors = [
    ...checkPackageManifest(pkg),
    ...checkTrackedFiles(root),
  ];
  if (requireArtifacts) errors.push(...checkArtifactFiles(root));
  return errors;
}

const __entryUrl = process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
if (__entryUrl) {
  const requireArtifacts = process.argv.includes("--require-artifacts");
  const errors = checkPack(process.cwd(), { requireArtifacts });
  if (errors.length > 0) {
    for (const error of errors) console.error(`pack-check: ${error}`);
    process.exit(1);
  }
}
