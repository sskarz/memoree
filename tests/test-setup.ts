// Global vitest setup. Runs once before any test file.
//
// Keep every supported Memoree state path out of the developer's real home.
// Several source suites exercise graph snapshots, skillify locks, and SQLite
// directly; isolating config.json alone still lets those tests create files
// under ~/.memoree. Each Vitest worker gets its own setup directory, which is
// removed after that worker's tests finish.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const tmpDir = mkdtempSync(join(tmpdir(), "memoree-test-config-"));
const priorHome = process.env.HOME;
const priorClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const priorCodexHome = process.env.CODEX_HOME;
process.env.HOME = tmpDir;
process.env.CLAUDE_CONFIG_DIR = join(tmpDir, ".claude");
process.env.CODEX_HOME = join(tmpDir, ".codex");
process.env.MEMOREE_CONFIG_PATH = join(tmpDir, "config.json");
process.env.MEMOREE_SQLITE_PATH = join(tmpDir, "memoree.sqlite3");
process.env.MEMOREE_MEMORY_PATH = join(tmpDir, "memory");
process.env.MEMOREE_GRAPHS_HOME = join(tmpDir, "graphs");

// Default to embeddings-enabled in the test env, matching fresh installs.
// Tests that exercise the disabled path set their
// own values via _setEnabledReaderForTesting or by writing the config file
// directly.
process.env.MEMOREE_EMBEDDINGS = "true";

afterAll(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  if (priorClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = priorClaudeConfigDir;
  if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = priorCodexHome;
  rmSync(tmpDir, { recursive: true, force: true });
});
