import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { isolatedCounts, waitForCapture } from "../../scripts/runtime-validate.mjs";

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
