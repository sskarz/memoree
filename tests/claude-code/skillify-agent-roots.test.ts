import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAgentSkillsRoots } from "../../src/skillify/agent-roots.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "memoree-agent-roots-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("detectAgentSkillsRoots", () => {
  it("returns only the Codex shared skills root when Codex is installed", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    expect(detectAgentSkillsRoots(join(home, ".claude", "skills"), home))
      .toEqual([join(home, ".agents", "skills")]);
  });

  it("returns no roots when Codex is absent", () => {
    expect(detectAgentSkillsRoots(join(home, ".claude", "skills"), home)).toEqual([]);
  });

  it("never returns the canonical root itself", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    expect(detectAgentSkillsRoots(join(home, ".agents", "skills"), home)).toEqual([]);
  });
});
