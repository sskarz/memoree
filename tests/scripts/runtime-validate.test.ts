import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeProfileRoot,
  isolatedCounts,
  prepareIsolatedClaudeConfig,
  waitForCapture,
} from "../../scripts/runtime-validate.mjs";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function createValidationDatabase(): { databasePath: string; db: DatabaseSync } {
  root = mkdtempSync(join(tmpdir(), "runtime-validate-test-"));
  const databasePath = join(root, "memoree.sqlite3");
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE sessions (message TEXT); CREATE TABLE memory (path TEXT, summary TEXT);");
  return { databasePath, db };
}

describe("runtime validation polling", () => {
  it("requires the requested fact to appear in a summary, not merely any summary", async () => {
    const { databasePath, db } = createValidationDatabase();
    db.prepare("INSERT INTO sessions (message) VALUES (?)").run("fact-123");
    db.prepare("INSERT INTO memory (path, summary) VALUES (?, ?)").run(
      "/summaries/test/unrelated.md",
      "an unrelated summary",
    );
    db.close();

    expect(isolatedCounts(databasePath, "fact-123")).toEqual({
      matchingEvents: 1,
      summaries: 1,
      matchingSummaries: 0,
    });
    await expect(waitForCapture(databasePath, "fact-123", {
      requireSummary: true,
      timeoutMs: 10,
      pollMs: 1,
    })).rejects.toThrow(/matchingSummaries=0/);
  });

  it("returns after both the event and matching summary are present", async () => {
    const { databasePath, db } = createValidationDatabase();
    db.prepare("INSERT INTO sessions (message) VALUES (?)").run("fact-456");
    db.prepare("INSERT INTO memory (path, summary) VALUES (?, ?)").run(
      "/summaries/test/matching.md",
      "the remembered value is fact-456",
    );
    db.close();

    await expect(waitForCapture(databasePath, "fact-456", {
      requireSummary: true,
      timeoutMs: 100,
      pollMs: 1,
    })).resolves.toEqual({
      matchingEvents: 1,
      summaries: 1,
      matchingSummaries: 1,
    });
  });
});

describe("runtime validation Claude configuration", () => {
  it("uses the home directory as Claude's default profile root", () => {
    expect(claudeProfileRoot({}, "/Users/tester")).toBe("/Users/tester");
    expect(claudeProfileRoot({ CLAUDE_CONFIG_DIR: "/custom/claude" }, "/Users/tester"))
      .toBe("/custom/claude");
  });

  it("copies profile metadata and settings into disposable state", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "runtime-validate-claude-test-"));
    root = testRoot;
    const source = join(testRoot, "real-profile");
    const target = join(testRoot, "isolated-profile");
    const autoMemory = join(testRoot, "state", "auto-memory");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "test" } }));

    const settingsPath = prepareIsolatedClaudeConfig(source, target, autoMemory);

    expect(JSON.parse(readFileSync(join(target, ".claude.json"), "utf8"))).toEqual({
      oauthAccount: { accountUuid: "test" },
    });
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      autoMemoryDirectory: autoMemory,
    });
    expect(existsSync(join(source, "settings.json"))).toBe(false);
  });

  it("fails clearly when Claude has no authenticated profile metadata", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "runtime-validate-claude-missing-"));
    root = testRoot;
    expect(() => prepareIsolatedClaudeConfig(
      join(testRoot, "missing"),
      join(testRoot, "isolated"),
      join(testRoot, "auto-memory"),
    )).toThrow(/claude auth login/);
  });
});
