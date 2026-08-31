import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SessionStart must actually invoke the local mine + memory-backfill
 * spawners. Both helpers were previously imported and left unused, so
 * auto-mine and auto-backfill never ran. Lock the call sites in source.
 */
const SESSION_START_FILES = [
  "src/hooks/session-start.ts",
  "src/hooks/codex/session-start.ts",
];

describe("SessionStart auto-spawns local mine and memory backfill", () => {
  for (const rel of SESSION_START_FILES) {
    it(`${rel} calls maybeAutoMineLocal() and maybeAutoBackfillMemory()`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf-8");
      expect(src).toMatch(/\bmaybeAutoMineLocal\s*\(/);
      expect(src).toMatch(/\bmaybeAutoBackfillMemory\s*\(/);
    });
  }
});
