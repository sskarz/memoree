// Bundle-level guard: make sure the shipped hook bundles contain the new
// embedding columns in their INSERT statements. Catches regressions where
// the schema migration is done in src/ but a bundle referencing the old
// column list remains in the shipped artifact.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_COLUMNS, SESSIONS_COLUMNS, renderColumnSql } from "../../src/storage/schema.js";

const BUNDLE_DIRS = [
  "harnesses/claude-code/bundle",
  "harnesses/codex/bundle",
];

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

describe("shipped bundles include embedding columns", () => {
  for (const dir of BUNDLE_DIRS) {
    it(`${dir}/capture.js writes message_embedding`, () => {
      const src = read(join(dir, "capture.js"));
      expect(src).toMatch(/message_embedding/);
    });

    it(`${dir}/shell/memoree-shell.js writes summary_embedding`, () => {
      const src = read(join(dir, "shell/memoree-shell.js"));
      expect(src).toMatch(/summary_embedding/);
    });

    it(`${dir} has an embed-daemon bundle`, () => {
      // Just check the file exists and is non-empty — not runnable without deps.
      const src = read(join(dir, "embeddings/embed-daemon.js"));
      expect(src.length).toBeGreaterThan(100);
    });
  }
});

describe("src-level schema includes new embedding columns", () => {
  // Schemas moved from inline strings in memoree-api.ts to structured
  // arrays in storage/schema.ts. The bundles still need to inline these
  // columns, but the source of truth is now the new module.
  it("MEMORY_COLUMNS includes a PostgreSQL vector array", () => {
    const column = MEMORY_COLUMNS.find(item => item.name === "summary_embedding");
    expect(column?.type).toBe("vector");
    expect(renderColumnSql(column!, "postgres")).toBe("DOUBLE PRECISION[]");
  });

  it("SESSIONS_COLUMNS includes a PostgreSQL vector array", () => {
    const column = SESSIONS_COLUMNS.find(item => item.name === "message_embedding");
    expect(column?.type).toBe("vector");
    expect(renderColumnSql(column!, "postgres")).toBe("DOUBLE PRECISION[]");
  });

  it("embedding columns do NOT use TEXT (regression guard)", () => {
    expect(renderColumnSql(MEMORY_COLUMNS.find(item => item.name === "summary_embedding")!, "postgres")).not.toBe("TEXT");
    expect(renderColumnSql(SESSIONS_COLUMNS.find(item => item.name === "message_embedding")!, "sqlite")).toBe("TEXT");
  });
});
