import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAgentSkillsRoots, fanOutWrittenSkill } from "../../src/skillify/agent-roots.js";
import { clearFakeHome, setFakeHome } from "../shared/fake-home.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "memoree-agent-roots-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("detectAgentSkillsRoots", () => {
  it("returns only the Codex shared skills root when Codex is installed", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    expect(detectAgentSkillsRoots(join(home, ".claude", "skills"), home))
      .toEqual([join(home, ".agents", "skills")]);
  });

  it("returns ~/.agents/skills when ~/.agents exists even without Codex", () => {
    mkdirSync(join(home, ".agents"), { recursive: true });
    expect(detectAgentSkillsRoots(join(home, ".claude", "skills"), home))
      .toEqual([join(home, ".agents", "skills")]);
  });

  it("returns ~/.gemini/skills when Gemini/Antigravity home exists", () => {
    mkdirSync(join(home, ".gemini"), { recursive: true });
    expect(detectAgentSkillsRoots(join(home, ".claude", "skills"), home))
      .toEqual([join(home, ".gemini", "skills")]);
  });

  it("returns Codex and Gemini global roots together", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".gemini"), { recursive: true });
    expect(detectAgentSkillsRoots(join(home, ".claude", "skills"), { home }))
      .toEqual([join(home, ".agents", "skills"), join(home, ".gemini", "skills")]);
  });

  it("returns no roots when Codex, ~/.agents, and ~/.gemini are absent", () => {
    expect(detectAgentSkillsRoots(join(home, ".claude", "skills"), home)).toEqual([]);
  });

  it("never returns the canonical root itself", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    expect(detectAgentSkillsRoots(join(home, ".agents", "skills"), home)).toEqual([]);
  });

  it("project install fans out to cwd .agents and .gemini, not the user-global tree", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".agents"), { recursive: true });
    const cwd = join(home, "repo");
    const canonical = join(cwd, ".claude", "skills");
    expect(detectAgentSkillsRoots(canonical, { home, cwd, install: "project" })).toEqual([
      join(cwd, ".agents", "skills"),
      join(cwd, ".gemini", "skills"),
    ]);
    expect(detectAgentSkillsRoots(canonical, { home, cwd, install: "project" }))
      .not.toContain(join(home, ".agents", "skills"));
  });

  it("infers project install from a <cwd>/.claude/skills path", () => {
    const cwd = join(home, "app");
    const canonical = join(cwd, ".claude", "skills");
    expect(detectAgentSkillsRoots(canonical, home)).toEqual([
      join(cwd, ".agents", "skills"),
      join(cwd, ".gemini", "skills"),
    ]);
  });
});

describe("fanOutWrittenSkill", () => {
  beforeEach(() => setFakeHome(home));
  afterEach(() => clearFakeHome());

  it("is a no-op when the canonical root is not .claude/skills", () => {
    const root = join(home, "skills");
    mkdirSync(join(root, "x"), { recursive: true });
    fanOutWrittenSkill(root, "x");
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

  it("symlinks a global skill into ~/.agents/skills when Codex is present", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    const canonical = join(home, ".claude", "skills", "deploy");
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "SKILL.md"), "# skill\n");
    fanOutWrittenSkill(join(home, ".claude", "skills"), "deploy");
    expect(readlinkSync(join(home, ".agents", "skills", "deploy"))).toBe(canonical);
  });
});
