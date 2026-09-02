import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  RECALL_POISON_EMPTY_KEY_TOKEN,
  assertCheckoutHarnessPackageJsonUnnamed,
  assertEmbeddingsStatusLinked,
  assertInstalledPluginBundleIdentity,
  assertNoCompletedSummaryStubs,
  assertRecallSkippedIncidentRows,
  clearRecallIncidentRows,
  embeddingsStatusReportsLink,
  seedRecallIncidentRows,
  seedUnlinkedClaudeCacheVersion,
} from "../../scripts/runtime-validate.mjs";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("harness incident gates — script locks", () => {
  const validate = readFileSync(new URL("../../scripts/runtime-validate.mjs", import.meta.url), "utf8");
  const e2e = readFileSync(new URL("../../scripts/live-session-e2e.mjs", import.meta.url), "utf8");

  it("drives the installed Codex plugin for status/doctor, not only checkout bundles", () => {
    expect(validate).toContain("assertInstalledCodexShimHealth(isolatedHome");
    expect(validate).toContain("checking installed Codex shim status/doctor (not checkout bundles)");
    expect(e2e).toContain("assertInstalledCodexShimHealth(isolatedHome");
    expect(validate).toContain(".codex\", \"memoree\"");
    expect(validate).toContain('["--version"]');
    expect(validate).toContain('["doctor"]');
    expect(validate).toContain("FAIL\\s+hook bundles:");
  });

  it("rechecks embeddings after Codex install and after a new Claude cache version", () => {
    expect(validate).toContain("seedUnlinkedClaudeCacheVersion(isolatedHome)");
    expect(validate).toContain("embeddings\", \"install\"");
    expect(validate).toContain("assertEmbeddingsStatusLinked(embeddingsAfterRelink");
    expect(e2e).toContain("seedUnlinkedClaudeCacheVersion(isolatedHome)");
    expect(e2e).toContain("embeddings\", \"install\"");
    expect(e2e.indexOf("codex\", \"install\"")).toBeLessThan(e2e.indexOf("embeddings after Codex install"));
  });

  it("rejects completed stub summaries and seeds recall competitors before hook recall", () => {
    expect(validate).toContain("assertNoCompletedSummaryStubs(databasePath)");
    expect(validate).toContain("seedRecallIncidentRows(databasePath)");
    expect(validate).toContain("assertRecallSkippedIncidentRows(recallResult.stdout, \"Claude recall\")");
    expect(validate).toContain("assertRecallSkippedIncidentRows(codexRecallResult.stdout, \"Codex recall\")");
    expect(validate).toContain("clearRecallIncidentRows(databasePath)");
    expect(e2e).toContain("assertNoCompletedSummaryStubs(databasePath)");
    expect(e2e).toContain("seedRecallIncidentRows(databasePath)");
    expect(e2e).toContain(".codex\", \"memoree\", \"bundle\", \"recall.js\"");
    expect(e2e).toContain("assertRecallSkippedIncidentRows(recallHook");
    expect(validate).toContain("description.toLowerCase() !== \"completed\"");
  });

  it("keeps checkout harness package.json unnamed so pkgRoot walks to the package root", () => {
    expect(validate).toContain("assertCheckoutHarnessPackageJsonUnnamed(runtimeDir)");
  });
});

