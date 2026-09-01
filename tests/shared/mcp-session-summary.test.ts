import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBackend } from "../../src/storage/sqlite.js";
import { buildDirectSessionInsertSql } from "../../src/hooks/shared/session-insert-sql.js";
import {
  MCP_SUMMARY_MARKER,
  buildMcpSessionSummaryMarkdown,
  formatMcpEventLine,
  spawnMcpSessionSummaryWorker,
  writeMcpSessionSummary,
} from "../../src/mcp/session-summary.js";
import { runMcpSessionSummaryWorker } from "../../src/mcp/session-summary-worker.js";
import { isFinalizedSummaryText } from "../../src/hooks/upload-summary.js";
import { clearFakeHome, setFakeHome } from "./fake-home.js";
import { _resetForTesting, _setEnabledReaderForTesting } from "../../src/embeddings/disable.js";
import { _resetUserConfigForTesting } from "../../src/user-config.js";

const TABLES = {
  memory: "memory",
  sessions: "sessions",
  skills: "skills",
  rules: "memoree_rules",
  goals: "memoree_goals",
  kpis: "memoree_kpis",
  docs: "memoree_docs",
  codebase: "codebase",
};

describe("MCP session summary markdown", () => {
  it("formats tool calls and includes a non-empty What Happened section", () => {
    const text = buildMcpSessionSummaryMarkdown({
      sessionId: "agy-1",
      project: "memoree",
      sessionPath: "/sessions/alice/agy-1.jsonl",
      events: [
        { tool_name: "memoree_write", tool_input: { path: "rules/active/x.md" } },
        { content: "hello" },
        "not-json",
      ],
    });
    expect(text).toContain(MCP_SUMMARY_MARKER);
    expect(isFinalizedSummaryText(text)).toBe(true);
    expect(text).toContain("memoree_write");
    expect(formatMcpEventLine({ type: "tool_call" })).toBe("- tool_call");
  });
});

