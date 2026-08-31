import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexBundleExists,
  defaultStagedPackageDir,
  packageRootForInstall,
  stagePackage,
  stagedPackageDir,
} from "../../src/cli/stage-package.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.MEMOREE_PKG_HOME;
  delete process.env.MEMOREE_PACKAGE_ROOT;
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function seedPackage(root: string, opts: { bundle?: boolean; codexBundle?: boolean } = {}): void {
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "memoree", version: "0.0.0" }) + "\n");
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "marketplace.json"), JSON.stringify({
    name: "memoree",
    plugins: [{ name: "memoree", source: "./harnesses/claude-code" }],
  }) + "\n");
  mkdirSync(join(root, "harnesses", "claude-code", "hooks"), { recursive: true });
  writeFileSync(join(root, "harnesses", "claude-code", "hooks", "hooks.json"), "{}\n");
  mkdirSync(join(root, "harnesses", "codex", "hooks"), { recursive: true });
  writeFileSync(join(root, "harnesses", "codex", "hooks", "hooks.json"), "{}\n");
  if (opts.bundle) {
    mkdirSync(join(root, "bundle"), { recursive: true });
    writeFileSync(join(root, "bundle", "cli.js"), "#!/usr/bin/env node\n");
  }
  if (opts.codexBundle) {
    mkdirSync(join(root, "harnesses", "codex", "bundle"), { recursive: true });
    writeFileSync(join(root, "harnesses", "codex", "bundle", "session-start.js"), "export {}\n");
  }
}

describe("stagePackage", () => {
  it("copies marketplace, harnesses, and optional bundles into the durable dest", () => {
    const source = tmp("memoree-stage-src-");
    const dest = tmp("memoree-stage-dst-");
    seedPackage(source, { bundle: true, codexBundle: true });
    expect(stagePackage({ sourceRoot: source, destRoot: dest })).toBe(dest);
    expect(readFileSync(join(dest, ".claude-plugin", "marketplace.json"), "utf-8")).toContain("memoree");
    expect(existsSync(join(dest, "bundle", "cli.js"))).toBe(true);
    expect(existsSync(join(dest, "harnesses", "codex", "bundle", "session-start.js"))).toBe(true);
    expect(codexBundleExists(dest)).toBe(true);
  });

  it("skips missing optional build outputs but requires marketplace.json", () => {
    const source = tmp("memoree-stage-src-");
    const dest = tmp("memoree-stage-dst-");
    seedPackage(source);
    stagePackage({ sourceRoot: source, destRoot: dest });
    expect(existsSync(join(dest, "bundle"))).toBe(false);
    expect(codexBundleExists(dest)).toBe(false);
  });

  it("throws when the source is not a Memoree package", () => {
    const source = tmp("memoree-stage-empty-");
    const dest = tmp("memoree-stage-dst-");
    writeFileSync(join(source, "package.json"), "{}\n");
    expect(() => stagePackage({ sourceRoot: source, destRoot: dest })).toThrow(/missing/);
  });

  it("is a no-op when source and dest resolve to the same directory", () => {
    const dir = tmp("memoree-stage-same-");
    seedPackage(dir);
    expect(stagePackage({ sourceRoot: dir, destRoot: dir })).toBe(dir);
  });

  it("keeps the staged copy after the source extract is deleted", () => {
    const source = tmp("memoree-npx-extract-");
    const dest = tmp("memoree-durable-");
    seedPackage(source, { bundle: true });
    writeFileSync(join(source, "bundle", "cli.js"), "durable-cli\n");
    stagePackage({ sourceRoot: source, destRoot: dest });
    rmSync(source, { recursive: true, force: true });
    expect(readFileSync(join(dest, "bundle", "cli.js"), "utf-8")).toBe("durable-cli\n");
    expect(existsSync(join(dest, ".claude-plugin", "marketplace.json"))).toBe(true);
  });

  it("overwrites a previous staged version", () => {
    const source = tmp("memoree-stage-src-");
    const dest = tmp("memoree-stage-dst-");
    seedPackage(source, { bundle: true });
    writeFileSync(join(source, "bundle", "cli.js"), "v1\n");
    stagePackage({ sourceRoot: source, destRoot: dest });
    writeFileSync(join(source, "bundle", "cli.js"), "v2\n");
    stagePackage({ sourceRoot: source, destRoot: dest });
    expect(readFileSync(join(dest, "bundle", "cli.js"), "utf-8")).toBe("v2\n");
  });

  it("honors MEMOREE_PKG_HOME and MEMOREE_PACKAGE_ROOT", () => {
    const source = tmp("memoree-stage-env-src-");
    const dest = tmp("memoree-stage-env-dst-");
    seedPackage(source);
    process.env.MEMOREE_PACKAGE_ROOT = source;
    process.env.MEMOREE_PKG_HOME = dest;
    expect(packageRootForInstall()).toBe(source);
    expect(stagedPackageDir()).toBe(dest);
    expect(stagePackage()).toBe(dest);
    expect(existsSync(join(dest, ".claude-plugin", "marketplace.json"))).toBe(true);
  });

  it("defaultStagedPackageDir is under ~/.local/share/memoree/pkg", () => {
    expect(defaultStagedPackageDir("/home/user")).toBe("/home/user/.local/share/memoree/pkg");
  });
});
