import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  extractLastAssistantFromCodexTranscript,
  resolveCodexAssistantMessage,
} from "../../src/hooks/codex/transcript.js";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeTranscript(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-transcript-"));
  dirs.push(dir);
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

describe("extractLastAssistantFromCodexTranscript", () => {
  it("returns empty for a missing path", () => {
    expect(extractLastAssistantFromCodexTranscript(undefined)).toBe("");
    expect(extractLastAssistantFromCodexTranscript(null)).toBe("");
    expect(extractLastAssistantFromCodexTranscript("/no/such/transcript.jsonl")).toBe("");
  });

  it("extracts nested payload assistant text from Codex JSONL", () => {
    const path = writeTranscript([
      JSON.stringify({ type: "response_item", payload: { role: "user", content: "hello" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          role: "assistant",
          content: [{ type: "output_text", text: "fixed the matcher" }],
        },
      }),
    ]);
    expect(extractLastAssistantFromCodexTranscript(path)).toBe("fixed the matcher");
  });

  it("joins text blocks and prefers the last assistant line", () => {
    const path = writeTranscript([
      JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
      }),
      JSON.stringify({ role: "assistant", content: "later" }),
    ]);
    expect(extractLastAssistantFromCodexTranscript(path)).toBe("later");
  });

  it("skips malformed lines", () => {
    const path = writeTranscript([
      "not-json",
      JSON.stringify({ role: "assistant", content: "ok" }),
    ]);
    expect(extractLastAssistantFromCodexTranscript(path)).toBe("ok");
  });

  it("truncates to 4000 characters", () => {
    const path = writeTranscript([
      JSON.stringify({ role: "assistant", content: "x".repeat(5000) }),
    ]);
    expect(extractLastAssistantFromCodexTranscript(path).length).toBe(4000);
  });
});

describe("resolveCodexAssistantMessage", () => {
  it("prefers last_assistant_message from the hook payload", () => {
    const path = writeTranscript([
      JSON.stringify({ role: "assistant", content: "from transcript" }),
    ]);
    expect(resolveCodexAssistantMessage({
      last_assistant_message: "  from payload  ",
      transcript_path: path,
    })).toBe("from payload");
  });

  it("falls back to the subagent transcript before the parent transcript", () => {
    const parent = writeTranscript([
      JSON.stringify({ role: "assistant", content: "parent" }),
    ]);
    const agent = writeTranscript([
      JSON.stringify({ role: "assistant", content: "subagent" }),
    ]);
    expect(resolveCodexAssistantMessage({
      agent_transcript_path: agent,
      transcript_path: parent,
    })).toBe("subagent");
  });
});
