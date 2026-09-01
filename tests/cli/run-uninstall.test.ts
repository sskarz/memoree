import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  leftoverPurgePaths,
  parseUninstallArgs,
  purgeLeftovers,
  PURGE_CONFIRM_PROMPT,
  PURGE_NON_TTY_ERROR,
  runUninstall,
  unwireHarnesses,
  type UninstallRuntime,
} from "../../src/cli/run-uninstall.js";
import type { PlatformId } from "../../src/cli/util.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tmpHome(): string {
  const home = mkdtempSync(join(tmpdir(), "memoree-uninstall-"));
  homes.push(home);
  return home;
}

function runtime(home: string, overrides: Partial<UninstallRuntime> = {}): UninstallRuntime {
  return {
    uninstallClaude: vi.fn(),
    uninstallCodex: vi.fn(),
    uninstallAntigravity: vi.fn(),
    detectPlatforms: () => [
      { id: "claude" as PlatformId, markerDir: join(home, ".claude") },
      { id: "codex" as PlatformId, markerDir: join(home, ".codex") },
    ],
    confirm: vi.fn(async () => false),
    isInteractive: () => false,
    homedir: () => home,
    cwd: () => home,
    log: vi.fn(),
    warn: vi.fn(),
    killEmbedDaemon: vi.fn(),
    loadManifest: () => ({ version: 1, entries: [] }),
    runUnpull: vi.fn(),
    readLocalManifest: () => null,
    uninstallPostCommitHook: () => ({ kind: "no-hook", path: "" }),
    readUserConfig: () => ({}),
    stagedPackageHome: () => undefined,
    ...overrides,
  };
}

describe("parseUninstallArgs", () => {
  it("defaults to unwire-only", () => {
    expect(parseUninstallArgs([])).toEqual({ purge: false, yes: false });
    expect(parseUninstallArgs(["--all"])).toEqual({ purge: false, yes: false });
  });

  it("accepts --purge and --yes independently", () => {
    expect(parseUninstallArgs(["--purge"])).toEqual({ purge: true, yes: false });
    expect(parseUninstallArgs(["--yes", "--purge"])).toEqual({ purge: true, yes: true });
  });
});

describe("leftoverPurgePaths", () => {
  it("lists Memoree-owned leftover trees under home", () => {
    const paths = leftoverPurgePaths("/home/u");
    expect(paths).toContain("/home/u/.local/share/memoree");
    expect(paths).toContain("/home/u/.codex/memoree");
    expect(paths).toContain("/home/u/.gemini/config/plugins/memoree");
    expect(paths).toContain("/home/u/.gemini/antigravity-cli/plugins/memoree");
    expect(paths).toContain("/home/u/.claude/plugins/cache/memoree");
    expect(paths).toContain("/home/u/.claude/memoree");
    expect(paths).toContain("/home/u/.claude/hooks/skillify.log");
    expect(paths).toContain("/home/u/.agents/skills/memoree-memory");
    expect(paths).not.toContain("/home/u/.memoree");
    expect(paths).not.toContain("/home/u/.local/share/memoree-runtime");
  });

  it("includes a custom staged package dir outside the default share tree", () => {
    expect(leftoverPurgePaths("/home/u", "/tmp/custom-pkg")).toContain("/tmp/custom-pkg");
    expect(leftoverPurgePaths("/home/u", "/home/u/.local/share/memoree/pkg")).not.toContain(
      "/home/u/.local/share/memoree/pkg",
    );
    expect(
      leftoverPurgePaths("/home/u", "/home/u/.local/share/memoree").filter(p => p === "/home/u/.local/share/memoree"),
    ).toHaveLength(1);
  });
});

describe("unwireHarnesses", () => {
  it("continues when Claude uninstall throws", () => {
    const home = tmpHome();
    const uninstallCodex = vi.fn();
    const rt = runtime(home, {
      uninstallClaude: vi.fn(() => { throw new Error("claude missing"); }),
      uninstallCodex,
    });
    unwireHarnesses(rt, { removeMarketplace: false });
    expect(uninstallCodex).toHaveBeenCalledOnce();
    expect(rt.warn).toHaveBeenCalledWith(expect.stringContaining("claude"));
  });

  it("tries every harness when none are detected", () => {
    const home = tmpHome();
    const uninstallClaude = vi.fn();
    const uninstallCodex = vi.fn();
    const uninstallAntigravity = vi.fn();
    unwireHarnesses(runtime(home, {
      detectPlatforms: () => [],
      uninstallClaude,
      uninstallCodex,
      uninstallAntigravity,
    }), { removeMarketplace: true });
    expect(uninstallClaude).toHaveBeenCalledWith({ removeMarketplace: true });
    expect(uninstallCodex).toHaveBeenCalledOnce();
    expect(uninstallAntigravity).toHaveBeenCalledOnce();
  });
});

