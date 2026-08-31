import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseReleaseBump,
  isReleaseCommitSubject,
  nextVersion,
  writeLockfileVersion,
  writePackageVersion,
} from "../../scripts/release-from-main.mjs";

describe("chooseReleaseBump", () => {
  it("skips docs/chore/test-only batches", () => {
    expect(chooseReleaseBump(["docs: fix typo", "test(cli): more cases"])).toBeNull();
    expect(chooseReleaseBump(["chore(release): 0.7.145"])).toBeNull();
    expect(chooseReleaseBump([])).toBeNull();
  });

  it("patches feat and fix on 0.x", () => {
    expect(chooseReleaseBump(["feat(codex): hook parity"], "0.7.145")).toBe("patch");
    expect(chooseReleaseBump(["fix(codex): dedupe usage"], "0.7.145")).toBe("patch");
    expect(chooseReleaseBump(["Merge pull request #9", "feat(codex): hook parity"], "0.7.145")).toBe("patch");
  });

  it("uses minor for breaking changes on 0.x", () => {
    expect(chooseReleaseBump(["feat(cli)!: rename the binary"], "0.7.145")).toBe("minor");
    expect(chooseReleaseBump(["fix: foo\n\nBREAKING CHANGE: bar".split("\n")[0], "feat!: break"], "0.7.145")).toBe("minor");
  });
});

describe("nextVersion", () => {
  it("bumps patch and 0.x breaking as minor", () => {
    expect(nextVersion("0.7.145", "patch")).toBe("0.7.146");
    expect(nextVersion("0.7.145", "minor")).toBe("0.8.0");
    expect(nextVersion("0.7.145", "major")).toBe("0.8.0");
    expect(nextVersion("1.2.3", "major")).toBe("2.0.0");
  });
});

describe("isReleaseCommitSubject", () => {
  it("matches the CI release subject", () => {
    expect(isReleaseCommitSubject("chore(release): 0.7.146")).toBe(true);
    expect(isReleaseCommitSubject("feat(codex): parity")).toBe(false);
  });
});

describe("writePackageVersion / writeLockfileVersion", () => {
  it("updates package.json and both lockfile name/version pairs", () => {
    const dir = mkdtempSync(join(tmpdir(), "memoree-release-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@sskarz/memoree", version: "0.7.145" }, null, 2) + "\n");
      writeFileSync(join(dir, "package-lock.json"), [
        "{",
        '  "name": "@sskarz/memoree",',
        '  "version": "0.7.145",',
        '  "packages": {',
        '    "": {',
        '      "name": "@sskarz/memoree",',
        '      "version": "0.7.145"',
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"));
      writePackageVersion(dir, "0.7.146");
      writeLockfileVersion(dir, "0.7.146");
      expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("0.7.146");
      const lock = readFileSync(join(dir, "package-lock.json"), "utf8");
      expect(lock).toContain('"version": "0.7.146"');
      expect(lock).not.toContain("0.7.145");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
