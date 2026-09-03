import { describe, expect, it } from "vitest";
import { bundleDirFromImportMeta } from "../../src/utils/bundle-dir.js";

describe("bundleDirFromImportMeta", () => {
  it("returns the directory of a file URL", () => {
    expect(bundleDirFromImportMeta("file:///tmp/foo/bar.js")).toBe("/tmp/foo");
  });
});