describe("runUninstall", () => {
  it("unwires without deleting ~/.memoree when --purge is omitted", async () => {
    const home = tmpHome();
    mkdirSync(join(home, ".memoree"), { recursive: true });
    writeFileSync(join(home, ".memoree", "config.json"), "{}\n");
    const rt = runtime(home);
    await runUninstall([], rt);
    expect(rt.uninstallClaude).toHaveBeenCalledWith({ removeMarketplace: false });
    expect(rt.killEmbedDaemon).not.toHaveBeenCalled();
    expect(existsSync(join(home, ".memoree", "config.json"))).toBe(true);
  });

  it("refuses non-interactive --purge without --yes and leaves ~/.memoree", async () => {
    const home = tmpHome();
    mkdirSync(join(home, ".memoree"), { recursive: true });
    writeFileSync(join(home, ".memoree", "keep"), "1");
    const rt = runtime(home, { isInteractive: () => false });
    await expect(runUninstall(["--purge"], rt)).rejects.toThrow(PURGE_NON_TTY_ERROR);
    expect(existsSync(join(home, ".memoree", "keep"))).toBe(true);
    expect(rt.uninstallClaude).toHaveBeenCalledWith({ removeMarketplace: true });
    expect(rt.killEmbedDaemon).not.toHaveBeenCalled();
  });

  it("cancels purge when the confirm prompt is declined", async () => {
    const home = tmpHome();
    mkdirSync(join(home, ".memoree"), { recursive: true });
    writeFileSync(join(home, ".memoree", "keep"), "1");
    const confirm = vi.fn(async () => false);
    const logs: string[] = [];
    const rt = runtime(home, {
      isInteractive: () => true,
      confirm,
      log: line => { logs.push(line); },
    });
    await runUninstall(["--purge"], rt);
    expect(confirm).toHaveBeenCalledWith(PURGE_CONFIRM_PROMPT, false);
    expect(existsSync(join(home, ".memoree", "keep"))).toBe(true);
    expect(logs.some(line => line.includes("Purge cancelled"))).toBe(true);
  });

  it("purges leftovers and ~/.memoree after --purge --yes, preserving user files", async () => {
    const home = tmpHome();
    mkdirSync(join(home, ".memoree"), { recursive: true });
    writeFileSync(join(home, ".memoree", "config.json"), "{}\n");
    mkdirSync(join(home, ".codex", "memoree", "bundle"), { recursive: true });
    writeFileSync(join(home, ".codex", "memoree", "bundle", "session-start.js"), "x");
    writeFileSync(join(home, ".codex", "AGENTS.md"), "# mine\n");
    mkdirSync(join(home, ".local", "share", "memoree", "pkg"), { recursive: true });
    writeFileSync(join(home, ".local", "share", "memoree", "pkg", "package.json"), "{}\n");
    mkdirSync(join(home, ".gemini", "config", "plugins", "memoree"), { recursive: true });
    writeFileSync(join(home, ".gemini", "config", "plugins", "memoree", "plugin.json"), "{}\n");
    mkdirSync(join(home, ".claude", "plugins", "cache", "memoree"), { recursive: true });
    mkdirSync(join(home, ".claude", "memoree"), { recursive: true });
    mkdirSync(join(home, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(home, ".claude", "hooks", "skillify.log"), "log");
    mkdirSync(join(home, ".claude", "skills", "my-own"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "my-own", "SKILL.md"), "# mine\n");
    mkdirSync(join(home, ".agents", "skills", "memoree-memory"), { recursive: true });
    writeFileSync(join(home, ".agents", "skills", "memoree-memory", "SKILL.md"), "x");

    const rt = runtime(home);
    await runUninstall(["--purge", "--yes"], rt);

    expect(rt.killEmbedDaemon).toHaveBeenCalledOnce();
    expect(rt.uninstallClaude).toHaveBeenCalledWith({ removeMarketplace: true });

    expect(existsSync(join(home, ".memoree"))).toBe(false);
    expect(existsSync(join(home, ".codex", "memoree"))).toBe(false);
    expect(existsSync(join(home, ".local", "share", "memoree"))).toBe(false);
    expect(existsSync(join(home, ".gemini", "config", "plugins", "memoree"))).toBe(false);
    expect(existsSync(join(home, ".claude", "plugins", "cache", "memoree"))).toBe(false);
    expect(existsSync(join(home, ".claude", "memoree"))).toBe(false);
    expect(existsSync(join(home, ".claude", "hooks", "skillify.log"))).toBe(false);
    expect(existsSync(join(home, ".agents", "skills", "memoree-memory"))).toBe(false);
    expect(existsSync(join(home, ".agents", "skills"))).toBe(false);
    expect(existsSync(join(home, ".codex", "AGENTS.md"))).toBe(true);
    expect(existsSync(join(home, ".claude", "skills", "my-own", "SKILL.md"))).toBe(true);
  });
});

describe("purgeLeftovers", () => {
  it("unpulls each unique manifest root then runs a global --all pass", () => {
    const home = tmpHome();
    const runUnpull = vi.fn();
    purgeLeftovers(runtime(home, {
      runUnpull,
      loadManifest: () => ({
        version: 1,
        entries: [
          {
            dirName: "a--alice",
            name: "a",
            author: "alice",
            projectKey: "p",
            remoteVersion: 1,
            install: "global",
            installRoot: join(home, ".claude", "skills"),
            pulledAt: "t",
            symlinks: [],
          },
          {
            dirName: "b--bob",
            name: "b",
            author: "bob",
            projectKey: "p",
            remoteVersion: 1,
            install: "project",
            installRoot: join(home, "proj", ".claude", "skills"),
            pulledAt: "t",
            symlinks: [],
          },
          {
            dirName: "c--alice",
            name: "c",
            author: "alice",
            projectKey: "p",
            remoteVersion: 1,
            install: "global",
            installRoot: join(home, ".claude", "skills"),
            pulledAt: "t",
            symlinks: [],
          },
        ],
      }),
    }));
    expect(runUnpull).toHaveBeenCalledTimes(3);
    expect(runUnpull).toHaveBeenNthCalledWith(1, {
      install: "global",
      cwd: undefined,
      users: [],
    });
    expect(runUnpull).toHaveBeenNthCalledWith(2, {
      install: "project",
      cwd: join(home, "proj"),
      users: [],
    });
    expect(runUnpull).toHaveBeenNthCalledWith(3, {
      install: "global",
      users: [],
      legacyCleanup: true,
    });
  });

  it("warns that a PostgreSQL schema is not dropped", () => {
    const home = tmpHome();
    const warn = vi.fn();
    purgeLeftovers(runtime(home, {
      warn,
      readUserConfig: () => ({ storage: { provider: "postgres" } }),
    }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("PostgreSQL schema was not dropped"));
  });

  it("swallows embed-daemon and graph-hook failures", () => {
    const home = tmpHome();
    const warn = vi.fn();
    purgeLeftovers(runtime(home, {
      warn,
      killEmbedDaemon: () => { throw new Error("pid race"); },
      uninstallPostCommitHook: () => { throw new Error("not a git repo"); },
      readLocalManifest: () => { throw new Error("mined json"); },
    }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("pid race"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a git repo"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("mined json"));
  });

  it("logs graph hook outcomes and swallows unpull failures", () => {
    const home = tmpHome();
    const logs: string[] = [];
    const warn = vi.fn();
    purgeLeftovers(runtime(home, {
      log: line => { logs.push(line); },
      warn,
      loadManifest: () => { throw new Error("manifest boom"); },
      uninstallPostCommitHook: () => ({ kind: "removed", path: "/repo/.git/hooks/post-commit", wholeFileDeleted: true }),
    }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("manifest boom"));
    expect(logs.some(line => line.includes("removed post-commit hook"))).toBe(true);

    logs.length = 0;
    purgeLeftovers(runtime(home, {
      log: line => { logs.push(line); },
      uninstallPostCommitHook: () => ({
        kind: "not-ours",
        path: "/repo/.git/hooks/post-commit",
        hint: "foreign",
      }),
    }));
    expect(logs.some(line => line.includes("skipped foreign post-commit hook"))).toBe(true);
  });

  it("removes locally-mined skill dirs recorded in the local manifest, not hand-written skills", () => {
    const home = tmpHome();
    mkdirSync(join(home, ".claude", "skills", "mined-skill"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "mined-skill", "SKILL.md"), "mined\n");
    mkdirSync(join(home, ".claude", "skills", "my-own"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "my-own", "SKILL.md"), "hand\n");
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    const minedLink = join(home, ".agents", "skills", "mined-skill");
    writeFileSync(minedLink, "link\n");
    purgeLeftovers(runtime(home, {
      readLocalManifest: () => ({
        created_at: "t",
        entries: [
          {
            skill_name: "mined-skill",
            canonical_path: join(home, ".claude", "skills", "mined-skill"),
            symlinks: [minedLink, "/tmp/not-a-skill-path"],
            source_session_ids: [],
            source_session_paths: [],
            source_agent: "claude_code",
            gate_agent: "claude_code",
            created_at: "t",
            uploaded: false,
          },
        ],
      }),
    }));
    expect(existsSync(join(home, ".claude", "skills", "mined-skill"))).toBe(false);
    expect(existsSync(minedLink)).toBe(false);
    expect(existsSync("/tmp/not-a-skill-path")).toBe(false);
    expect(existsSync(join(home, ".claude", "skills", "my-own", "SKILL.md"))).toBe(true);
  });

  it("removes a custom MEMOREE_PKG_HOME staged copy", () => {
    const home = tmpHome();
    const staged = mkdtempSync(join(tmpdir(), "memoree-staged-"));
    homes.push(staged);
    writeFileSync(join(staged, "package.json"), "{}\n");
    purgeLeftovers(runtime(home, { stagedPackageHome: () => staged }));
    expect(existsSync(join(staged, "package.json"))).toBe(false);
  });
});
