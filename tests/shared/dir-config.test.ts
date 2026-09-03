import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromStorage, type SqliteStorageConfig } from "../../src/config.js";
import { findDirConfig, parseDirConfig, resolveDirConfig } from "../../src/dir-config.js";

let root: string;

function base() {
  const storage: SqliteStorageConfig = {
    kind: "sqlite",
    path: join(root, "memoree.sqlite3"),
    orgId: "local",
    orgName: "local",
    userName: "alice",
    workspaceId: "default",
    tableName: "memory",
    sessionsTableName: "sessions",
    skillsTableName: "skills",
    rulesTableName: "memoree_rules",
    goalsTableName: "memoree_goals",
    kpisTableName: "memoree_kpis",
    docsTableName: "memoree_docs",
    codebaseTableName: "codebase",
    memoryPath: join(root, "memory"),
    vectorScanLimit: 100,
  };
  return configFromStorage(storage);
}

function directory(...parts: string[]): string {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

function writeConfig(path: string, name: ".memoree" | ".memoree.local", value: unknown): void {
  writeFileSync(join(path, name), typeof value === "string" ? value : JSON.stringify(value));
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "memoree-dir-config-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("directory configuration", () => {
  it("accepts only repositoryKey and collect", () => {
    expect(parseDirConfig(JSON.stringify({ repositoryKey: "repo-a", collect: false, token: "ignored" })))
      .toEqual({ repositoryKey: "repo-a", collect: false });
    expect(parseDirConfig("[]")).toBeNull();
    expect(parseDirConfig("{bad")).toBeNull();
  });

  it("walks upward and prefers the nearest configuration", () => {
    writeConfig(directory("repo"), ".memoree", { repositoryKey: "outer" });
    writeConfig(directory("repo", "packages", "app"), ".memoree", { repositoryKey: "inner" });
    expect(findDirConfig(directory("repo", "packages", "app", "src"), root)?.raw.repositoryKey).toBe("inner");
  });

  it("prefers .memoree.local in the same directory", () => {
    const repo = directory("repo");
    writeConfig(repo, ".memoree", { repositoryKey: "shared" });
    writeConfig(repo, ".memoree.local", { repositoryKey: "personal" });
    expect(findDirConfig(repo, root)?.raw.repositoryKey).toBe("personal");
  });

  it("routes both the public config and nested storage config", () => {
    const repo = directory("repo");
    writeConfig(repo, ".memoree", { repositoryKey: "project-x" });
    const result = resolveDirConfig(base(), repo);
    expect(result.config.workspaceId).toBe("project-x");
    expect(result.config.storage.workspaceId).toBe("project-x");
    expect(result.collect).toBe(true);
  });

  it("supports repository-level capture opt-out without changing reads", () => {
    const repo = directory("repo");
    writeConfig(repo, ".memoree", { repositoryKey: "read-only", collect: false });
    const result = resolveDirConfig(base(), repo);
    expect(result.collect).toBe(false);
    expect(result.config.workspaceId).toBe("read-only");
  });

  it("remaps a plugin-install cwd before walking for .memoree", () => {
    const repo = directory("repo");
    writeConfig(repo, ".memoree", { repositoryKey: "from-workspace" });
    const plugin = directory(".claude", "plugins", "cache", "memoree", "memoree", "0.7.153");
    const prev = process.env.CLAUDE_PROJECT_DIR;
    try {
      process.env.CLAUDE_PROJECT_DIR = repo;
      const result = resolveDirConfig(base(), plugin);
      expect(result.config.workspaceId).toBe("from-workspace");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prev;
    }
  });
});