describe("writeMcpSessionSummary", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  async function setup() {
    const root = mkdtempSync(join(tmpdir(), "mcp-summary-"));
    dirs.push(root);
    const dbPath = join(root, "memoree.sqlite3");
    const api = new SqliteBackend(dbPath, "memory", TABLES);
    await api.initializeSchema();
    const now = "2026-09-01T00:00:00.000Z";
    const sessionId = "agy-conv-uuid";
    await api.query(buildDirectSessionInsertSql("sessions", {
      id: "evt-1",
      sessionPath: `/sessions/alice/alice_local_default_${sessionId}.jsonl`,
      filename: `alice_local_default_${sessionId}.jsonl`,
      jsonForSql: JSON.stringify({ type: "tool_call", tool_name: "memoree_write", tool_input: { path: "rules/active/x.md" } }),
      embeddingSql: "NULL",
      userName: "alice",
      sizeBytes: 20,
      projectName: "memoree",
      projectKey: "projkey12345678",
      description: "PostToolUse",
      agent: "antigravity",
      pluginVersion: "test",
      timestamp: now,
    }, "sqlite"));
    return { api, sessionId };
  }

  it("writes a summary row with a vector without calling the embed daemon", async () => {
    const { api, sessionId } = await setup();
    const vec = [1, 0, 0];
    const result = await writeMcpSessionSummary({
      query: sql => api.query(sql),
      memoryTable: "memory",
      sessionsTable: "sessions",
      sessionId,
      userName: "alice",
      project: "memoree",
      projectKey: "projkey12345678",
      embedding: vec,
      dialect: "sqlite",
    });
    expect(result.path).toBe("insert");
    const rows = await api.query(`SELECT summary, summary_embedding, project_key FROM memory WHERE path LIKE '/summaries/%'`);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.summary)).toContain("## What Happened");
    expect(String(rows[0]!.summary)).toContain(MCP_SUMMARY_MARKER);
    expect(String(rows[0]!.summary)).toContain("memoree_write");
    expect(rows[0]!.project_key).toBe("projkey12345678");
    const emb = rows[0]!.summary_embedding;
    expect(Array.isArray(emb) ? emb : JSON.parse(String(emb))).toEqual(vec);
    await api.close();
  });

  it("returns empty when the session has no events", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-summary-empty-"));
    dirs.push(root);
    const api = new SqliteBackend(join(root, "db.sqlite3"), "memory", TABLES);
    await api.initializeSchema();
    const result = await writeMcpSessionSummary({
      query: sql => api.query(sql),
      memoryTable: "memory",
      sessionsTable: "sessions",
      sessionId: "missing",
      userName: "alice",
      project: "p",
      projectKey: "k",
      embedding: [1],
      dialect: "sqlite",
    });
    expect(result.path).toBe("empty");
    await api.close();
  });

  it("does not overwrite a finalized wiki summary", async () => {
    const { api, sessionId } = await setup();
    const wiki = [
      "# Session wiki",
      "",
      "## What Happened",
      "A real wiki write-up of the session.",
      "",
    ].join("\n");
    await api.query(
      `INSERT INTO memory (id, path, filename, summary, description, author, project, project_key, creation_date, last_update_date) ` +
      `VALUES ('w', '/summaries/alice/${sessionId}.md', '${sessionId}.md', '${wiki.replace(/'/g, "''")}', 'wiki body', 'alice', 'memoree', 'projkey12345678', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    );
    const result = await writeMcpSessionSummary({
      query: sql => api.query(sql),
      memoryTable: "memory",
      sessionsTable: "sessions",
      sessionId,
      userName: "alice",
      project: "memoree",
      projectKey: "projkey12345678",
      embedding: [1, 0, 0],
      dialect: "sqlite",
    });
    expect(result.path).toBe("skip-wiki");
    const rows = await api.query(`SELECT summary FROM memory WHERE path = '/summaries/alice/${sessionId}.md'`);
    expect(String(rows[0]!.summary)).toContain("A real wiki write-up");
    expect(String(rows[0]!.summary)).not.toContain(MCP_SUMMARY_MARKER);
    await api.close();
  });

  it("embeds via embedText when no vector is supplied", async () => {
    const { api, sessionId } = await setup();
    const embedText = vi.fn(async (text: string) => {
      expect(text).toContain("## What Happened");
      return [0, 1, 0];
    });
    const result = await writeMcpSessionSummary({
      query: sql => api.query(sql),
      memoryTable: "memory",
      sessionsTable: "sessions",
      sessionId,
      userName: "alice",
      project: "memoree",
      projectKey: "k",
      dialect: "sqlite",
      embedText,
    });
    expect(result.path).toBe("insert");
    expect(embedText).toHaveBeenCalledTimes(1);
    await api.close();
  });
});

describe("spawnMcpSessionSummaryWorker", () => {
  it("no-ops under Vitest without an injected spawn", () => {
    const spawn = vi.fn();
    spawnMcpSessionSummaryWorker({ sessionId: "x", cwd: process.cwd() });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("writes a config file and calls the injected spawn", () => {
    const spawn = vi.fn();
    spawnMcpSessionSummaryWorker({ sessionId: "spawn-sid", cwd: process.cwd() }, { spawn });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [workerPath, args] = spawn.mock.calls[0]!;
    expect(String(workerPath)).toMatch(/session-summary-worker\.js$/);
    expect(args[0]).toMatch(/config\.json$/);
  });

  it("swallows spawn failures", () => {
    expect(() => spawnMcpSessionSummaryWorker(
      { sessionId: "spawn-err", cwd: process.cwd() },
      { spawn: () => { throw new Error("nope"); } },
    )).not.toThrow();
  });
});

describe("runMcpSessionSummaryWorker", () => {
  let home: string;
  const prior = {
    backend: process.env.MEMOREE_BACKEND,
    sqlite: process.env.MEMOREE_SQLITE_PATH,
    embeddings: process.env.MEMOREE_EMBEDDINGS,
    user: process.env.MEMOREE_USER_NAME,
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
    restore("MEMOREE_USER_NAME", prior.user);
  });

  it("exits when sessionId is missing", async () => {
    home = mkdtempSync(join(tmpdir(), "mcp-sum-worker-"));
    const cfg = join(home, "cfg.json");
    writeFileSync(cfg, JSON.stringify({ cwd: home }));
    await expect(runMcpSessionSummaryWorker(cfg)).resolves.toBeUndefined();
  });

  it("exits when storage config is unavailable", async () => {
    home = mkdtempSync(join(tmpdir(), "mcp-sum-noconfig-"));
    const prevBackend = process.env.MEMOREE_BACKEND;
    const prevUrl = process.env.MEMOREE_POSTGRES_URL;
    process.env.MEMOREE_BACKEND = "postgres";
    delete process.env.MEMOREE_POSTGRES_URL;
    const cfg = join(home, "cfg.json");
    writeFileSync(cfg, JSON.stringify({ sessionId: "x", cwd: home }));
    await expect(runMcpSessionSummaryWorker(cfg)).resolves.toBeUndefined();
    restore("MEMOREE_BACKEND", prevBackend);
    restore("MEMOREE_POSTGRES_URL", prevUrl);
  });

  it("writes a summary from session rows with embeddings disabled", async () => {
    home = mkdtempSync(join(tmpdir(), "mcp-sum-worker-"));
    setFakeHome(home);
    const databasePath = join(home, "memoree.sqlite3");
    process.env.MEMOREE_BACKEND = "sqlite";
    process.env.MEMOREE_SQLITE_PATH = databasePath;
    process.env.MEMOREE_EMBEDDINGS = "false";
    process.env.MEMOREE_USER_NAME = "alice";
    const api = new SqliteBackend(databasePath, "memory", TABLES);
    await api.initializeSchema();
    const sessionId = "worker-sid";
    await api.query(buildDirectSessionInsertSql("sessions", {
      id: "evt-w",
      sessionPath: `/sessions/alice/alice_local_default_${sessionId}.jsonl`,
      filename: `${sessionId}.jsonl`,
      jsonForSql: JSON.stringify({ type: "tool_call", tool_name: "memoree_ls", tool_input: { path: "" } }),
      embeddingSql: "NULL",
      userName: "alice",
      sizeBytes: 10,
      projectName: "p",
      projectKey: "k",
      description: "PostToolUse",
      agent: "antigravity",
      pluginVersion: "test",
      timestamp: "2026-09-01T00:00:00.000Z",
    }, "sqlite"));
    await api.close();

    const cfg = join(home, "cfg.json");
    writeFileSync(cfg, JSON.stringify({ sessionId, cwd: home, project: "p", projectKey: "k" }));
    await runMcpSessionSummaryWorker(cfg);

    const read = new SqliteBackend(databasePath, "memory", TABLES);
    const rows = await read.query(`SELECT summary FROM memory WHERE path = '/summaries/alice/${sessionId}.md'`);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.summary)).toContain(MCP_SUMMARY_MARKER);
    expect(String(rows[0]!.summary)).toContain("memoree_ls");
    await read.close();
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
