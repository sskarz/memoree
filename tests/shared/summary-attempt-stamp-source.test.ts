import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Cross-agent source guard for the #331 back-off.
 *
 * Only the claude_code and codex capture hooks have functional trigger tests
 * (their suites mock summary-state). Both are near-identical by construction,
 * and the two properties that matter
 * are ordering ones a refactor can silently break:
 *
 *   1. the attempt is stamped BEFORE the worker is spawned — otherwise a
 *      failing run leaves lastSummaryCount at 0 and the trigger refires on
 *      every captured event, which is the bug itself;
 *   2. the stamp sits INSIDE the try that releases the spawn lock — otherwise
 *      a throwing state write leaks the lock until the 10-minute stale reclaim.
 */

const CAPTURES = [
  "src/hooks/capture.ts",
  "src/hooks/codex/capture.ts",
] as const;

describe("periodic summary trigger — attempt stamping (issue #331)", () => {
  for (const rel of CAPTURES) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    const trigger = src.slice(src.indexOf("function maybeTriggerPeriodicSummary"));

    it(`${rel} stamps the attempt before spawning the worker`, () => {
      const stampAt = trigger.indexOf("markSummaryAttempt(sessionId)");
      const spawnAt = trigger.search(/spawn\w*WikiWorker\(\{/);
      expect(stampAt, "markSummaryAttempt missing").toBeGreaterThan(-1);
      expect(spawnAt, "wiki worker spawn missing").toBeGreaterThan(-1);
      expect(spawnAt).toBeGreaterThan(stampAt);
    });

    it(`${rel} stamps inside the try that releases the lock`, () => {
      const tryAt = trigger.indexOf("try {", trigger.indexOf("tryAcquireLock"));
      const stampAt = trigger.indexOf("markSummaryAttempt(sessionId)");
      const releaseAt = trigger.indexOf("releaseLock(sessionId)");
      expect(tryAt).toBeGreaterThan(-1);
      expect(stampAt).toBeGreaterThan(tryAt);
      expect(releaseAt).toBeGreaterThan(stampAt);
    });
  }
});
