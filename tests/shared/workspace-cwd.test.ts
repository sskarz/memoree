import { describe, expect, it } from "vitest";
import { isPluginInstallCwd, resolveWorkspaceCwd } from "../../src/utils/workspace-cwd.js";
import { projectNameFromCwd } from "../../src/utils/project-name.js";
import { deriveProjectKey } from "../../src/utils/repo-identity.js";

const CLAUDE_CACHE = "/Users/me/.claude/plugins/cache/memoree/memoree/0.7.153";
const CLAUDE_BUNDLE = `${CLAUDE_CACHE}/bundle`;
const CODEX_PLUGIN = "/Users/me/.codex/memoree";
const AGY_PLUGIN = "/Users/me/.gemini/config/plugins/memoree";

describe("isPluginInstallCwd", () => {
  it("detects Claude marketplace cache, Codex, and Antigravity plugin dirs", () => {
    expect(isPluginInstallCwd(CLAUDE_CACHE)).toBe(true);
    expect(isPluginInstallCwd(CLAUDE_BUNDLE)).toBe(true);
    expect(isPluginInstallCwd(CODEX_PLUGIN)).toBe(true);
    expect(isPluginInstallCwd(`${CODEX_PLUGIN}/bundle`)).toBe(true);
    expect(isPluginInstallCwd(AGY_PLUGIN)).toBe(true);
    expect(isPluginInstallCwd("/Users/me/.local/share/memoree-runtime")).toBe(true);
    expect(isPluginInstallCwd("/Users/me/.gemini/antigravity-cli/plugins/memoree")).toBe(true);
    expect(isPluginInstallCwd("/Users/me/.claude/plugins/cache/memoree/memoree/0.7.153/bundle")).toBe(true);
  });

  it("does not flag a normal workspace", () => {
    expect(isPluginInstallCwd("/Users/me/Documents/GitHub/memoree")).toBe(false);
    expect(isPluginInstallCwd("/tmp/some-project-name")).toBe(false);
    expect(isPluginInstallCwd("")).toBe(false);
  });
});

describe("resolveWorkspaceCwd", () => {
  it("keeps a real workspace cwd", () => {
    expect(resolveWorkspaceCwd("/work/app", {}, "/fallback")).toBe("/work/app");
  });

  it("remaps a Claude cache cwd via CLAUDE_PROJECT_DIR", () => {
    expect(resolveWorkspaceCwd(CLAUDE_CACHE, { CLAUDE_PROJECT_DIR: "/work/app" }, CLAUDE_CACHE)).toBe("/work/app");
  });

  it("remaps via CURSOR_PROJECT_DIR when Claude env is absent", () => {
    expect(resolveWorkspaceCwd(CLAUDE_CACHE, { CURSOR_PROJECT_DIR: "/work/app" }, CLAUDE_CACHE)).toBe("/work/app");
  });

  it("stays on the plugin path when nothing else is a workspace", () => {
    const env = { PWD: CLAUDE_CACHE, CLAUDE_PLUGIN_ROOT: CLAUDE_CACHE };
    expect(resolveWorkspaceCwd(CLAUDE_CACHE, env, CLAUDE_CACHE)).toBe(CLAUDE_CACHE);
  });
});

describe("projectNameFromCwd plugin remap", () => {
  it("uses CLAUDE_PROJECT_DIR basename instead of the cache version", () => {
    expect(projectNameFromCwd(CLAUDE_CACHE, { CLAUDE_PROJECT_DIR: "/work/ghostty-dots" })).toBe("ghostty-dots");
  });

  it("returns unknown for an unremappable plugin cwd", () => {
    expect(projectNameFromCwd(CLAUDE_CACHE, { PWD: CLAUDE_CACHE })).toBe("unknown");
  });
});

describe("deriveProjectKey plugin silo", () => {
  it("does not hash an unremappable plugin cwd into a unique project_key", () => {
    const { key, project } = deriveProjectKey(CLAUDE_CACHE, { PWD: CLAUDE_CACHE }, CLAUDE_CACHE);
    expect(key).toBe("");
    expect(project).toBe("unknown");
  });

  it("uses the remapped workspace for git identity", () => {
    const { project } = deriveProjectKey(CLAUDE_CACHE, { CLAUDE_PROJECT_DIR: "/tmp/some-project-name" });
    expect(project).toBe("some-project-name");
  });

  it("never labels a Cursor/Claude session as the plugin semver", () => {
    const { project } = deriveProjectKey(
      CLAUDE_CACHE,
      { CURSOR_PROJECT_DIR: "/Users/me/Documents/GitHub/ghostty-dots" },
      CLAUDE_CACHE,
    );
    expect(project).toBe("ghostty-dots");
    expect(project).not.toBe("0.7.153");
  });
});
