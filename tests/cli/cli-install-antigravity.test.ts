import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setFakeHome, clearFakeHome } from "../shared/fake-home.js";

const execFileSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...a: unknown[]) => execFileSyncMock(...a),
}));

let tmpRoot: string;
let tmpHome: string;
let tmpPkg: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hm-agy-"));
  tmpHome = join(tmpRoot, "home");
  tmpPkg = join(tmpRoot, "pkg");
  mkdirSync(tmpHome, { recursive: true });
  mkdirSync(join(tmpPkg, "harnesses", "antigravity", "bundle"), { recursive: true });
  writeFileSync(join(tmpPkg, "harnesses", "antigravity", "bundle", "pre-invocation.js"), "// hook");
  writeFileSync(join(tmpPkg, "harnesses", "antigravity", "bundle", "mcp-server.js"), "// mcp");
  mkdirSync(join(tmpPkg, "harnesses", "antigravity", "skills", "memoree-memory"), { recursive: true });
  writeFileSync(join(tmpPkg, "harnesses", "antigravity", "skills", "memoree-memory", "SKILL.md"), "# Memoree");
  writeFileSync(join(tmpPkg, "harnesses", "antigravity", "plugin.json"), JSON.stringify({
    name: "memoree",
    description: "test",
  }));
  writeFileSync(join(tmpPkg, "package.json"), JSON.stringify({ version: "1.2.3" }));
  setFakeHome(tmpHome);
  execFileSyncMock.mockReset();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  clearFakeHome();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function importInstaller() {
  vi.resetModules();
  vi.doMock("../../src/cli/util.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/cli/util.js")>();
    return { ...actual, pkgRoot: () => tmpPkg };
  });
  return await import("../../src/cli/install-antigravity.js");
}

