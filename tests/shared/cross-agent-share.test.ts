/**
 * Cross-harness shareability locks: Claude, Codex, and Antigravity read the
 * same SQLite VFS. Session/summary grep is org-wide (basename `project` is
 * metadata, not a tenant key). Docs/skills/graphs use deriveProjectKey.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { SqliteBackend } from "../../src/storage/sqlite.js";
import { embeddingSqlLiteral } from "../../src/embeddings/sql.js";
import { buildDirectSessionInsertSql } from "../../src/hooks/shared/session-insert-sql.js";
import { searchMemoreeTables } from "../../src/shell/grep-core.js";
import { recallTopHit } from "../../src/hooks/shared/recall-query.js";

const names = {
  memory: "memory",
  sessions: "sessions",
  skills: "skills",
  rules: "memoree_rules",
  goals: "memoree_goals",
  kpis: "memoree_kpis",
  docs: "memoree_docs",
  codebase: "codebase",
};

describe("cross-agent session grep is not basename-scoped", () => {
  let root: string;
  let backend: SqliteBackend;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "cross-agent-share-"));
    backend = new SqliteBackend(join(root, "memory.sqlite3"), "memory", names);
    await backend.initializeSchema();
  });

  afterEach(async () => {
    await backend.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("finds session rows tagged with different cwd basenames in the same DB", async () => {
    const alpha = randomUUID();
    const beta = randomUUID();
    const now = new Date().toISOString();
    for (const row of [
      { id: randomUUID(), marker: alpha, project: "repo-alpha", agent: "claude_code" },
      { id: randomUUID(), marker: beta, project: "repo-beta", agent: "antigravity" },
    ]) {
      const message = JSON.stringify({ type: "user", content: `remember ${row.marker}` });
      await backend.query(buildDirectSessionInsertSql("sessions", {
        id: row.id,
        sessionPath: `/sessions/alice/${row.project}.jsonl`,
        filename: `${row.project}.jsonl`,
        jsonForSql: message.replace(/'/g, "''"),
        embeddingSql: embeddingSqlLiteral(null, "sqlite"),
        userName: "alice",
        sizeBytes: message.length,
        projectName: row.project,
        description: "Prompt",
        agent: row.agent,
        pluginVersion: "test",
        timestamp: now,
      }, "sqlite"));
    }

    const alphaHits = await searchMemoreeTables(backend, "memory", "sessions", {
      pathFilter: "",
      contentScanOnly: false,
      likeOp: "LIKE",
      escapedPattern: alpha,
    });
    const betaHits = await searchMemoreeTables(backend, "memory", "sessions", {
      pathFilter: "",
      contentScanOnly: false,
      likeOp: "LIKE",
      escapedPattern: beta,
    });
    expect(alphaHits.some(row => row.content.includes(alpha))).toBe(true);
    expect(betaHits.some(row => row.content.includes(beta))).toBe(true);
    expect(alphaHits.some(row => row.content.includes(beta))).toBe(false);
  });
});

describe("recallTopHit project filter is optional and unused by harnesses", () => {
  it("omits project= when callers pass empty options (Claude/Codex/Agy)", async () => {
    let captured = "";
    await recallTopHit(async (sql) => {
      captured = sql;
      return [];
    }, "memory", [0.1, 0.2, 0.3], {});
    expect(captured).not.toContain("project =");
  });

  it("still supports an explicit project option for a future stable key", async () => {
    let captured = "";
    await recallTopHit(async (sql) => {
      captured = sql;
      return [];
    }, "memory", [0.1, 0.2, 0.3], { project: "indra" });
    expect(captured).toContain("project = 'indra'");
  });

  it("locks Claude and Antigravity recall to the same no-basename-filter call", () => {
    const claude = readFileSync(new URL("../../src/hooks/recall.ts", import.meta.url), "utf8");
    const agy = readFileSync(new URL("../../src/hooks/antigravity/pre-invocation.ts", import.meta.url), "utf8");
    expect(claude).toContain("No project filter");
    expect(agy).toContain("return recallTopHit(q, config.tableName, vec, {});");
    expect(agy).not.toContain("projectNameFromCwd");
  });
});

describe("skillify project install is Claude-canonical", () => {
  it("writes project skills under .claude/skills, not a per-harness tree", () => {
    const scope = readFileSync(new URL("../../src/skillify/scope-config.ts", import.meta.url), "utf8");
    expect(scope).toContain("<cwd>/.claude/skills");
    expect(scope).toContain("~/.claude/skills");
  });
});
