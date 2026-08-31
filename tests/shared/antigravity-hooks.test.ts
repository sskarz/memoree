import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearFakeHome, setFakeHome } from "./fake-home.js";
import { decidePreToolUse } from "../../src/hooks/antigravity/pre-tool-use.js";
import {
  MEMORY_STEER,
  eventNameFromArgv,
  sessionIdOf,
  toolPayloadTouchesMemory,
  workspaceCwd,
} from "../../src/hooks/antigravity/payload.js";
import {
  claimFirstInvocation,
  lastTurn,
  parseTranscriptJsonl,
  readTranscriptTurns,
  takeNewUserPrompt,
} from "../../src/hooks/antigravity/transcript.js";
import { isFirstModelCall, processPreInvocation } from "../../src/hooks/antigravity/pre-invocation.js";
import { processStop, stopDecision } from "../../src/hooks/antigravity/stop.js";

describe("Antigravity hook adapters", () => {
  let home: string;
  const priorWiki = process.env.MEMOREE_WIKI_WORKER;

  afterEach(() => {
    clearFakeHome();
    if (home) rmSync(home, { recursive: true, force: true });
    if (priorWiki === undefined) delete process.env.MEMOREE_WIKI_WORKER;
    else process.env.MEMOREE_WIKI_WORKER = priorWiki;
  });

  it("steers memory-touching tools and leaves others alone", () => {
    expect(decidePreToolUse({
      toolCall: { name: "run_command", args: { CommandLine: "ls /tmp" } },
    })).toEqual({});
    const denied = decidePreToolUse({
      toolCall: { name: "run_command", args: { CommandLine: "cat ~/.memoree/memory/identity.json" } },
    });
    expect(denied).toEqual({ decision: "deny", reason: MEMORY_STEER });
    expect(denied).not.toHaveProperty("allow");
    expect(toolPayloadTouchesMemory(
      { toolCall: { name: "view_file", args: { AbsolutePath: "/home/x/.memoree/memory/rules.md" } } },
      (value) => value.includes(".memoree/memory"),
    )).toBe(true);
  });

  it("parses transcript JSONL including array/object text shapes", () => {
    home = mkdtempSync(join(tmpdir(), "agy-hooks-"));
    setFakeHome(home);
    const turns = parseTranscriptJsonl([
      JSON.stringify({ role: "user", text: "hello" }),
      "not-json",
      JSON.stringify({ role: "assistant", content: "hi" }),
      JSON.stringify({ role: "user", content: [{ type: "text", text: "parts" }] }),
      JSON.stringify({ kind: "model", message: { text: "from-object" } }),
      JSON.stringify({ type: "system", text: "ignore" }),
    ].join("\n"));
    expect(lastTurn(turns, "user")).toBe("parts");
    expect(lastTurn(turns, "assistant")).toBe("from-object");
    expect(claimFirstInvocation("conv-1")).toBe(true);
    expect(claimFirstInvocation("conv-1")).toBe(false);
    expect(takeNewUserPrompt("conv-1", "hello")).toBe("hello");
    expect(takeNewUserPrompt("conv-1", "hello")).toBeNull();
    expect(takeNewUserPrompt("conv-1", "   ")).toBeNull();
  });

  it("treats invocation 0 and 1 as the first model call", () => {
    expect(isFirstModelCall(0)).toBe(true);
    expect(isFirstModelCall(1)).toBe(true);
    expect(isFirstModelCall(2)).toBe(false);
    expect(eventNameFromArgv(["node", "pre-tool-use.js", "PreToolUse"])).toBe("PreToolUse");
    expect(eventNameFromArgv(["node"])).toBe("");
    expect(workspaceCwd({})).toBe(process.cwd());
    expect(workspaceCwd({ workspacePaths: ["  /repo  "] })).toBe("/repo");
    expect(sessionIdOf({})).toBe("unknown");
    expect(sessionIdOf({ conversationId: "  abc  " })).toBe("abc");
  });

  it("Stop stdout never continues the loop", () => {
    expect(stopDecision()).toEqual({ decision: "stop" });
  });

  it("processStop returns stop when wiki-worker env is set or session is missing", async () => {
    process.env.MEMOREE_WIKI_WORKER = "1";
    expect(await processStop({ conversationId: "c" })).toEqual({ decision: "stop" });
    delete process.env.MEMOREE_WIKI_WORKER;
    expect(await processStop({})).toEqual({ decision: "stop" });
  });

  it("reads a transcript file when present", () => {
    home = mkdtempSync(join(tmpdir(), "agy-transcript-"));
    const file = join(home, "transcript.jsonl");
    writeFileSync(file, `${JSON.stringify({ role: "user", text: "recall this" })}\n`);
    expect(readTranscriptTurns(file)[0]?.text).toBe("recall this");
    expect(readTranscriptTurns("/nope.jsonl")).toEqual([]);
  });

  it("processPreInvocation returns {} for wiki workers and injects on first call", async () => {
    process.env.MEMOREE_WIKI_WORKER = "1";
    expect(await processPreInvocation({ conversationId: "c", invocationNum: 0 })).toEqual({});
    delete process.env.MEMOREE_WIKI_WORKER;
    home = mkdtempSync(join(tmpdir(), "agy-preinv-"));
    setFakeHome(home);
    const transcript = join(home, "t.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ role: "user", text: "remember harbor-kite" })}\n`);
    const first = await processPreInvocation({
      conversationId: "conv-inject",
      invocationNum: 0,
      workspacePaths: [home],
      transcriptPath: transcript,
    });
    expect(JSON.stringify(first)).toContain("memoree_read");
    expect(first.injectSteps).toEqual(expect.any(Array));
    const later = await processPreInvocation({
      conversationId: "conv-inject",
      invocationNum: 4,
      workspacePaths: [home],
      transcriptPath: transcript,
    });
    expect(later).toEqual({});
  });
});
