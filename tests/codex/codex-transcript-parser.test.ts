import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCodexTranscript } from "../../src/notifications/codex-transcript-parser.js";

let TEMP_DIR = "";

beforeEach(() => {
  TEMP_DIR = mkdtempSync(join(tmpdir(), "memoree-codex-transcript-test-"));
});

afterEach(() => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

function writeTranscript(lines: unknown[]): string {
  const file = join(TEMP_DIR, "rollout.jsonl");
  writeFileSync(
    file,
    lines.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n") + "\n",
    "utf8",
  );
  return file;
}

describe("parseCodexTranscript — robustness", () => {
  it("returns zeros + fallback id when the file does not exist", () => {
    const r = parseCodexTranscript("/tmp/does-not-exist-codex-rollout.jsonl", "fb-xyz");
    expect(r.memorySearchCount).toBe(0);
    expect(r.memorySearchBytes).toBe(0);
    expect(r.sessionId).toBe("fb-xyz");
  });

  it("returns zeros when transcriptPath is empty string", () => {
    const r = parseCodexTranscript("", "fb");
    expect(r.memorySearchBytes).toBe(0);
    expect(r.sessionId).toBe("fb");
  });

  it("skips malformed JSON lines and non-object values", () => {
    const path = writeTranscript([
      { type: "session_meta", payload: { session_id: "sess-1" } },
      "not-json",
      [1, 2, 3],
      42,
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          call_id: "c1",
          arguments: JSON.stringify({ command: "grep -r x ~/.memoree/memory/" }),
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "c1", output: "hit" },
      },
    ]);
    const r = parseCodexTranscript(path, "fb");
    expect(r.sessionId).toBe("sess-1");
    expect(r.memorySearchCount).toBe(1);
    expect(r.memorySearchBytes).toBe(Buffer.byteLength("hit", "utf8"));
  });

  it("falls back to `now` when no line carries a timestamp", () => {
    const path = writeTranscript([{ type: "session_meta", payload: { session_id: "s" } }]);
    const r = parseCodexTranscript(path, "fb", new Date("2026-05-13T11:11:11Z"));
    expect(r.endedAt).toBe("2026-05-13T11:11:11.000Z");
  });

  it("uses session_meta.payload.session_id and the last timestamp", () => {
    const path = writeTranscript([
      {
        timestamp: "2026-05-13T10:00:00Z",
        type: "session_meta",
        payload: { session_id: "codex-sess" },
      },
      {
        timestamp: "2026-05-13T10:01:00Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: "hi" },
      },
    ]);
    const r = parseCodexTranscript(path, "fb");
    expect(r.sessionId).toBe("codex-sess");
    expect(r.endedAt).toBe("2026-05-13T10:01:00Z");
  });
});

describe("parseCodexTranscript — function_call", () => {
  it("counts shell function_call + function_call_output with JSON-string arguments", () => {
    const result = "match1\nmatch2";
    const path = writeTranscript([
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          call_id: "call_1",
          arguments: JSON.stringify({ command: "grep -r foo ~/.memoree/memory/summaries" }),
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call_1", output: result },
      },
    ]);
    const r = parseCodexTranscript(path, "fb");
    expect(r.memorySearchCount).toBe(1);
    expect(r.memorySearchBytes).toBe(Buffer.byteLength(result, "utf8"));
  });

  it("accepts object arguments and command argv arrays", () => {
    const path = writeTranscript([
      {
        type: "function_call",
        name: "Bash",
        call_id: "call_2",
        arguments: { command: ["grep", "-r", "x", "/home/u/.memoree/memory"] },
      },
      {
        type: "function_call_output",
        call_id: "call_2",
        output: { output: "from-nested" },
      },
    ]);
    const r = parseCodexTranscript(path, "fb");
    expect(r.memorySearchCount).toBe(1);
    expect(r.memorySearchBytes).toBe(Buffer.byteLength("from-nested", "utf8"));
  });

  it("treats unparseable arguments as the command string", () => {
    const path = writeTranscript([
      {
        type: "function_call",
        call_id: "call_raw",
        arguments: "grep foo ~/.memoree/memory/index.md --not-json",
      },
      {
        type: "function_call_output",
        call_id: "call_raw",
        output: { stdout: "raw-hit" },
      },
    ]);
    expect(parseCodexTranscript(path, "fb").memorySearchCount).toBe(1);
    expect(parseCodexTranscript(path, "fb").memorySearchBytes).toBe(Buffer.byteLength("raw-hit", "utf8"));
  });

  it("reads cmd from parsed arguments and callId camelCase", () => {
    const path = writeTranscript([
      {
        type: "function_call",
        callId: "call_cmd",
        arguments: { cmd: "cat ~/.memoree/memory/index.md" },
      },
      {
        type: "function_call_output",
        callId: "call_cmd",
        output: { text: "idx" },
      },
    ]);
    expect(parseCodexTranscript(path, "fb").memorySearchCount).toBe(1);
    expect(parseCodexTranscript(path, "fb").memorySearchBytes).toBe(Buffer.byteLength("idx", "utf8"));
  });

  it("ignores function_call commands that do not reference the memory path", () => {
    const path = writeTranscript([
      {
        type: "function_call",
        call_id: "call_ls",
        arguments: JSON.stringify({ command: "ls /tmp" }),
      },
      {
        type: "function_call_output",
        call_id: "call_ls",
        output: "file1\nfile2\n",
      },
    ]);
    const r = parseCodexTranscript(path, "fb");
    expect(r.memorySearchCount).toBe(0);
    expect(r.memorySearchBytes).toBe(0);
  });

  it("reads payload.command, mixed argv, and call_id from the wrapping item", () => {
    const path = writeTranscript([
      {
        type: "session_meta",
        session_id: "item-sess",
        payload: {},
      },
      {
        call_id: "from-item",
        payload: {
          type: "function_call",
          command: ["grep", 1, "-r", "x", "/home/u/.memoree/memory"],
        },
      },
      {
        call_id: "from-item",
        payload: { type: "function_call_output", output: "ok" },
      },
    ]);
    const r = parseCodexTranscript(path, "fb");
    expect(r.sessionId).toBe("item-sess");
    expect(r.memorySearchCount).toBe(1);
    expect(r.memorySearchBytes).toBe(Buffer.byteLength("ok", "utf8"));
  });

  it("counts an orphan memory lookup with 0 bytes", () => {
    const path = writeTranscript([
      {
        type: "function_call",
        call_id: "orphan",
        arguments: { command: "grep foo ~/.memoree/memory/" },
      },
    ]);
    const r = parseCodexTranscript(path, "fb");
    expect(r.memorySearchCount).toBe(1);
    expect(r.memorySearchBytes).toBe(0);
  });

  it("dedupes function_call and exec_command events that share a call_id", () => {
    const output = "one-shell-hit";
    const path = writeTranscript([
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          call_id: "shared_1",
          arguments: JSON.stringify({ command: "grep -r foo ~/.memoree/memory/" }),
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "exec_command_begin",
          call_id: "shared_1",
          command: ["bash", "-lc", "grep -r foo ~/.memoree/memory/"],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "exec_command_end",
          call_id: "shared_1",
          aggregated_output: output,
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "shared_1", output: output },
      },
    ]);
    const r = parseCodexTranscript(path, "fb");
    expect(r.memorySearchCount).toBe(1);
    expect(r.memorySearchBytes).toBe(Buffer.byteLength(output, "utf8"));
  });

  it("keeps distinct call_ids as separate memory searches", () => {
    const path = writeTranscript([
      {
        type: "function_call",
        call_id: "a",
        arguments: { command: "cat ~/.memoree/memory/a.md" },
      },
      {
        type: "function_call_output",
        call_id: "a",
        output: "A",
      },
      {
        type: "exec_command_begin",
        call_id: "b",
        command: "cat ~/.memoree/memory/b.md",
      },
      {
        type: "exec_command_end",
        call_id: "b",
        stdout: "B",
      },
    ]);
    const r = parseCodexTranscript(path, "fb");
    expect(r.memorySearchCount).toBe(2);
    expect(r.memorySearchBytes).toBe(
      Buffer.byteLength("A", "utf8") + Buffer.byteLength("B", "utf8"),
    );
  });
});

