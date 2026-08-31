import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Direct source-level tests for src/hooks/codex/session-end.ts.
 * Mirrors tests/claude-code/session-end-hook.test.ts: main() runs on import.
 */

const stdinMock = vi.fn();
const loadConfigMock = vi.fn();
const spawnMock = vi.fn();
const wikiLogMock = vi.fn();
const tryAcquireLockMock = vi.fn();
const releaseLockMock = vi.fn();
const markSessionEndedMock = vi.fn();
const parseCodexTranscriptMock = vi.fn();
const appendUsageRecordMock = vi.fn();
const debugLogMock = vi.fn();
const forceSessionEndTriggerMock = vi.fn();
const pluginEnabledMock = vi.fn(() => true);

vi.mock("../../src/utils/stdin.js", () => ({ readStdin: (...a: unknown[]) => stdinMock(...a) }));
vi.mock("../../src/config.js", () => ({ loadConfig: (...a: unknown[]) => loadConfigMock(...a) }));
vi.mock("../../src/utils/plugin-state.js", () => ({
  isMemoreePluginEnabled: () => pluginEnabledMock(),
}));
vi.mock("../../src/skillify/triggers.js", () => ({
  forceSessionEndTrigger: (...a: unknown[]) => forceSessionEndTriggerMock(...a),
}));
vi.mock("../../src/hooks/codex/spawn-wiki-worker.js", () => ({
  spawnCodexWikiWorker: (...a: unknown[]) => spawnMock(...a),
  wikiLog: (...a: unknown[]) => wikiLogMock(...a),
  bundleDirFromImportMeta: () => "/fake/codex-bundle",
}));
vi.mock("../../src/hooks/summary-state.js", () => ({
  tryAcquireLock: (...a: unknown[]) => tryAcquireLockMock(...a),
  releaseLock: (...a: unknown[]) => releaseLockMock(...a),
  markSessionEnded: (...a: unknown[]) => markSessionEndedMock(...a),
}));
vi.mock("../../src/notifications/codex-transcript-parser.js", () => ({
  parseCodexTranscript: (...a: unknown[]) => parseCodexTranscriptMock(...a),
}));
vi.mock("../../src/notifications/usage-tracker.js", () => ({
  appendUsageRecord: (...a: unknown[]) => appendUsageRecordMock(...a),
}));
vi.mock("../../src/utils/debug.js", () => ({
  log: (_tag: string, msg: string) => debugLogMock(msg),
}));

async function runHook(): Promise<void> {
  vi.resetModules();
  await import("../../src/hooks/codex/session-end.js");
  await new Promise(r => setImmediate(r));
}

const validConfig = {
  token: "t", orgId: "o", orgName: "o", workspaceId: "default",
  userName: "u", apiUrl: "http://example", tableName: "memory",
  sessionsTableName: "sessions",
};

beforeEach(() => {
  delete process.env.MEMOREE_WIKI_WORKER;
  delete process.env.MEMOREE_CAPTURE;
  stdinMock.mockReset().mockResolvedValue({ session_id: "sid-1", cwd: "/proj", reason: "other" });
  loadConfigMock.mockReset().mockReturnValue(validConfig);
  spawnMock.mockReset();
  wikiLogMock.mockReset();
  tryAcquireLockMock.mockReset().mockReturnValue(true);
  releaseLockMock.mockReset();
  markSessionEndedMock.mockReset();
  parseCodexTranscriptMock.mockReset().mockReturnValue({ memorySearchCount: 0, memorySearchBytes: 0 });
  appendUsageRecordMock.mockReset();
  debugLogMock.mockReset();
  forceSessionEndTriggerMock.mockReset();
  pluginEnabledMock.mockReset().mockReturnValue(true);
});

afterEach(() => { vi.restoreAllMocks(); });

