import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBackend } from "../../src/storage/sqlite.js";
import { buildDirectSessionInsertSql } from "../../src/hooks/shared/session-insert-sql.js";
import { searchMemoreeTables } from "../../src/shell/grep-core.js";
import { recallTopHit } from "../../src/hooks/shared/recall-query.js";
import { readVirtualPathContents } from "../../src/hooks/virtual-table-query.js";
import { deriveProjectKey } from "../../src/utils/repo-identity.js";
import { embeddingSqlLiteral } from "../../src/embeddings/sql.js";

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

function initGitRepo(dir: string, origin: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init -q -b main", { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  execSync(`git remote add origin ${origin}`, { cwd: dir });
  writeFileSync(join(dir, "README.md"), "x\n");
  execSync("git add README.md", { cwd: dir });
  execSync('git commit -q -m "init"', { cwd: dir });
}

describe("project_key scopes session grep, recall, and index.md", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("two remotes do not see each other; a subdirectory of the same remote does", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-key-scope-"));
    dirs.push(root);
    const repoA = join(root, "api");
    const repoB = join(root, "other", "api");
    initGitRepo(repoA, "https://github.com/acme/alpha.git");
    initGitRepo(repoB, "https://github.com/acme/beta.git");
    const subA = join(repoA, "src");
    mkdirSync(subA, { recursive: true });

    const keyA = deriveProjectKey(repoA).key;
    const keyB = deriveProjectKey(repoB).key;
    const keySub = deriveProjectKey(subA).key;
    expect(keyA).toBe(keySub);
    expect(keyA).not.toBe(keyB);

    const dbPath = join(root, "memoree.sqlite3");
    const api = new SqliteBackend(dbPath, "memory", TABLES);
    await api.initializeSchema();

    const vec = [1, 0, 0];
    const now = "2026-09-01T00:00:00.000Z";
    await api.query(buildDirectSessionInsertSql("sessions", {
      id: "sess-a",
      sessionPath: "/sessions/alice/alpha.jsonl",
      filename: "alpha.jsonl",
      jsonForSql: JSON.stringify({ type: "user_message", content: "alpha-secret-uuid" }),
      embeddingSql: embeddingSqlLiteral(vec, "sqlite"),
      userName: "alice",
      sizeBytes: 20,
      projectName: "api",
      projectKey: keyA,
      description: "UserPromptSubmit",
      agent: "claude_code",
      pluginVersion: "test",
      timestamp: now,
    }, "sqlite"));
    await api.query(buildDirectSessionInsertSql("sessions", {
      id: "sess-b",
      sessionPath: "/sessions/alice/beta.jsonl",
      filename: "beta.jsonl",
      jsonForSql: JSON.stringify({ type: "user_message", content: "beta-secret-uuid" }),
      embeddingSql: embeddingSqlLiteral(vec, "sqlite"),
      userName: "alice",
      sizeBytes: 20,
      projectName: "api",
      projectKey: keyB,
      description: "UserPromptSubmit",
      agent: "codex",
      pluginVersion: "test",
      timestamp: now,
    }, "sqlite"));
    await api.query(buildDirectSessionInsertSql("sessions", {
      id: "sess-legacy",
      sessionPath: "/sessions/alice/legacy.jsonl",
      filename: "legacy.jsonl",
      jsonForSql: JSON.stringify({ type: "user_message", content: "legacy-secret-uuid" }),
      embeddingSql: "NULL",
      userName: "alice",
      sizeBytes: 20,
      projectName: "old",
      projectKey: "",
      description: "UserPromptSubmit",
      agent: "claude_code",
      pluginVersion: "test",
      timestamp: now,
    }, "sqlite"));

    const emb = embeddingSqlLiteral(vec, "sqlite");
    await api.query(
      `INSERT INTO "memory" (id, path, filename, summary, summary_embedding, author, project, project_key, description, agent, creation_date, last_update_date) ` +
      `VALUES ('sum-a', '/summaries/alice/alpha.md', 'alpha.md', 'alpha-secret-uuid in summary', ${emb}, 'alice', 'api', '${keyA}', 'alpha work', 'claude_code', '${now}', '${now}')`,
    );
    await api.query(
      `INSERT INTO "memory" (id, path, filename, summary, summary_embedding, author, project, project_key, description, agent, creation_date, last_update_date) ` +
      `VALUES ('sum-b', '/summaries/alice/beta.md', 'beta.md', 'beta-secret-uuid in summary', ${emb}, 'alice', 'api', '${keyB}', 'beta work', 'codex', '${now}', '${now}')`,
    );

    const grepA = await searchMemoreeTables(api, "memory", "sessions", {
      pathFilter: "",
      contentScanOnly: false,
      likeOp: "LIKE",
      escapedPattern: "secret-uuid",
      projectKey: keyA,
    });
    const grepPathsA = grepA.map(r => r.path);
    expect(grepPathsA.some(p => p.includes("alpha"))).toBe(true);
    expect(grepPathsA.some(p => p.includes("beta"))).toBe(false);
    expect(grepPathsA.some(p => p.includes("legacy"))).toBe(true);

    const grepSub = await searchMemoreeTables(api, "memory", "sessions", {
      pathFilter: "",
      contentScanOnly: false,
      likeOp: "LIKE",
      escapedPattern: "secret-uuid",
      projectKey: keySub,
    });
    expect(grepSub.map(r => r.path).some(p => p.includes("alpha"))).toBe(true);
    expect(grepSub.map(r => r.path).some(p => p.includes("beta"))).toBe(false);

    const grepB = await searchMemoreeTables(api, "memory", "sessions", {
      pathFilter: "",
      contentScanOnly: false,
      likeOp: "LIKE",
      escapedPattern: "secret-uuid",
      projectKey: keyB,
    });
    expect(grepB.map(r => r.path).some(p => p.includes("beta"))).toBe(true);
    expect(grepB.map(r => r.path).some(p => p.includes("alpha"))).toBe(false);

    const hitA = await recallTopHit((sql) => api.query(sql), "memory", vec, { projectKey: keyA });
    expect(hitA?.path).toBe("/summaries/alice/alpha.md");
    const hitB = await recallTopHit((sql) => api.query(sql), "memory", vec, { projectKey: keyB });
    expect(hitB?.path).toBe("/summaries/alice/beta.md");

    const indexA = await readVirtualPathContents(api, "memory", "sessions", ["/index.md"], keyA);
    const indexText = indexA.get("/index.md") ?? "";
    expect(indexText).toContain("alpha.md");
    expect(indexText).not.toContain("beta.md");
    expect(indexText).toContain("legacy.jsonl");

    await api.close();
  });
});
