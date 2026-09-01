import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Bundle-level guard: assert the skillify worker is actually shipped in
 * every agent's bundle and that each agent's hook bundle contains the
 * trigger wiring. Source-level tests prove the modules are correct;
 * these tests prove `npm run build` didn't drop them.
 */

const ROOT = process.cwd();
const AGENTS = ["claude-code", "codex", "antigravity"] as const;

function bundlePath(agent: string, file: string): string {
  const base = join(ROOT, "harnesses", agent);
  return join(base, "bundle", file);
}

describe("skillify-worker bundle is shipped per agent", () => {
  for (const agent of AGENTS) {
    it(`${agent}/bundle/skillify-worker.js exists and contains the worker entry`, () => {
      const path = bundlePath(agent, "skillify-worker.js");
      expect(existsSync(path), `${path} missing`).toBe(true);
      const text = readFileSync(path, "utf-8");
      // Sanity: bundle should have the skillify log channel and the gate prompt.
      expect(text).toContain("skillify-worker(");
      // Gate-prompt heading: was "EXISTING PROJECT SKILLS" pre-#119;
      // became "EXISTING SKILLS" after the project + global merge; #118
      // appended the contributors auto-promote clause so we check that
      // the prompt explicitly mentions cross-author MERGE + scope=team.
      expect(text).toContain("EXISTING SKILLS");
      expect(text).toContain("scope=team");
      expect(text).toContain("Cross-author MERGE");
      // Watermark advance is the SKIP hot path.
      expect(text).toContain("advancing watermark");
    });
  }
});

describe("triggers are wired in each agent's hook bundles", () => {
  it("claude-code: capture.js (Stop counter) AND session-end.js (force trigger)", () => {
    const cap = readFileSync(bundlePath("claude-code", "capture.js"), "utf-8");
    expect(cap).toContain("tryStopCounterTrigger");
    const se = readFileSync(bundlePath("claude-code", "session-end.js"), "utf-8");
    expect(se).toContain("forceSessionEndTrigger");
  });

  it("codex: stop.js AND session-end.js fire forceSessionEndTrigger", () => {
    const stop = readFileSync(bundlePath("codex", "stop.js"), "utf-8");
    expect(stop).toContain("forceSessionEndTrigger");
    const se = readFileSync(bundlePath("codex", "session-end.js"), "utf-8");
    expect(se).toContain("forceSessionEndTrigger");
  });

  it("antigravity: stop.js fires forceSessionEndTrigger", () => {
    const stop = readFileSync(bundlePath("antigravity", "stop.js"), "utf-8");
    expect(stop).toContain("forceSessionEndTrigger");
  });
});

describe("each agent records the correct agent name", () => {
  it("claude-code passes agent: 'claude_code' to triggers", () => {
    const cap = readFileSync(bundlePath("claude-code", "capture.js"), "utf-8");
    const se = readFileSync(bundlePath("claude-code", "session-end.js"), "utf-8");
    expect(cap + se).toContain(`"claude_code"`);
  });
  it("codex passes agent: 'codex' to triggers", () => {
    const stop = readFileSync(bundlePath("codex", "stop.js"), "utf-8");
    const se = readFileSync(bundlePath("codex", "session-end.js"), "utf-8");
    expect(stop + se).toContain(`"codex"`);
  });
  it("antigravity passes agent: 'antigravity' to triggers", () => {
    expect(readFileSync(bundlePath("antigravity", "stop.js"), "utf-8")).toContain(`"antigravity"`);
  });
});

describe("known anti-patterns are absent from bundled worker", () => {
  it("does not UPDATE the skills table — append-only by design (CLAUDE.md UPDATE-coalescing quirk)", () => {
    for (const agent of AGENTS) {
      const text = readFileSync(bundlePath(agent, "skillify-worker.js"), "utf-8");
      expect(text, `${agent}: skillify-worker.js contains UPDATE on skills table`).not.toMatch(/UPDATE\s+"?skills"?\s+SET/i);
    }
  });
});

describe("legacy state-dir migration is shipped in every agent's bundle", () => {
  // The migration call wires into the supported read/write entry points so a
  // post-rename worker / SessionStart sees the migrated state. If any of
  // these regressions ship, users with a populated ~/.memoree/state/skilify/
  // would silently start fresh on ~/.memoree/state/skillify/.
  //
  for (const agent of AGENTS) {
    it(`${agent}/bundle/skillify-worker.js: migration helper present and called from readState`, () => {
      const text = readFileSync(bundlePath(agent, "skillify-worker.js"), "utf-8");
      expect(text, `${agent}: migrateLegacyStateDir helper missing`).toContain("function migrateLegacyStateDir");
      // readState is the first state file the worker touches; if migration
      // isn't called here the worker re-mines already-processed sessions.
      expect(text, `${agent}: readState missing migrateLegacyStateDir call`).toMatch(
        /function readState\([^)]*\)\s*\{\s*migrateLegacyStateDir\(\)/,
      );
      // Narrow-catch behaviour: only EXDEV/EPERM swallowed; everything else rethrows.
      expect(text, `${agent}: migration swallows too broadly`).toMatch(
        /code === "EXDEV" \|\| code === "EPERM"/,
      );
    });
  }
});
