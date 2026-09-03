import { describe, expect, it, vi } from "vitest";
import { runDoctor, findInstalledClaudeHookBundle, parseSemver } from "../../src/commands/doctor.js";
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
    expect(fixture.lines.some(line => line.startsWith("ok  Codex:"))).toBe(true);
    expect(fixture.lines.some(line => line.startsWith("ok  Codex hook bundles:"))).toBe(true);
    expect(fixture.lines.some(line => line.startsWith("ok  Antigravity:"))).toBe(true);
    expect(fixture.lines.some(line => line.startsWith("ok  Antigravity hook bundles:"))).toBe(true);
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

  it("reports Codex binary and hook bundle failures when Codex is installed", async () => {
    const fixture = baseDeps(sqlite);
    const code = await runDoctor({
      ...fixture.deps,
      existsSync: path => {
        const value = String(path);
        if (value.includes("/.codex/memoree/bundle")) return !value.endsWith(".js");
        return true;
      },
      execFileSync: ((file: string, args: readonly string[]) => {
        if (file === "codex") throw new Error("missing");
        if (args[0] === "plugin") return "memoree@memoree enabled";
        return "claude 1";
      }) as never,
    });
    expect(code).toBe(1);
    expect(fixture.lines.join("\n")).toContain("codex executable not found");
    expect(fixture.lines.join("\n")).toContain("FAIL  Codex hook bundles:");
  });

  it("skips Codex checks when the Codex plugin is not installed", async () => {
    const fixture = baseDeps(sqlite);
    expect(await runDoctor({
      ...fixture.deps,
      existsSync: path => !String(path).includes(".codex"),
    })).toBe(0);
    expect(fixture.lines.join("\n")).not.toContain("Codex");
  });

  it("skips Antigravity checks when the plugin is not installed", async () => {
    const fixture = baseDeps(sqlite);
    expect(await runDoctor({
      ...fixture.deps,
      existsSync: path => !String(path).includes(".gemini"),
    })).toBe(0);
    expect(fixture.lines.join("\n")).not.toContain("Antigravity");
  });

  it("does not FAIL hook bundles when Claude cache and checkout harnesses are both absent", async () => {
    const fixture = baseDeps(sqlite);
    const code = await runDoctor({
      ...fixture.deps,
      pkgRoot: () => "/home/alice/.codex/memoree/bundle",
      existsSync: path => {
        const value = String(path);
        if (value.includes("harnesses/claude-code")) return false;
        if (value.includes("plugins/cache/memoree")) return false;
        return true;
      },
    });
    expect(code).toBe(0);
    expect(fixture.lines.join("\n")).toContain("Claude plugin cache not installed");
    expect(fixture.lines.join("\n")).not.toContain("FAIL  hook bundles:");
  });

  it("reports Antigravity binary and hook bundle failures when installed", async () => {
    const fixture = baseDeps(sqlite);
    const code = await runDoctor({
      ...fixture.deps,
      existsSync: path => {
        const value = String(path);
        if (value.includes("/.codex/memoree/bundle")) return false;
        if (value.includes("config/plugins/memoree/bundle") || value.includes("antigravity-cli/plugins/memoree/bundle")) {
          return !value.endsWith(".js");
        }
        return true;
      },
      execFileSync: ((file: string, args: readonly string[]) => {
        if (file === "agy") throw new Error("missing");
        if (args[0] === "plugin") return "memoree@memoree enabled";
        return "claude 1";
      }) as never,
    });
    expect(code).toBe(1);
    expect(fixture.lines.join("\n")).toContain("agy executable not found");
    expect(fixture.lines.join("\n")).toContain("FAIL  Antigravity hook bundles:");
  });

  it("does not FAIL Claude hook bundles when only the Codex plugin layout is pkgRoot", async () => {
    const fixture = baseDeps(sqlite);
    const cacheBundle = "/home/alice/.claude/plugins/cache/memoree/memoree/0.7.151/bundle";
    const code = await runDoctor({
      ...fixture.deps,
      pkgRoot: () => "/home/alice/.codex/memoree/bundle",
      readdirSync: ((path: string) => {
        if (String(path).endsWith("cache/memoree/memoree")) return ["0.7.145", "0.7.151"];
        return [];
      }) as never,
      existsSync: path => {
        const value = String(path);
        if (value.includes("harnesses/claude-code")) return false;
        if (value.includes("/0.7.145")) return !value.endsWith(".orphaned_at") && !value.endsWith(".js");
        if (value.includes("/0.7.151")) return !value.endsWith(".orphaned_at");
        if (value.includes(".orphaned_at")) return false;
        return true;
      },
    });
    expect(code).toBe(0);
    expect(fixture.lines.some(line => line.startsWith(`ok  hook bundles: ${cacheBundle}`))).toBe(true);
    expect(fixture.lines.join("\n")).not.toContain("FAIL  hook bundles:");
  });

  it("skips an orphaned Claude cache version when picking hook bundles", async () => {
    const fixture = baseDeps(sqlite);
    await runDoctor({
      ...fixture.deps,
      pkgRoot: () => "/home/alice/.codex/memoree/bundle",
      readdirSync: ((path: string) => {
        if (String(path).endsWith("cache/memoree/memoree")) return ["0.7.145", "0.7.151"];
        return [];
      }) as never,
      existsSync: path => {
        const value = String(path);
        if (value.includes("harnesses/claude-code")) return false;
        if (value.includes("/0.7.151/.orphaned_at")) return false;
        if (value.includes("/0.7.145/.orphaned_at")) return true;
        if (value.includes("/0.7.145") || value.includes("/0.7.151")) return true;
        return true;
      },
    });
    expect(fixture.lines.join("\n")).toContain("ok  hook bundles: /home/alice/.claude/plugins/cache/memoree/memoree/0.7.151/bundle");
    expect(fixture.lines.join("\n")).not.toContain("0.7.145/bundle");
  });

  it("warns when PATH memoree version disagrees with the hook stamp", async () => {
    const fixture = baseDeps(sqlite);
    const code = await runDoctor({
      ...fixture.deps,
      execFileSync: ((file: string, args: readonly string[]) => {
        if (file === "memoree") return "0.7.145\n";
        if (args[0] === "plugin") return "memoree@memoree enabled";
        return "claude 1";
      }) as never,
      readFileSync: ((path: string) => {
        if (String(path).endsWith(".memoree_version")) return "0.7.151";
        return "";
      }) as never,
    });
    expect(code).toBe(0);
    expect(fixture.lines.join("\n")).toContain("PATH memoree 0.7.145");
    expect(fixture.lines.join("\n")).toContain("hook stamp 0.7.151");
    expect(fixture.lines.join("\n")).toContain("npx -y @sskarz/memoree install");
  });
});

describe("findInstalledClaudeHookBundle / parseSemver", () => {
  it("parses a semver out of memoree --version text", () => {
    expect(parseSemver("0.7.145\n")).toBe("0.7.145");
    expect(parseSemver("memoree 0.7.151")).toBe("0.7.151");
    expect(parseSemver("claude 1")).toBeNull();
  });

  it("returns the newest non-orphaned cache bundle", () => {
    const exists = (path: string) => {
      if (path.endsWith(".orphaned_at")) return path.includes("0.7.145");
      return path.includes("0.7.145") || path.includes("0.7.151") || path.endsWith("memoree/memoree");
    };
    const found = findInstalledClaudeHookBundle("/home/alice", exists, () => ["0.7.145", "0.7.151"]);
    expect(found).toBe("/home/alice/.claude/plugins/cache/memoree/memoree/0.7.151/bundle");
  });

  it("returns null when the cache is missing", () => {
    expect(findInstalledClaudeHookBundle("/home/alice", () => false, () => [])).toBeNull();
  });
});
