/**
 * Claude Code vs Codex product-capability lock.
 *
 * Platform differences that are not gaps:
 *   - Claude PreToolUse has no matcher (Bash/Read/Grep/Glob). Codex matches
 *     Bash only — Codex documents shell / exec_command as tool_name "Bash".
 *   - Claude SessionEnd also runs plugin-cache-gc (Claude marketplace cache).
 *   - Codex SessionEnd is advisory and capped at 3s, so graph-on-stop stays
 *     on Stop (30s). Wiki spawn is a fast detach and runs on SessionEnd too.
 *   - Codex keeps a silent AGENTS.md block because SessionStart
 *     additionalContext has historically rendered in the TUI.
 *
 * Shared product events both harnesses must wire: SessionStart, UserPromptSubmit
 * (capture + recall), PreToolUse VFS, PostToolUse capture, Stop, SubagentStop
 * capture, SessionEnd wiki.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CODEX_AGENTS_BLOCK, CODEX_SESSION_START_MATCHER } from "../../src/cli/install-codex.js";
import { MEMORY_COMMAND_GUIDANCE } from "../../src/hooks/shared/memory-command-contract.js";

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