describe("codex session-end hook", () => {
  it("returns immediately when MEMOREE_WIKI_WORKER=1", async () => {
    process.env.MEMOREE_WIKI_WORKER = "1";
    await runHook();
    expect(stdinMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns immediately when MEMOREE_CAPTURE=false", async () => {
    process.env.MEMOREE_CAPTURE = "false";
    await runHook();
    expect(stdinMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns immediately when the memoree plugin is disabled", async () => {
    pluginEnabledMock.mockReturnValue(false);
    await runHook();
    expect(stdinMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns without spawning when session_id is missing", async () => {
    stdinMock.mockResolvedValue({ session_id: "", cwd: "/proj" });
    await runHook();
    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(markSessionEndedMock).not.toHaveBeenCalled();
  });

  it("returns without spawning when loadConfig returns null", async () => {
    loadConfigMock.mockReturnValue(null);
    await runHook();
    expect(tryAcquireLockMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(debugLogMock).toHaveBeenCalledWith("no config");
  });

  it("marks the session ended even when the wiki lock is held", async () => {
    tryAcquireLockMock.mockReturnValue(false);
    await runHook();
    expect(markSessionEndedMock).toHaveBeenCalledWith("sid-1");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(forceSessionEndTriggerMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sid-1", agent: "codex" }),
    );
  });

  it("records session usage when the transcript has memory searches", async () => {
    stdinMock.mockResolvedValue({
      session_id: "sid-1", cwd: "/proj", transcript_path: "/t.jsonl", reason: "other",
    });
    parseCodexTranscriptMock.mockReturnValue({ memorySearchCount: 3, memorySearchBytes: 100 });
    await runHook();
    expect(parseCodexTranscriptMock).toHaveBeenCalledWith("/t.jsonl", "sid-1");
    expect(appendUsageRecordMock).toHaveBeenCalledWith({ memorySearchCount: 3, memorySearchBytes: 100 });
  });

  it("skips the usage record when the transcript has no memory searches", async () => {
    stdinMock.mockResolvedValue({
      session_id: "sid-1", cwd: "/proj", transcript_path: "/t.jsonl",
    });
    parseCodexTranscriptMock.mockReturnValue({ memorySearchCount: 0, memorySearchBytes: 0 });
    await runHook();
    expect(appendUsageRecordMock).not.toHaveBeenCalled();
  });

  it("swallows a transcript-parse error and still proceeds to spawn", async () => {
    stdinMock.mockResolvedValue({
      session_id: "sid-1", cwd: "/proj", transcript_path: "/t.jsonl",
    });
    parseCodexTranscriptMock.mockImplementation(() => { throw new Error("bad transcript"); });
    await runHook();
    expect(appendUsageRecordMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalled();
  });

  it("spawns the Codex wiki worker on the happy path", async () => {
    await runHook();
    expect(tryAcquireLockMock).toHaveBeenCalledWith("sid-1");
    expect(wikiLogMock).toHaveBeenCalledWith(
      expect.stringContaining("triggering summary for sid-1"),
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const callArg = spawnMock.mock.calls[0][0];
    expect(callArg.sessionId).toBe("sid-1");
    expect(callArg.cwd).toBe("/proj");
    expect(callArg.reason).toBe("SessionEnd");
    expect(callArg.config).toBe(validConfig);
  });

  it("releases the lock if spawnCodexWikiWorker throws", async () => {
    spawnMock.mockImplementation(() => { throw new Error("spawn exploded"); });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await runHook();
    await new Promise(r => setImmediate(r));
    expect(releaseLockMock).toHaveBeenCalledWith("sid-1");
    expect(debugLogMock).toHaveBeenCalledWith("fatal: spawn exploded");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("still swallows release errors when spawn throws", async () => {
    spawnMock.mockImplementation(() => { throw new Error("spawn exploded"); });
    releaseLockMock.mockImplementation(() => { throw new Error("release also broken"); });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await runHook();
    await new Promise(r => setImmediate(r));
    expect(debugLogMock).toHaveBeenCalledWith("fatal: spawn exploded");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
