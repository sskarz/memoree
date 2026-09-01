import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clearFakeHome, setFakeHome } from "./fake-home.js";
import { captureMcpToolCall, mcpSessionId } from "../../src/mcp/session-capture.js";
import { captureFromHook } from "../../src/hooks/antigravity/capture.js";
import { _resetForTesting, _setEnabledReaderForTesting } from "../../src/embeddings/disable.js";
import { _resetUserConfigForTesting } from "../../src/user-config.js";

describe("Antigravity MCP session capture", () => {
  let home: string;
  const prior = {
    backend: process.env.MEMOREE_BACKEND,
    sqlite: process.env.MEMOREE_SQLITE_PATH,
    embeddings: process.env.MEMOREE_EMBEDDINGS,
    capture: process.env.MEMOREE_CAPTURE,
    user: process.env.MEMOREE_USER_NAME,
    conv: process.env.ANTIGRAVITY_CONVERSATION_ID,
  };

  beforeEach(() => {
    _setEnabledReaderForTesting(() => false);
    _resetUserConfigForTesting();
  });

  afterEach(() => {
    clearFakeHome();
    _resetForTesting();
    _resetUserConfigForTesting();
    if (home) rmSync(home, { recursive: true, force: true });
    restore("MEMOREE_BACKEND", prior.backend);
    restore("MEMOREE_SQLITE_PATH", prior.sqlite);
    restore("MEMOREE_EMBEDDINGS", prior.embeddings);
    restore("MEMOREE_CAPTURE", prior.capture);
    restore("MEMOREE_USER_NAME", prior.user);
    restore("ANTIGRAVITY_CONVERSATION_ID", prior.conv);
  });

  it("uses the Antigravity conversation id when the CLI exports it", () => {
    expect(mcpSessionId({ ANTIGRAVITY_CONVERSATION_ID: "  conv-1  " })).toBe("conv-1");
    expect(mcpSessionId({})).toBe(`mcp-${process.pid}`);
  });

  it("persists MCP tool arguments so unaided agy -p can be observed", async () => {
    home = mkdtempSync(join(tmpdir(), "mcp-capture-"));
    setFakeHome(home);
    const databasePath = join(home, "memoree.sqlite3");
    process.env.MEMOREE_BACKEND = "sqlite";
    process.env.MEMOREE_SQLITE_PATH = databasePath;
    process.env.MEMOREE_EMBEDDINGS = "false";
    process.env.MEMOREE_CAPTURE = "true";
    process.env.MEMOREE_USER_NAME = "mcp-capture";
    process.env.ANTIGRAVITY_CONVERSATION_ID = "agy-conv-uuid";
    const marker = "c2fe48dd-6363-4e25-acbc-74a9d833a00e";
    await captureMcpToolCall(
      "memoree_write",
      { path: `rules/active/${marker}.md`, content: marker },
      { ok: true, text: "ok" },
    );
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE CAST(message AS TEXT) LIKE ?").get(`%${marker}%`) as { n: number };
      expect(row.n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("keeps MCP-captured rows searchable via VFS grep without embeddings", async () => {
    home = mkdtempSync(join(tmpdir(), "mcp-capture-grep-"));
    setFakeHome(home);
    const databasePath = join(home, "memoree.sqlite3");
    process.env.MEMOREE_BACKEND = "sqlite";
    process.env.MEMOREE_SQLITE_PATH = databasePath;
    process.env.MEMOREE_EMBEDDINGS = "false";
    process.env.MEMOREE_CAPTURE = "true";
    process.env.MEMOREE_USER_NAME = "mcp-capture";
    process.env.ANTIGRAVITY_CONVERSATION_ID = "agy-conv-grep";
    const marker = "e7c1a2b3-4d5e-6789-abcd-ef0123456789";
    await captureMcpToolCall(
      "memoree_write",
      { path: `rules/active/${marker}.md`, content: marker },
      { ok: true, text: "ok" },
    );
    const { loadConfig } = await import("../../src/config.js");
    const { createStorageBackend } = await import("../../src/storage/factory.js");
    const { searchMemoreeTables } = await import("../../src/shell/grep-core.js");
    const config = loadConfig();
    expect(config).toBeTruthy();
    const api = createStorageBackend(config!, config!.tableName);
    try {
      const rows = await searchMemoreeTables(api, config!.tableName, config!.sessionsTableName, {
        pathFilter: "",
        contentScanOnly: false,
        likeOp: "LIKE",
        escapedPattern: marker,
      });
      expect(rows.some(row => row.content.includes(marker))).toBe(true);
    } finally {
      await api.close();
    }
  });

  it("skips capture when MEMOREE_CAPTURE is false", async () => {
    home = mkdtempSync(join(tmpdir(), "mcp-capture-off-"));
    setFakeHome(home);
    const databasePath = join(home, "memoree.sqlite3");
    process.env.MEMOREE_BACKEND = "sqlite";
    process.env.MEMOREE_SQLITE_PATH = databasePath;
    process.env.MEMOREE_EMBEDDINGS = "false";
    process.env.MEMOREE_CAPTURE = "false";
    process.env.MEMOREE_USER_NAME = "mcp-capture";
    await captureMcpToolCall("memoree_ls", { path: "" }, { ok: true, text: "rules.md" });
    const db = new DatabaseSync(databasePath);
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").get();
      expect(tables).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("swallows capture errors so MCP tools still return", async () => {
    process.env.MEMOREE_CAPTURE = "true";
    process.env.MEMOREE_BACKEND = "not-a-backend";
    await expect(captureMcpToolCall("memoree_ls", {}, { ok: true, text: "x" })).resolves.toBeUndefined();
  });

  it("does not wait on the embed daemon for MCP tools/call rows", () => {
    const source = readFileSync(new URL("../../src/mcp/session-capture.ts", import.meta.url), "utf8");
    expect(source).toContain("{ embed: false }");
  });

  it("skips PostToolUse capture for memoree MCP tools so interactive sessions are not duplicated", async () => {
    home = mkdtempSync(join(tmpdir(), "mcp-capture-dedupe-"));
    setFakeHome(home);
    const databasePath = join(home, "memoree.sqlite3");
    process.env.MEMOREE_BACKEND = "sqlite";
    process.env.MEMOREE_SQLITE_PATH = databasePath;
    process.env.MEMOREE_EMBEDDINGS = "false";
    process.env.MEMOREE_CAPTURE = "true";
    process.env.MEMOREE_USER_NAME = "mcp-capture";
    const marker = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    await captureFromHook({
      conversationId: "agy-interactive",
      workspacePaths: [home],
      toolCall: { name: "call_mcp_tool", args: { ToolName: "memoree_read", path: marker } },
    }, "PostToolUse");
    await captureFromHook({
      conversationId: "agy-interactive",
      workspacePaths: [home],
      toolCall: { name: "run_command", args: { CommandLine: `echo ${marker}` } },
    }, "PostToolUse");
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const mcp = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE CAST(message AS TEXT) LIKE ?").get("%memoree_read%") as { n: number };
      const shell = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE CAST(message AS TEXT) LIKE ?").get(`%${marker}%`) as { n: number };
      expect(mcp.n).toBe(0);
      expect(shell.n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