describe("parseCodexTranscript — exec_command events", () => {
  it("joins argv from exec_command_begin and counts aggregated_output", () => {
    const output = "summary line";
    const path = writeTranscript([
      {
        type: "event_msg",
        payload: {
          type: "exec_command_begin",
          call_id: "exec_1",
          command: ["bash", "-lc", "grep -r observatory ~/.memoree/memory/summaries/"],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "exec_command_end",
          call_id: "exec_1",
          aggregated_output: output,
        },
      },
    ]);
    const r = parseCodexTranscript(path, "fb");
    expect(r.memorySearchCount).toBe(1);
    expect(r.memorySearchBytes).toBe(Buffer.byteLength(output, "utf8"));
  });

  it("falls back through formatted_output, stdout, and content", () => {
    const path = writeTranscript([
      {
        type: "exec_command_begin",
        call_id: "a",
        command: "cat ~/.memoree/memory/a.md",
      },
      {
        type: "exec_command_end",
        call_id: "a",
        formatted_output: "A",
      },
      {
        type: "exec_command_begin",
        call_id: "b",
        cmd: "cat ~/.memoree/memory/b.md",
      },
      {
        type: "exec_command_end",
        call_id: "b",
        stdout: "B",
      },
      {
        type: "custom_tool_call",
        call_id: "c",
        command: "cat ~/.memoree/memory/c.md",
      },
      {
        type: "custom_tool_call_output",
        call_id: "c",
        content: "C",
      },
    ]);
    const r = parseCodexTranscript(path, "fb");
    expect(r.memorySearchCount).toBe(3);
    expect(r.memorySearchBytes).toBe(
      Buffer.byteLength("A", "utf8") + Buffer.byteLength("B", "utf8") + Buffer.byteLength("C", "utf8"),
    );
  });

  it("stringifies unknown output objects without throwing", () => {
    const path = writeTranscript([
      {
        type: "function_call",
        call_id: "w",
        arguments: { command: "cat ~/.memoree/memory/index.md" },
      },
      {
        type: "function_call_output",
        call_id: "w",
        output: { weird: "shape", n: 42 },
      },
    ]);
    expect(() => parseCodexTranscript(path, "fb")).not.toThrow();
    expect(parseCodexTranscript(path, "fb").memorySearchBytes).toBeGreaterThan(0);
  });

  it("uses payload.timestamp and top-level call_id when nested ids are missing", () => {
    const path = writeTranscript([
      {
        payload: { timestamp: "2026-05-13T12:00:00Z", type: "session_meta", session_id: "from-payload" },
      },
      {
        type: "function_call",
        call_id: "top",
        arguments: { command: "grep x ~/.memoree/memory/" },
      },
      {
        type: "function_call_output",
        call_id: "top",
        output: "",
        content: [{ type: "text", text: "parts" }],
      },
    ]);
    const r = parseCodexTranscript(path, "fb");
    expect(r.sessionId).toBe("from-payload");
    expect(r.endedAt).toBe("2026-05-13T12:00:00Z");
    expect(r.memorySearchBytes).toBe(Buffer.byteLength("parts", "utf8"));
  });
});