describe("harness incident gates — helpers", () => {
  it("rejects a named checkout harness package.json", () => {
    root = mkdtempSync(join(tmpdir(), "incident-unnamed-"));
    const bundle = join(root, "harnesses", "codex", "bundle");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "package.json"), JSON.stringify({ name: "memoree", version: "0.7.152", type: "module" }));
    expect(() => assertCheckoutHarnessPackageJsonUnnamed(root)).toThrow(/must stay unnamed/);
  });

  it("accepts unnamed checkout harness package.json stubs", () => {
    root = mkdtempSync(join(tmpdir(), "incident-unnamed-ok-"));
    const bundle = join(root, "harnesses", "codex", "bundle");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "package.json"), JSON.stringify({ type: "module" }));
    expect(() => assertCheckoutHarnessPackageJsonUnnamed(root)).not.toThrow();
  });

  it("requires the installed plugin bundle to be named and versioned", () => {
    root = mkdtempSync(join(tmpdir(), "incident-plugin-"));
    const pluginDir = join(root, ".codex", "memoree");
    mkdirSync(join(pluginDir, "bundle"), { recursive: true });
    writeFileSync(join(pluginDir, "bundle", "package.json"), JSON.stringify({ type: "module" }));
    expect(() => assertInstalledPluginBundleIdentity(pluginDir, "Codex")).toThrow(/named Memoree package/);
    writeFileSync(join(pluginDir, "bundle", "package.json"), JSON.stringify({ name: "memoree", version: "0.0.0", type: "module" }));
    expect(() => assertInstalledPluginBundleIdentity(pluginDir, "Codex")).toThrow(/0\.0\.0/);
    writeFileSync(join(pluginDir, "bundle", "package.json"), JSON.stringify({ name: "memoree", version: "0.7.152", type: "module" }));
    expect(() => assertInstalledPluginBundleIdentity(pluginDir, "Codex")).not.toThrow();
  });

  it("detects linked vs unlinked embeddings status lines", () => {
    const statusText = [
      "Agent installs:",
      "  codex                ✓ linked → shared",
      "  claude (9.9.9)       ✗ not linked",
      "",
    ].join("\n");
    expect(embeddingsStatusReportsLink(statusText, "codex", "✓ linked → shared")).toBe(true);
    expect(embeddingsStatusReportsLink(statusText, "claude (9.9.9)", "✗ not linked")).toBe(true);
    expect(() => assertEmbeddingsStatusLinked(statusText, "claude (9.9.9)", "relink")).toThrow(/did not show/);
  });

  it("fails when a wiki summary is still described as completed", () => {
    root = mkdtempSync(join(tmpdir(), "incident-completed-"));
    const databasePath = join(root, "memoree.sqlite3");
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE memory (path TEXT, description TEXT, summary TEXT)");
    db.prepare("INSERT INTO memory (path, description, summary) VALUES (?, ?, ?)").run(
      "/summaries/alice/s.md",
      "completed",
      "# Placeholder\n",
    );
    db.close();
    expect(() => assertNoCompletedSummaryStubs(databasePath)).toThrow(/completed stub description/);
  });

  it("allows in-progress placeholders and finalized wiki bodies", () => {
    root = mkdtempSync(join(tmpdir(), "incident-ok-summary-"));
    const databasePath = join(root, "memoree.sqlite3");
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE memory (path TEXT, description TEXT, summary TEXT)");
    db.prepare("INSERT INTO memory (path, description, summary) VALUES (?, ?, ?)").run(
      "/summaries/alice/placeholder.md",
      "in progress",
      "# Session\n",
    );
    db.prepare("INSERT INTO memory (path, description, summary) VALUES (?, ?, ?)").run(
      "/summaries/alice/done.md",
      "shipped the harbor kite recall fix",
      "## What Happened\nShipped the harbor kite recall fix.\n",
    );
    db.close();
    expect(() => assertNoCompletedSummaryStubs(databasePath)).not.toThrow();
  });

  it("seeds and clears recall competitors against an embedded donor row", () => {
    root = mkdtempSync(join(tmpdir(), "incident-seed-"));
    const databasePath = join(root, "memoree.sqlite3");
    const db = new DatabaseSync(databasePath);
    db.exec(`CREATE TABLE memory (
      id TEXT, path TEXT, filename TEXT, summary TEXT, summary_embedding TEXT,
      author TEXT, project TEXT, project_key TEXT, description TEXT,
      creation_date TEXT, last_update_date TEXT
    )`);
    db.prepare(
      "INSERT INTO memory (id, path, filename, summary, summary_embedding, author, project, project_key, description, creation_date, last_update_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "donor",
      "/summaries/alice/real.md",
      "real.md",
      "## What Happened\nReal work.\n## Key Facts\n- token\n",
      "[0.1,0.2]",
      "alice",
      "repo",
      "abc123",
      "real work",
      "2026-09-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    );
    db.close();
    seedRecallIncidentRows(databasePath);
    const after = new DatabaseSync(databasePath, { readOnly: true });
    const paths = after.prepare("SELECT path FROM memory ORDER BY path").all().map(row => row.path);
    after.close();
    expect(paths).toEqual([
      "/summaries/alice/real.md",
      "/summaries/poison-empty/session.md",
      "/summaries/poison-stub/session.md",
    ]);
    clearRecallIncidentRows(databasePath);
    const leftover = new DatabaseSync(databasePath, { readOnly: true });
    expect(leftover.prepare("SELECT COUNT(*) AS n FROM memory").get()?.n).toBe(1);
    leftover.close();
  });

  it("creates an unlinked Claude cache fixture with the hook files doctor checks", () => {
    root = mkdtempSync(join(tmpdir(), "incident-cache-"));
    const seeded = seedUnlinkedClaudeCacheVersion(root);
    expect(seeded.agentId).toBe("claude (9.9.9)");
    expect(existsSync(join(seeded.pluginDir, "bundle", "session-start.js"))).toBe(true);
    expect(existsSync(join(seeded.pluginDir, "bundle", "recall.js"))).toBe(true);
  });

  it("rejects recall stdout that injects stub excerpts or empty-key poison", () => {
    expect(() => assertRecallSkippedIncidentRows('excerpt: "completed"', "Claude recall"))
      .toThrow(/completed stub excerpt/);
    expect(() => assertRecallSkippedIncidentRows(`excerpt: "${RECALL_POISON_EMPTY_KEY_TOKEN}"`, "Claude recall"))
      .toThrow(/empty-key poison/);
    expect(() => assertRecallSkippedIncidentRows('excerpt: "shipped harbor kite"', "Claude recall"))
      .not.toThrow();
  });
});
