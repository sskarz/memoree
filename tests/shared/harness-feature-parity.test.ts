/**
 * Claude Code vs Codex vs Antigravity product-capability lock.
 *
 * Platform differences that are not gaps:
 *   - Claude PreToolUse has no matcher (Bash/Read/Grep/Glob). Codex matches
 *     Bash only — Codex documents shell / exec_command as tool_name "Bash".
 *   - Claude SessionEnd also runs plugin-cache-gc (Claude marketplace cache).
 *   - Codex SessionEnd is advisory and capped at 3s, so graph-on-stop stays
 *     on Stop (30s). Wiki spawn is a fast detach and runs on SessionEnd too.
 *   - Codex keeps a silent AGENTS.md block because SessionStart
 *     additionalContext has historically rendered in the TUI.
 *   - Antigravity has no SessionStart / UserPromptSubmit / SessionEnd /
 *     SubagentStop. PreInvocation covers inject+recall+user capture; Stop
 *     covers wiki; PostToolUse covers tool capture; MCP covers the VFS.
 *
 * Shared product events Claude and Codex must wire: SessionStart, UserPromptSubmit
 * (capture + recall), PreToolUse VFS, PostToolUse capture, Stop, SubagentStop
 * capture, SessionEnd wiki.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CODEX_AGENTS_BLOCK, CODEX_SESSION_START_MATCHER } from "../../src/cli/install-codex.js";
import { MEMORY_COMMAND_GUIDANCE, MEMORY_SANDBOXED_COMMANDS } from "../../src/hooks/shared/memory-command-contract.js";
import { ANTIGRAVITY_MEMORY_CONTEXT } from "../../src/hooks/antigravity/pre-invocation.js";
import { MEMORY_STEER } from "../../src/hooks/antigravity/payload.js";
import { MEMOREE_MCP_TOOL_NAMES, SANDBOXED_COMMAND_MCP_TOOLS, MCP_TOOL_JOBS, MCP_TOOL_UNIQUENESS } from "../../src/mcp/vfs-tools.js";

const ROOT = process.cwd();

/** Events Codex currently documents (developers.openai.com/codex/hooks). */
const CODEX_DOCUMENTED_EVENTS = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "UserPromptSubmit",
  "SubagentStop",
  "Stop",
  "SessionStart",
  "SubagentStart",
  "SessionEnd",
] as const;

const SHARED_PRODUCT_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "SessionEnd",
] as const;

interface HookCommand {
  command: string;
  timeout?: number;
}

interface HookBlock {
  matcher?: string;
  hooks?: HookCommand[];
}

interface HooksFile {
  hooks: Record<string, HookBlock[]>;
}

function loadHooks(rel: string): HooksFile {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf-8")) as HooksFile;
}

function bundleFile(command: string): string | undefined {
  const match = command.replace(/\\/g, "/").match(/bundle\/([\w.-]+\.js)/);
  return match?.[1];
}

function filesFor(hooks: HooksFile, event: string): string[] {
  const blocks = hooks.hooks[event] ?? [];
  return blocks.flatMap(block => (block.hooks ?? [])
    .map(hook => bundleFile(hook.command))
    .filter((name): name is string => Boolean(name)));
}

function timeoutsFor(hooks: HooksFile, event: string, file: string): number[] {
  const blocks = hooks.hooks[event] ?? [];
  return blocks.flatMap(block => (block.hooks ?? [])
    .filter(hook => bundleFile(hook.command) === file)
    .map(hook => hook.timeout)
    .filter((n): n is number => typeof n === "number"));
}

