import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shouldSkipPublishedPostinstall } from "../../scripts/ensure-tree-sitter.mjs";

const script = resolve(import.meta.dirname, "../../scripts/ensure-tree-sitter.mjs");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("shouldSkipPublishedPostinstall", () => {
  it("skips a published/npx extract that has no src/", () => {
    expect(shouldSkipPublishedPostinstall(tmp("memoree-heal-npx-"), {})).toBe(true);
  });

  it("does not skip a development checkout that has src/cli/index.ts", () => {
    const root = tmp("memoree-heal-src-");
    mkdirSync(join(root, "src", "cli"), { recursive: true });
    writeFileSync(join(root, "src", "cli", "index.ts"), "export {}\n");
    expect(shouldSkipPublishedPostinstall(root, {})).toBe(false);
  });

  it("does not skip graph provisioning (STRICT) even when cwd is embed-deps", () => {
    const embedDeps = tmp("memoree-embed-deps-");
    expect(shouldSkipPublishedPostinstall(embedDeps, { MEMOREE_STRICT_POSTINSTALL: "1" })).toBe(false);
  });

  it("does not skip when MEMOREE_HEAL_TREE_SITTER=1", () => {
    expect(shouldSkipPublishedPostinstall(tmp("memoree-heal-force-"), { MEMOREE_HEAL_TREE_SITTER: "1" })).toBe(false);
  });
});

describe("ensure-tree-sitter postinstall entry", () => {
  it("exits 0 without compiling when cwd has no src/ and heal env is unset", () => {
    const cwd = tmp("memoree-heal-skip-run-");
    const env = {
      ...process.env,
      MEMOREE_HEAL_TREE_SITTER: "",
      MEMOREE_STRICT_POSTINSTALL: "",
    };
    const result = spawnSync(process.execPath, [script], {
      cwd,
      encoding: "utf-8",
      env,
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("skipping native heal");
  });
});