describe("installAntigravity", () => {
  it("stages the plugin, merges named hooks, and rewrites MCP to an absolute node path", async () => {
    const { installAntigravity, ANTIGRAVITY_HOOKS_PATH, ANTIGRAVITY_MCP_PATH, ANTIGRAVITY_PLUGIN_DIR } = await importInstaller();
    const otherHooks = join(tmpHome, ".gemini", "config", "hooks.json");
    mkdirSync(join(tmpHome, ".gemini", "config"), { recursive: true });
    writeFileSync(otherHooks, JSON.stringify({ "user-linter": { PostToolUse: [] } }));

    installAntigravity({ packageRoot: tmpPkg });

    expect(existsSync(join(ANTIGRAVITY_PLUGIN_DIR, "bundle", "pre-invocation.js"))).toBe(true);
    expect(existsSync(join(ANTIGRAVITY_PLUGIN_DIR, "skills", "memoree-memory", "SKILL.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(ANTIGRAVITY_PLUGIN_DIR, "plugin.json"), "utf-8")).name).toBe("memoree");
    expect(JSON.parse(readFileSync(join(ANTIGRAVITY_PLUGIN_DIR, "plugin.json"), "utf-8"))).not.toHaveProperty("version");

    const hooks = JSON.parse(readFileSync(ANTIGRAVITY_HOOKS_PATH, "utf-8"));
    expect(hooks["user-linter"]).toEqual({ PostToolUse: [] });
    expect(Object.keys(hooks.memoree).sort()).toEqual(["PostToolUse", "PreInvocation", "PreToolUse", "Stop"]);
    expect(hooks.memoree.PreInvocation[0].command).toContain("pre-invocation.js");
    expect(hooks.memoree.PreToolUse[0].matcher).toBe("*");

    const mcp = JSON.parse(readFileSync(ANTIGRAVITY_MCP_PATH, "utf-8"));
    expect(mcp.mcpServers.memoree.command).toBe("node");
    expect(mcp.mcpServers.memoree.args[0]).toBe(join(ANTIGRAVITY_PLUGIN_DIR, "bundle", "mcp-server.js"));
    expect(mcp.mcpServers.memoree.args[0]).not.toContain("$PLUGIN_ROOT");
    expect(ANTIGRAVITY_PLUGIN_DIR).toContain(join(".gemini", "config", "plugins", "memoree"));
    expect(existsSync(join(tmpHome, ".gemini", "antigravity-cli", "plugins"))).toBe(false);
    expect(JSON.parse(readFileSync(join(ANTIGRAVITY_PLUGIN_DIR, "bundle", "package.json"), "utf-8"))).toEqual({ type: "module" });
    const pluginInstall = execFileSyncMock.mock.calls.find(call => call[0] === "agy" && Array.isArray(call[1]) && call[1][0] === "plugin" && call[1][1] === "install");
    expect(pluginInstall?.[1]?.[2]).toBe(join(tmpPkg, "harnesses", "antigravity"));
    expect(pluginInstall?.[1]?.[2]).not.toBe(ANTIGRAVITY_PLUGIN_DIR);
  });

  it("is idempotent: a second install does not rewrite identical hooks.json", async () => {
    const { installAntigravity, ANTIGRAVITY_HOOKS_PATH } = await importInstaller();
    installAntigravity({ packageRoot: tmpPkg });
    const content1 = readFileSync(ANTIGRAVITY_HOOKS_PATH, "utf-8");
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(ANTIGRAVITY_HOOKS_PATH, past, past);
    installAntigravity({ packageRoot: tmpPkg });
    expect(readFileSync(ANTIGRAVITY_HOOKS_PATH, "utf-8")).toBe(content1);
    expect(statSync(ANTIGRAVITY_HOOKS_PATH).mtimeMs).toBe(past.getTime());
  });

  it("uninstall strips only the memoree named hook and MCP server", async () => {
    const { installAntigravity, uninstallAntigravity, ANTIGRAVITY_HOOKS_PATH, ANTIGRAVITY_MCP_PATH } = await importInstaller();
    mkdirSync(join(tmpHome, ".gemini", "config"), { recursive: true });
    writeFileSync(ANTIGRAVITY_HOOKS_PATH, JSON.stringify({ keep: { Stop: [] } }));
    writeFileSync(ANTIGRAVITY_MCP_PATH, JSON.stringify({
      mcpServers: { keep: { command: "echo" }, memoree: { command: "node" } },
    }));
    installAntigravity({ packageRoot: tmpPkg });
    uninstallAntigravity();
    const hooks = JSON.parse(readFileSync(ANTIGRAVITY_HOOKS_PATH, "utf-8"));
    expect(hooks.keep).toBeDefined();
    expect(hooks.memoree).toBeUndefined();
    const mcp = JSON.parse(readFileSync(ANTIGRAVITY_MCP_PATH, "utf-8"));
    expect(mcp.mcpServers.keep).toBeDefined();
    expect(mcp.mcpServers.memoree).toBeUndefined();
  });
});

describe("merge helpers", () => {
  it("replaces only the memoree key", async () => {
    const { mergeNamedHooks, mergeMcpServers, stripMcpServer, buildMemoreeHookBlock } = await importInstaller();
    const merged = mergeNamedHooks({ other: 1 }, buildMemoreeHookBlock());
    expect(merged.other).toBe(1);
    expect(merged.memoree).toHaveProperty("PreInvocation");
    const mcp = mergeMcpServers({ mcpServers: { sqlite: { command: "x" } } }, { command: "node" });
    expect(Object.keys(mcp.mcpServers as object).sort()).toEqual(["memoree", "sqlite"]);
    expect(stripMcpServer(mcp).mcpServers).toEqual({ sqlite: { command: "x" } });
    expect(stripMcpServer({}).mcpServers).toBeUndefined();
  });
});

describe("installAntigravity edge cases", () => {
  it("throws when the staged bundle is missing", async () => {
    const { installAntigravity } = await importInstaller();
    expect(() => installAntigravity({ packageRoot: join(tmpRoot, "missing") }))
      .toThrow(/Antigravity bundle missing/);
  });

  it("reports bundle presence and treats agy --version failure as unavailable", async () => {
    const { antigravityBundleExists, agyCliAvailable } = await importInstaller();
    expect(antigravityBundleExists(tmpPkg)).toBe(true);
    expect(antigravityBundleExists(join(tmpRoot, "nope"))).toBe(false);
    execFileSyncMock.mockImplementation(() => { throw new Error("missing"); });
    expect(agyCliAvailable()).toBe(false);
    execFileSyncMock.mockReturnValue("agy 1");
    expect(agyCliAvailable()).toBe(true);
  });

  it("ignores unparseable hooks.json and removes empty files on uninstall", async () => {
    const { installAntigravity, uninstallAntigravity, ANTIGRAVITY_HOOKS_PATH, ANTIGRAVITY_MCP_PATH } = await importInstaller();
    mkdirSync(join(tmpHome, ".gemini", "config"), { recursive: true });
    writeFileSync(ANTIGRAVITY_HOOKS_PATH, "{not json");
    writeFileSync(ANTIGRAVITY_MCP_PATH, "{not json");
    installAntigravity({ packageRoot: tmpPkg });
    uninstallAntigravity();
    expect(existsSync(ANTIGRAVITY_HOOKS_PATH)).toBe(false);
    expect(existsSync(ANTIGRAVITY_MCP_PATH)).toBe(false);
  });

  it("symlinks embed-deps into the plugin when present", async () => {
    const { installAntigravity, ANTIGRAVITY_PLUGIN_DIR } = await importInstaller();
    mkdirSync(join(tmpHome, ".memoree", "embed-deps", "node_modules"), { recursive: true });
    writeFileSync(join(tmpHome, ".memoree", "embed-deps", "node_modules", "ok"), "1");
    installAntigravity({ packageRoot: tmpPkg });
    expect(existsSync(join(ANTIGRAVITY_PLUGIN_DIR, "node_modules", "ok"))).toBe(true);
  });
});
