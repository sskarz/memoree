import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkArtifactFiles,
  checkPack,
  checkPackageManifest,
  checkTarballListing,
  checkTrackedFiles,
  REQUIRED_FILES_FIELD,
} from "../../scripts/pack-check.mjs";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("pack-check", () => {
  it("accepts the published-package manifest shape", () => {
    const errors = checkPackageManifest({
      license: "Apache-2.0",
      bin: { memoree: "bundle/cli.js" },
      files: REQUIRED_FILES_FIELD,
      scripts: { prepack: "npm run build" },
    });
    expect(errors).toEqual([]);
  });

  it("rejects a private package and src/ in files", () => {
    const errors = checkPackageManifest({
      private: true,
      license: "MIT",
      files: ["src/", "bundle/"],
      scripts: {},
    });
    expect(errors.some(error => error.includes("private"))).toBe(true);
    expect(errors.some(error => error.includes("src/"))).toBe(true);
    expect(errors.some(error => error.includes("Apache-2.0"))).toBe(true);
  });

  it("rejects a tarball that ships source or omits hook bundles", () => {
    const errors = checkTarballListing([
      "package/package.json",
      "package/src/cli/index.ts",
      "package/experimental/pi/README.md",
    ]);
    expect(errors.some(error => error.includes("bundle/cli.js"))).toBe(true);
    expect(errors.some(error => error.includes("src/cli/index.ts"))).toBe(true);
    expect(errors.some(error => error.includes("experimental/pi"))).toBe(true);
  });

  it("accepts a tarball with the install layout", () => {
    expect(checkTarballListing([
      "package/package.json",
      "package/.claude-plugin/marketplace.json",
      "package/harnesses/claude-code/.claude-plugin/plugin.json",
      "package/harnesses/codex/.codex-plugin/plugin.json",
      "package/bundle/cli.js",
      "package/harnesses/claude-code/bundle/session-start.js",
      "package/harnesses/codex/bundle/session-start.js",
    ])).toEqual([]);
  });

  it("checkPack on this checkout reports no manifest or tracked-file errors", () => {
    const errors = checkPack(process.cwd());
    expect(errors).toEqual([]);
  });

  it("checkTrackedFiles reports missing marketplace files", () => {
    const root = mkdtempSync(join(tmpdir(), "memoree-pack-tracked-"));
    dirs.push(root);
    writeFileSync(join(root, "package.json"), "{}\n");
    expect(checkTrackedFiles(root).length).toBeGreaterThan(0);
  });

  it("checkArtifactFiles reports missing built hook JS", () => {
    const root = mkdtempSync(join(tmpdir(), "memoree-pack-art-"));
    dirs.push(root);
    mkdirSync(root, { recursive: true });
    expect(checkArtifactFiles(root).some(error => error.includes("bundle/cli.js"))).toBe(true);
  });
});
