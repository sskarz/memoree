import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticatedClaudeEnvironment,
  isolatedCounts,
  lexicalValidationPrompt,
  waitForCapture,
} from "../../scripts/runtime-validate.mjs";
import { redactSecrets } from "../../src/hooks/shared/redact.js";

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

  it("accepts a summary that preserves the exact identifier while paraphrasing the fact", async () => {
    const { databasePath, db } = createValidationDatabase();
    const identifier = "a912d384-5605-43ab-bae7-e34b50e6f81a";
    db.prepare("INSERT INTO sessions (message) VALUES (?)").run(
      `the observatory lantern is ${identifier}`,
    );
    db.prepare("INSERT INTO memory (path, summary) VALUES (?, ?)").run(
      "/summaries/test/paraphrased.md",
      `The exact identifier recorded for the observatory lantern was ${identifier}.`,
    );
    db.close();

    await expect(waitForCapture(databasePath, identifier, {
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
  it("uses the authenticated HOME and suppresses nonessential profile writes", () => {
    expect(authenticatedClaudeEnvironment({ MEMOREE_SQLITE_PATH: "/tmp/test.sqlite3" }, "/Users/tester"))
      .toMatchObject({
        HOME: "/Users/tester",
        MEMOREE_SQLITE_PATH: "/tmp/test.sqlite3",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      });
  });

  it("removes the disposable config override for a default Claude profile", () => {
    const env = authenticatedClaudeEnvironment({
      HOME: "/tmp/disposable",
      CLAUDE_CONFIG_DIR: "/tmp/disposable/.claude",
    }, "/Users/tester");
    expect(env.HOME).toBe("/Users/tester");
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("preserves an explicitly configured authenticated Claude profile", () => {
    const env = authenticatedClaudeEnvironment({}, "/Users/tester", "/custom/claude");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/custom/claude");
  });
});

describe("runtime validation lexical marker", () => {
  it("survives capture redaction as an exact searchable identifier", () => {
    const identifier = "3b4aa504-2da6-4ad1-995b-293f1254d6c3";
    const prompt = lexicalValidationPrompt(identifier);
    expect(redactSecrets(prompt)).toBe(prompt);
    expect(prompt).toContain(identifier);
  });

  it("guards against the secret-like token label used by the failed validator", () => {
    const identifier = "3b4aa504-2da6-4ad1-995b-293f1254d6c3";
    expect(redactSecrets(`Repeat this exact lexical fallback token: memoree-lexical-${identifier}`))
      .not.toContain(identifier);
  });
});