describe("Claude Code and Codex hook feature parity", () => {
  const claude = loadHooks("harnesses/claude-code/hooks/hooks.json");
  const codex = loadHooks("harnesses/codex/hooks/hooks.json");
  const esbuild = readFileSync(join(ROOT, "esbuild.config.mjs"), "utf-8");
  const installSrc = readFileSync(join(ROOT, "src/cli/install-codex.ts"), "utf-8");
  const recallSrc = readFileSync(join(ROOT, "src/hooks/recall.ts"), "utf-8");

  it("only uses Codex events that the current Codex hooks docs name", () => {
    for (const event of Object.keys(codex.hooks)) {
      expect(CODEX_DOCUMENTED_EVENTS, event).toContain(event);
    }
  });

  it("wires every shared product event on both harnesses", () => {
    for (const event of SHARED_PRODUCT_EVENTS) {
      expect(claude.hooks[event], `Claude missing ${event}`).toBeDefined();
      expect(codex.hooks[event], `Codex missing ${event}`).toBeDefined();
    }
  });

  it("captures user prompts and injects proactive recall on both harnesses", () => {
    expect(filesFor(claude, "UserPromptSubmit")).toEqual(
      expect.arrayContaining(["capture.js", "recall.js"]),
    );
    expect(filesFor(codex, "UserPromptSubmit")).toEqual(
      expect.arrayContaining(["capture.js", "recall.js"]),
    );
    expect(timeoutsFor(codex, "UserPromptSubmit", "recall.js")).toEqual([2]);
  });

  it("emits Codex-documented UserPromptSubmit additionalContext JSON from recall.js", () => {
    // developers.openai.com/codex/hooks UserPromptSubmit output:
    // { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }
    expect(recallSrc).toContain('hookEventName: "UserPromptSubmit"');
    expect(recallSrc).toContain("additionalContext");
  });

  it("intercepts PreToolUse for VFS on both harnesses", () => {
    expect(filesFor(claude, "PreToolUse")).toContain("pre-tool-use.js");
    expect(filesFor(codex, "PreToolUse")).toContain("pre-tool-use.js");
    expect(codex.hooks.PreToolUse[0].matcher).toBe("Bash");
  });

  it("captures PostToolUse, Stop, and SubagentStop on both harnesses", () => {
    expect(filesFor(claude, "PostToolUse")).toContain("capture.js");
    expect(filesFor(codex, "PostToolUse")).toContain("capture.js");
    expect(filesFor(claude, "SubagentStop")).toContain("capture.js");
    expect(filesFor(codex, "SubagentStop")).toContain("capture.js");
    expect(filesFor(claude, "Stop")).toEqual(
      expect.arrayContaining(["capture.js", "graph-on-stop.js"]),
    );
    expect(filesFor(codex, "Stop")).toEqual(
      expect.arrayContaining(["stop.js", "graph-on-stop.js"]),
    );
  });

  it("runs SessionEnd wiki on both harnesses", () => {
    expect(filesFor(claude, "SessionEnd")).toContain("session-end.js");
    expect(filesFor(codex, "SessionEnd")).toContain("session-end.js");
    expect(timeoutsFor(codex, "SessionEnd", "session-end.js")).toEqual([3]);
    expect(filesFor(claude, "SessionEnd")).toContain("plugin-cache-gc.js");
    expect(filesFor(codex, "SessionEnd")).not.toContain("plugin-cache-gc.js");
  });

  it("matches Codex SessionStart sources documented as startup|resume|clear|compact", () => {
    expect(CODEX_SESSION_START_MATCHER.split("|").sort()).toEqual(
      ["clear", "compact", "resume", "startup"],
    );
    expect(codex.hooks.SessionStart[0].matcher).toBe(CODEX_SESSION_START_MATCHER);
    expect(filesFor(codex, "SessionStart")).toContain("session-start.js");
    expect(filesFor(claude, "SessionStart")).toEqual(
      expect.arrayContaining(["session-start.js", "session-start-setup.js"]),
    );
  });

  it("keeps the Codex AGENTS.md memory-command contract as the silent standing brief", () => {
    expect(CODEX_AGENTS_BLOCK).toContain(MEMORY_COMMAND_GUIDANCE);
    expect(CODEX_AGENTS_BLOCK).toContain("~/.memoree/memory/");
  });

  it("builds recall.js and session-end.js into the Codex bundle", () => {
    expect(esbuild).toContain('["src/hooks/codex/session-end", "session-end"]');
    const recallInCodex = esbuild.indexOf("const codexEntries") < esbuild.indexOf('["src/hooks/recall", "recall"]', esbuild.indexOf("const codexEntries"));
    expect(recallInCodex).toBe(true);
    expect(installSrc).toContain('file: "recall.js"');
    expect(installSrc).toContain('hookCmd("session-end.js", 3)');
    expect(installSrc).toContain("SubagentStop");
  });
});

