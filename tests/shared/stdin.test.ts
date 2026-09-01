import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readStdin, tryParseJsonValue } from "../../src/utils/stdin.js";

describe("hook stdin JSON", () => {
  it("does not early-parse incomplete or scalar prefixes", () => {
    expect(tryParseJsonValue("{}")).toEqual({});
    expect(tryParseJsonValue('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJsonValue("[1]")).toEqual([1]);
    expect(tryParseJsonValue("{")).toBeUndefined();
    expect(tryParseJsonValue("")).toBeUndefined();
    expect(tryParseJsonValue("1")).toBeUndefined();
    expect(tryParseJsonValue("null")).toBeUndefined();
  });

  it("resolves when a JSON object arrives without stdin EOF", async () => {
    const stream = new PassThrough();
    const pending = readStdin<{ conversationId: string }>(stream);
    stream.write('{"conversationId":"hung-pipe"}\n');
    await expect(pending).resolves.toEqual({ conversationId: "hung-pipe" });
    expect(stream.readableEnded).toBe(false);
  });

  it("assembles a JSON object from multiple chunks before EOF", async () => {
    const stream = new PassThrough();
    const pending = readStdin<{ a: number }>(stream);
    stream.write("{");
    stream.write('"a":');
    stream.write("2}");
    await expect(pending).resolves.toEqual({ a: 2 });
  });

  it("rejects invalid JSON once stdin ends", async () => {
    const stream = new PassThrough();
    const pending = readStdin(stream);
    stream.end("not-json");
    await expect(pending).rejects.toThrow(/Failed to parse hook input/);
  });

  it("rejects when the stream errors before a complete object", async () => {
    const stream = new PassThrough();
    const pending = readStdin(stream);
    stream.destroy(new Error("boom"));
    await expect(pending).rejects.toThrow(/boom/);
  });

  it("parses a complete object delivered with end() and accepts Buffer chunks", async () => {
    const ended = new PassThrough();
    const endedPending = readStdin<{ ok: boolean }>(ended);
    ended.end('{"ok":true}');
    await expect(endedPending).resolves.toEqual({ ok: true });

    const buffered = new PassThrough();
    const bufferedPending = readStdin<{ ok: boolean }>(buffered);
    buffered.write(Buffer.from('{"ok":true}'));
    await expect(bufferedPending).resolves.toEqual({ ok: true });
  });

  it("parses a scalar only after stdin ends", async () => {
    const stream = new PassThrough();
    const pending = readStdin<number>(stream);
    stream.end("1");
    await expect(pending).resolves.toBe(1);
  });
});
