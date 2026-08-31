import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readdirSync, statSync } from "node:fs";

/**
 * Bundle-level anti-regression.
 *
 * Every per-agent esbuild block must replace the `__MEMOREE_VERSION__`
 * placeholder via `define`. Without it, bundled code that interpolates the
 * version constant crashes at runtime with "__MEMOREE_VERSION__ is not defined".
 * This guard prevents a per-harness build from silently dropping the substitution.
 */

const ROOT = resolve(process.cwd());

function listBundleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listBundleFiles(full));
    } else if (entry.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

const BUNDLE_DIRS = [
  ["claude-code", resolve(ROOT, "harnesses", "claude-code", "bundle")],
  ["codex", resolve(ROOT, "harnesses", "codex", "bundle")],
  ["antigravity", resolve(ROOT, "harnesses", "antigravity", "bundle")],
];

for (const [label, dir] of BUNDLE_DIRS) {
  describe(`${label} bundle: __MEMOREE_VERSION__ inlined`, () => {
    const files = listBundleFiles(dir);

    it("at least one .js file shipped", () => {
      expect(files.length).toBeGreaterThan(0);
    });

    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      it(`${rel} has the version constant substituted`, () => {
        const src = readFileSync(file, "utf-8");
        expect(src).not.toMatch(/__MEMOREE_VERSION__/);
      });
    }
  });
}
