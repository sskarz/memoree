import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkTarballListing, REQUIRED_ARTIFACT_FILES } from "../../scripts/pack-check.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const artifactsBuilt = REQUIRED_ARTIFACT_FILES.every(rel => existsSync(join(repoRoot, rel)));

describe("npm pack layout", () => {
  it.skipIf(!artifactsBuilt)("packs the durable install layout without source or experimental/pi", () => {
    const dest = mkdtempSync(join(tmpdir(), "memoree-npm-pack-"));
    try {
      const packed = execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", dest, "--json"], {
        cwd: repoRoot,
        encoding: "utf-8",
      });
      const parsed = JSON.parse(packed) as Array<{ filename: string }> | { filename: string };
      const filename = Array.isArray(parsed) ? parsed[0]?.filename : parsed.filename;
      expect(filename).toBeTruthy();
      const tarball = join(dest, filename as string);
      const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf-8" })
        .trim()
        .split("\n");
      expect(checkTarballListing(listing)).toEqual([]);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  }, 60_000);
});
