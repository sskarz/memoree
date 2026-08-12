import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "../../src/commands/doctor.js";
import type { SqliteStorageConfig, PostgresStorageConfig } from "../../src/config.js";

const common = {
  userName: "alice",
  workspaceId: "repo",
  orgId: "local",
  orgName: "local",
  tableName: "memory",
  sessionsTableName: "sessions",
  skillsTableName: "skills",
  rulesTableName: "memoree_rules",
  goalsTableName: "memoree_goals",
  kpisTableName: "memoree_kpis",
  docsTableName: "memoree_docs",
  codebaseTableName: "codebase",
  memoryPath: "/tmp/memory",
  vectorScanLimit: 100,
};

const sqlite: SqliteStorageConfig = { ...common, kind: "sqlite", path: "/tmp/memoree.sqlite3" };
const postgres: PostgresStorageConfig = {
  ...common,
  kind: "postgres",
  connectionUrl: "postgresql://secret.invalid/db",
  schema: "memoree",
};
const requiredTables = ["memory", "sessions", "skills", "memoree_rules", "memoree_goals", "memoree_kpis", "memoree_docs", "codebase"];

function backend(options: { tables?: string[]; integrity?: string; initializeError?: Error } = {}) {
  return {
    initializeSchema: vi.fn(async () => {
      if (options.initializeError) throw options.initializeError;
    }),
    listTables: vi.fn(async () => options.tables ?? requiredTables),
    query: vi.fn(async () => [{ integrity_check: options.integrity ?? "ok" }]),
    close: vi.fn(async () => {}),
  };
}

function baseDeps(config: SqliteStorageConfig | PostgresStorageConfig | null, storage = backend()) {
  const lines: string[] = [];
  return {
    lines,
    storage,
    deps: {
      loadStorageConfig: () => config,
      createStorageBackend: () => storage as never,
      getEmbeddingsEnabled: () => false,
      isSharedDepsInstalled: () => false,
      existsSync: () => true,
      execFileSync: ((_file: string, args: readonly string[]) => args[0] === "plugin" ? "memoree@memoree enabled" : "claude 1") as never,
      homedir: () => "/home/alice",
      pkgRoot: () => "/checkout",
      log: (line: string) => lines.push(line),
    },
  };
}

describe("memoree doctor", () => {
  it("passes a healthy SQLite installation and checks integrity", async () => {
    const fixture = baseDeps(sqlite);
    expect(await runDoctor(fixture.deps)).toBe(0);
    expect(fixture.storage.query).toHaveBeenCalledWith("PRAGMA integrity_check");
    expect(fixture.lines).toContain("ok  schema: 8 required tables");
    expect(fixture.lines.some(line => line.startsWith("ok  plugin:"))).toBe(true);
  });

  it("passes PostgreSQL and enabled local embeddings without printing its URL", async () => {
    const fixture = baseDeps(postgres);
    expect(await runDoctor({
      ...fixture.deps,
      getEmbeddingsEnabled: () => true,
      isSharedDepsInstalled: () => true,
    })).toBe(0);
    expect(fixture.storage.query).not.toHaveBeenCalled();
    expect(fixture.lines.join("\n")).not.toContain(postgres.connectionUrl);
    expect(fixture.lines.join("\n")).toContain("PostgreSQL schema memoree");
  });

  it("reports missing configuration, Claude, plugin, hooks, and embeddings", async () => {
    const fixture = baseDeps(null);
    const code = await runDoctor({
      ...fixture.deps,
      getEmbeddingsEnabled: () => true,
      existsSync: () => false,
      execFileSync: (() => { throw new Error("missing"); }) as never,
    });
    expect(code).toBe(1);
    expect(fixture.lines.join("\n")).toContain("MEMOREE_POSTGRES_URL is missing");
    expect(fixture.lines.join("\n")).toContain("claude executable not found");
    expect(fixture.lines.join("\n")).toContain("unable to inspect Claude plugins");
  });

  it("reports database, integrity, schema, and plugin failures", async () => {
    const brokenDatabase = baseDeps(sqlite, backend({ initializeError: new Error("database locked") }));
    expect(await runDoctor(brokenDatabase.deps)).toBe(1);
    expect(brokenDatabase.lines.join("\n")).toContain("database locked");

    const brokenChecks = baseDeps(sqlite, backend({ integrity: "corrupt", tables: ["memory"] }));
    expect(await runDoctor({
      ...brokenChecks.deps,
      execFileSync: ((_file: string, args: readonly string[]) => args[0] === "plugin" ? "other-plugin" : "claude 1") as never,
    })).toBe(1);
    expect(brokenChecks.lines.join("\n")).toContain("failed integrity_check");
    expect(brokenChecks.lines.join("\n")).toContain("missing sessions");
    expect(brokenChecks.lines.join("\n")).toContain("FAIL  plugin:");
  });
});