interface AntigravityHooksFile {
  memoree: Record<string, Array<{ command?: string; timeout?: number; matcher?: string; hooks?: Array<{ command?: string; timeout?: number }> }>>;
}

function antigravityBundleFiles(hooks: AntigravityHooksFile, event: string): string[] {
  const blocks = hooks.memoree[event] ?? [];
  return blocks.flatMap(block => {
    const commands = block.hooks?.map(hook => hook.command) ?? (block.command ? [block.command] : []);
    return commands
      .map(command => bundleFile(command ?? ""))
      .filter((name): name is string => Boolean(name));
  });
}

describe("Antigravity product-capability parity with Claude Code and Codex", () => {
  const agy = JSON.parse(
    readFileSync(join(ROOT, "harnesses/antigravity/hooks/hooks.json"), "utf-8"),
  ) as AntigravityHooksFile;
  const esbuild = readFileSync(join(ROOT, "esbuild.config.mjs"), "utf-8");
  const wikiSpawn = readFileSync(join(ROOT, "src/hooks/wiki-worker-spawn.ts"), "utf-8");
  const skill = readFileSync(join(ROOT, "harnesses/antigravity/skills/memoree-memory/SKILL.md"), "utf-8");
  const graphSkill = readFileSync(join(ROOT, "harnesses/antigravity/skills/memoree-graph/SKILL.md"), "utf-8");
  const goalsSkill = readFileSync(join(ROOT, "harnesses/antigravity/skills/memoree-goals/SKILL.md"), "utf-8");

  const documented = ["PreInvocation", "PreToolUse", "PostToolUse", "PostInvocation", "Stop"] as const;

  it("only uses Antigravity events the CLI hook docs name", () => {
    for (const event of Object.keys(agy.memoree)) {
      expect(documented, event).toContain(event);
    }
  });

  it("maps every Claude/Codex product job onto an Antigravity event or MCP tool", () => {
    expect(Object.keys(agy.memoree).sort()).toEqual(["PostToolUse", "PreInvocation", "PreToolUse", "Stop"]);
    expect(antigravityBundleFiles(agy, "PreInvocation")).toContain("pre-invocation.js");
    expect(antigravityBundleFiles(agy, "PreToolUse")).toContain("pre-tool-use.js");
    expect(antigravityBundleFiles(agy, "PostToolUse")).toContain("capture.js");
    expect(antigravityBundleFiles(agy, "Stop")).toEqual(
      expect.arrayContaining(["stop.js", "graph-on-stop.js"]),
    );
  });

  it("covers the full sandboxed VFS command set through MCP tools", () => {
    for (const command of MEMORY_SANDBOXED_COMMANDS) {
      expect(SANDBOXED_COMMAND_MCP_TOOLS[command], command).toMatch(/^memoree_/);
    }
    for (const name of MEMOREE_MCP_TOOL_NAMES) {
      expect(ANTIGRAVITY_MEMORY_CONTEXT).toContain(name);
      expect(MEMORY_STEER).toContain(name);
      expect(skill).toContain(name);
      expect(MCP_TOOL_JOBS[name].length).toBeGreaterThan(20);
      expect(MCP_TOOL_UNIQUENESS[name].unlike.length).toBeGreaterThan(20);
    }
  });

  it("injects memory context and recall from PreInvocation instead of SessionStart/UserPromptSubmit", () => {
    expect(ANTIGRAVITY_MEMORY_CONTEXT).toContain(MEMORY_COMMAND_GUIDANCE);
    const preSrc = readFileSync(join(ROOT, "src/hooks/antigravity/pre-invocation.ts"), "utf-8");
    expect(preSrc).toContain("session-start-setup.js");
    expect(preSrc).toContain("captureAntigravityEvent");
    expect(preSrc).toContain("recallTopHit");
    expect(preSrc).toContain("injectSteps");
    expect(preSrc).toContain("autoPullSkills");
    expect(preSrc).toContain("maybeAutoMineLocal");
    expect(preSrc).toContain("maybeAutoBackfillMemory");
    expect(preSrc).toContain("spawnGraphPullWorker");
    expect(preSrc).toContain('isDirectRun(import.meta.url, "pre-invocation")');
  });

  it("runs wiki and skillify end-of-session work on Stop (no SessionEnd event)", () => {
    const stopSrc = readFileSync(join(ROOT, "src/hooks/antigravity/stop.ts"), "utf-8");
    expect(stopSrc).toContain("forceSessionEndTrigger");
    expect(stopSrc).toContain("spawnAntigravityWikiWorker");
    expect(stopSrc).toContain("captureAntigravityEvent");
    expect(stopSrc).toContain('isDirectRun(import.meta.url, "stop")');
    expect(wikiSpawn).toContain("buildAgyInvocation");
    expect(wikiSpawn).toContain("--dangerously-skip-permissions");
    expect(agy.memoree.SessionEnd).toBeUndefined();
    expect(agy.memoree.SubagentStop).toBeUndefined();
  });

  it("ships memory, graph, and goals skills plus MCP/wiki/setup bundles", () => {
    expect(existsSync(join(ROOT, "harnesses/antigravity/skills/memoree-memory/SKILL.md"))).toBe(true);
    expect(graphSkill).toContain("memoree_read path=\"graph/query/");
    expect(goalsSkill).toContain("memoree_write");
    expect(esbuild).toContain('["src/mcp/server", "mcp-server"]');
    expect(esbuild).toContain('["src/hooks/antigravity/wiki-worker", "wiki-worker"]');
    expect(esbuild).toContain('["src/hooks/antigravity/session-start-setup", "session-start-setup"]');
    expect(esbuild).toContain("buildGraphOnStop(\"harnesses/antigravity/bundle\")");
  });

  it("speaks official MCP NDJSON stdio and installs into config/plugins", () => {
    const mcpSrc = readFileSync(join(ROOT, "src/mcp/server.ts"), "utf-8");
    const installSrc = readFileSync(join(ROOT, "src/cli/install-antigravity.ts"), "utf-8");
    expect(mcpSrc).toContain('framing === "ndjson"');
    expect(mcpSrc).toContain("content-length");
    expect(mcpSrc).toContain("await captureMcpToolCall");
    expect(mcpSrc).toContain("if (!process.env.VITEST)");
    const sessionCaptureSrc = readFileSync(join(ROOT, "src/mcp/session-capture.ts"), "utf-8");
    expect(sessionCaptureSrc).toContain("{ embed: false }");
    const captureSrc = readFileSync(join(ROOT, "src/hooks/antigravity/capture.ts"), "utf-8");
    expect(captureSrc).toContain("isMemoreeMcpToolCall");
    expect(captureSrc).toContain('isDirectRun(import.meta.url, "capture")');
    const preToolSrc = readFileSync(join(ROOT, "src/hooks/antigravity/pre-tool-use.ts"), "utf-8");
    expect(preToolSrc).toContain('isDirectRun(import.meta.url, "pre-tool-use")');
    expect(installSrc).toContain('"config", "plugins", "memoree"');
    expect(installSrc).toContain("antigravity-cli");
    expect(installSrc).toContain('{"type":"module"}');
    expect(installSrc).toContain("ANTIGRAVITY_LEGACY_HOOKS_PATH");
    expect(installSrc).toContain("ANTIGRAVITY_HOOK_JSON_PATHS");
    expect(installSrc).not.toContain('plugin", "install", ANTIGRAVITY_PLUGIN_DIR');
    const utilSrc = readFileSync(join(ROOT, "src/cli/util.ts"), "utf-8");
    expect(utilSrc).toContain("isAntigravityHome");
    expect(utilSrc).toContain("antigravity-cli");
    expect(utilSrc).not.toMatch(/\{ id: "antigravity", markerDir: join\(HOME, "\.gemini"\) \}/);
  });
});

