import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoreeFs } from "../../src/shell/memoree-fs.js";
import { SqliteBackend } from "../../src/storage/sqlite.js";
import { _resetForTesting, _setEnabledReaderForTesting } from "../../src/embeddings/disable.js";
import { runGoalCommand } from "../../src/commands/goal.js";

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

let root: string;
let backend: SqliteBackend;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "memoree-structured-vfs-"));
  backend = new SqliteBackend(join(root, "memoree.sqlite3"), "memory", names);
  _setEnabledReaderForTesting(() => false);
});

afterEach(async () => {
  await backend.close();
  _resetForTesting();
  rmSync(root, { recursive: true, force: true });
});

async function makeFs(): Promise<MemoreeFs> {
  await backend.initializeSchema();
  return MemoreeFs.create(backend, "memory", "/", "sessions", {
    rulesTable: names.rules,
    goalsTable: names.goals,
    kpisTable: names.kpis,
    identity: {
      userName: "alice",
      organization: "local",
      workspace: "workspace-one",
      backend: "sqlite",
    },
  });
}

describe("structured Memoree VFS", () => {
  it("synthesizes identity, inventories, and empty lifecycle directories", async () => {
    const fs = await makeFs();
    expect(JSON.parse(await fs.readFile("/identity.json"))).toEqual({
      userName: "alice",
      organization: "local",
      workspace: "workspace-one",
      backend: "sqlite",
    });
    expect(await fs.readFile("/rules.md")).toContain("(no active rules)");
    expect(await fs.readFile("/goals.md")).toContain("(no open goals)");
    expect(await fs.readdir("/rules")).toEqual(expect.arrayContaining(["active", "done"]));
    expect(await fs.readdir("/goal/alice")).toEqual(expect.arrayContaining(["opened", "in_progress", "closed"]));
    expect(await fs.readdir("/kpi")).toEqual([]);
    expect(await fs.readdir("/")).toEqual(expect.arrayContaining(["identity.json", "rules.md", "goals.md", "rules", "goal", "kpi"]));
  });

  it("creates and versions rules, moves status without renaming, and soft-completes", async () => {
    const fs = await makeFs();
    const active = "/rules/active/11111111-1111-4111-8111-111111111111.md";
    const done = "/rules/done/11111111-1111-4111-8111-111111111111.md";
    await fs.writeFile(active, "Always verify locally");
    await fs.flush();
    await fs.writeFile(active, "Always verify SQLite locally");
    await fs.flush();
    expect(await fs.readFile("/rules.md")).toContain("Always verify SQLite locally");
    await fs.mv(active, done);
    expect(await fs.readFile(done)).toBe("Always verify SQLite locally");
    await expect(fs.mv(done, "/rules/active/renamed.md")).rejects.toMatchObject({ code: "EPERM" });
    await fs.rm(done);
    expect(await fs.exists(done)).toBe(true);
    await fs.mv(done, active);
    await fs.rm(active);
    expect(await fs.exists(done)).toBe(true);
    const versions = await backend.query(
      `SELECT version, status, text FROM "${names.rules}" ORDER BY version`,
    );
    expect(versions).toEqual([
      { version: 1, status: "active", text: "Always verify locally" },
      { version: 2, status: "active", text: "Always verify SQLite locally" },
      { version: 3, status: "done", text: "Always verify SQLite locally" },
      { version: 4, status: "active", text: "Always verify SQLite locally" },
      { version: 5, status: "done", text: "Always verify SQLite locally" },
    ]);
  });

  it("changes goal owner/status without changing ID and treats removal as close", async () => {
    const fs = await makeFs();
    const opened = "/goal/alice/opened/22222222-2222-4222-8222-222222222222.md";
    const reassigned = "/goal/bob/in_progress/22222222-2222-4222-8222-222222222222.md";
    await fs.writeFile(opened, "Ship the filesystem");
    await fs.flush();
    await fs.mv(opened, reassigned);
    expect(await fs.readFile(reassigned)).toBe("Ship the filesystem");
    await expect(fs.mv(reassigned, "/goal/bob/closed/renamed.md")).rejects.toMatchObject({ code: "EPERM" });
    await fs.rm(reassigned);
    const closed = "/goal/bob/closed/22222222-2222-4222-8222-222222222222.md";
    expect(await fs.readFile(closed)).toBe("Ship the filesystem");
    await fs.rm(closed);
    expect(await fs.exists(closed)).toBe(true);
    expect(await backend.query(`SELECT goal_id, owner, status, content FROM "${names.goals}"`)).toEqual([{
      goal_id: "22222222-2222-4222-8222-222222222222",
      owner: "bob",
      status: "closed",
      content: "Ship the filesystem",
    }]);
  });

  it("allows KPI create/overwrite but denies KPI move/removal and protected writes", async () => {
    const fs = await makeFs();
    const kpi = "/kpi/goal-1/tests.md";
    await fs.writeFile(kpi, "Tests\n\n- target: 10\n- current: 0\n- unit: cases");
    await fs.flush();
    await fs.writeFile(kpi, "Tests\n\n- target: 10\n- current: 4\n- unit: cases");
    await fs.flush();
    expect(await fs.readFile(kpi)).toContain("current: 4");
    await expect(fs.mv(kpi, "/kpi/goal-1/other.md")).rejects.toMatchObject({ code: "EPERM" });
    await expect(fs.rm(kpi)).rejects.toMatchObject({ code: "EPERM" });
    await expect(fs.writeFile("/identity.json", "{}")) .rejects.toMatchObject({ code: "EPERM" });
    await expect(fs.writeFile("/rules.md", "fake")) .rejects.toMatchObject({ code: "EPERM" });
    await expect(fs.writeFile("/goal/alice.md", "bad")) .rejects.toMatchObject({ code: "EPERM" });
  });
});

describe("SQLite CLI/VFS consistency", () => {
  it("shows a goal created through the CLI at its canonical filesystem path", async () => {
    const prior = {
      backend: process.env.MEMOREE_BACKEND,
      path: process.env.MEMOREE_SQLITE_PATH,
      user: process.env.MEMOREE_USER_NAME,
      embeddings: process.env.MEMOREE_EMBEDDINGS,
    };
    process.env.MEMOREE_BACKEND = "sqlite";
    process.env.MEMOREE_SQLITE_PATH = join(root, "memoree.sqlite3");
    process.env.MEMOREE_USER_NAME = "alice";
    process.env.MEMOREE_EMBEDDINGS = "false";
    let stdout = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    try {
      await runGoalCommand(["add", "Created", "through", "the", "CLI"]);
    } finally {
      write.mockRestore();
      if (prior.backend === undefined) delete process.env.MEMOREE_BACKEND; else process.env.MEMOREE_BACKEND = prior.backend;
      if (prior.path === undefined) delete process.env.MEMOREE_SQLITE_PATH; else process.env.MEMOREE_SQLITE_PATH = prior.path;
      if (prior.user === undefined) delete process.env.MEMOREE_USER_NAME; else process.env.MEMOREE_USER_NAME = prior.user;
      if (prior.embeddings === undefined) delete process.env.MEMOREE_EMBEDDINGS; else process.env.MEMOREE_EMBEDDINGS = prior.embeddings;
    }
    const goalId = stdout.trim();
    expect(goalId).toMatch(/^[0-9a-f-]{36}$/);
    const fs = await makeFs();
    expect(await fs.readFile(`/goal/alice/opened/${goalId}.md`)).toBe("Created through the CLI");
    expect(await fs.readFile("/goals.md")).toContain(goalId);
  });
});
