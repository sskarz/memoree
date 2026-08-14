/**
 * Claude Code and Codex hook wiring for graph query/ and SessionStart hygiene.
 * Asserts routing only: the VFS was reached, and SessionStart calls the
 * hygiene worker after auto-pull. Product ranking and spawn quiet/lock
 * live in graph-query-and-hygiene.test.ts and skillify-hygiene.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processPreToolUse } from "../../src/hooks/pre-tool-use.js";
import { processCodexPreToolUse } from "../../src/hooks/codex/pre-tool-use.js";
import { processClaudeSessionStart } from "../../src/hooks/session-start.js";
import { processCodexSessionStart } from "../../src/hooks/codex/session-start.js";
import { tryGraphRead } from "../../src/graph/graph-command.js";
import { handleGraphVfsAsync } from "../../src/graph/vfs-handler.js";
import { writeLastBuild } from "../../src/graph/last-build.js";
import { repoDir } from "../../src/graph/snapshot.js";
import {
  writeNodeEmbeddings,
  _clearNodeEmbeddingIndexCacheForTesting,
} from "../../src/graph/node-embeddings.js";
import { deriveProjectKey } from "../../src/utils/repo-identity.js";
import type { GraphSnapshot } from "../../src/graph/types.js";
import type { HygieneSpawnOptions } from "../../src/skillify/spawn-hygiene-worker.js";

const SNAPSHOT_SHA = "a".repeat(64);
const COMMIT = "deadbeef";
const PERSIST = "src/snapshot.ts:persistGraph:function";

const dummyConfig = {
  userName: "alice", orgId: "local", orgName: "local", workspaceId: "default",
  storage: { kind: "sqlite" }, rulesTableName: "memoree_rules",
  goalsTableName: "memoree_goals", kpisTableName: "memoree_kpis",
} as any;

function worktreeId(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function fixtureSnapshot(): GraphSnapshot {
  return {
    directed: true,
    multigraph: true,
    graph: { schema_version: 1, generator: "memoree-graph", commit_sha: COMMIT, repo_key: "k" },
    observation: {
      ts: "2026-08-14T00:00:00Z",
      branch: "main",
      worktree_path: "/fixture",
      repo_project: "fixture",
      generator_version: "0",
      source_files_extracted: 1,
      source_files_skipped: 0,
    },
    nodes: [
      {
        id: "src/snapshot.ts:writeSnapshot:function", label: "writeSnapshot", kind: "function",
        source_file: "src/snapshot.ts", source_location: "L1", language: "typescript", exported: true,
      },
      {
        id: PERSIST, label: "persistGraph", kind: "function",
        source_file: "src/snapshot.ts", source_location: "L20", language: "typescript", exported: true,
        doc: "flush the snapshot bytes to disk",
      },
    ],
    links: [],
  };
}

const vfsDeps = {
  embeddingsEnabled: true,
  embedQuery: async () => [1, 0],
};

describe("harness wiring: graph query/", () => {
  let cwd: string;
  let baseDir: string;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "harness-wire-"));
    _clearNodeEmbeddingIndexCacheForTesting();
    const { key } = deriveProjectKey(cwd);
    baseDir = repoDir(key);

    const snapshotsDir = join(baseDir, "snapshots");
    mkdirSync(snapshotsDir, { recursive: true });
    const snap = fixtureSnapshot();
    writeFileSync(join(snapshotsDir, `${COMMIT}.json`), JSON.stringify(snap));
    writeLastBuild(baseDir, {
      ts: Date.now(),
      commit_sha: COMMIT,
      snapshot_sha256: SNAPSHOT_SHA,
      node_count: snap.nodes.length,
      edge_count: snap.links.length,
    }, worktreeId(cwd));

    await writeNodeEmbeddings(snap, baseDir, SNAPSHOT_SHA, {
      enabled: true,
      embed: async (text) => (text.includes("persistGraph") ? [1, 0] : [0, 1]),
    });
  });

  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ignore */ }
    _clearNodeEmbeddingIndexCacheForTesting();
  });

  it("Codex cat of query/store is answered by the VFS", async () => {
    const decision = await processCodexPreToolUse(
      {
        session_id: "s", tool_name: "shell", tool_use_id: "t",
        tool_input: { command: "cat ~/.memoree/memory/graph/query/store" },
        cwd, hook_event_name: "pre_tool_use", model: "test",
      },
      {
        config: dummyConfig,
        createApi: vi.fn(() => ({ query: vi.fn() })) as any,
        tryGraphReadFn: (cmd, graphCwd) => tryGraphRead(cmd, graphCwd, vfsDeps),
        logFn: vi.fn(),
      },
    );
    expect(decision.action).toBe("allow");
    expect(decision.output).toContain(PERSIST);
  });

  it("Claude Bash cat of query/store uses the session cwd", async () => {
    const decision = await processPreToolUse(
      {
        cwd,
        session_id: "s",
        tool_name: "Bash",
        tool_use_id: "t",
        tool_input: { command: "cat ~/.memoree/memory/graph/query/store" },
      },
      {
        config: dummyConfig,
        createApi: vi.fn(() => ({ query: vi.fn() })) as any,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        handleGraphVfsFn: (subpath, graphCwd) => handleGraphVfsAsync(subpath, graphCwd, vfsDeps),
        logFn: vi.fn(),
      },
    );
    expect(decision?.command).toContain("persistGraph");
    expect(decision?.description).toContain("query/store");
  });

  it("Claude Read of query/store is a file, not a directory", async () => {
    const decision = await processPreToolUse(
      {
        cwd,
        session_id: "s",
        tool_name: "Read",
        tool_use_id: "t",
        tool_input: { file_path: "~/.memoree/memory/graph/query/store" },
      },
      {
        config: dummyConfig,
        createApi: vi.fn(() => ({ query: vi.fn() })) as any,
        handleGraphVfsFn: (subpath, graphCwd) => handleGraphVfsAsync(subpath, graphCwd, vfsDeps),
        logFn: vi.fn(),
      },
    );
    expect(decision?.file_path).toBeTruthy();
    expect(readFileSync(decision!.file_path!, "utf8")).toContain("persistGraph");
  });

  it("Claude ls of the graph mount lists query/", async () => {
    const decision = await processPreToolUse(
      {
        cwd,
        session_id: "s",
        tool_name: "Bash",
        tool_use_id: "t",
        tool_input: { command: "ls ~/.memoree/memory/graph/" },
      },
      {
        config: dummyConfig,
        createApi: vi.fn(() => ({ query: vi.fn() })) as any,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        logFn: vi.fn(),
      },
    );
    expect(decision?.command).toContain("query/");
  });
});

describe("harness wiring: SessionStart hygiene", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "harness-hygiene-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("Claude SessionStart spawns hygiene after auto-pull", async () => {
    const order: string[] = [];
    let hygiene: HygieneSpawnOptions | undefined;

    await processClaudeSessionStart(
      { session_id: "", cwd },
      {
        autoPullFn: async () => {
          order.push("pull");
          return { pulled: 0, skipped: true };
        },
        spawnHygieneFn: (opts) => {
          order.push("hygiene");
          hygiene = opts;
          return { triggered: true };
        },
        loadConfigFn: () => null,
        spawnGraphPullFn: vi.fn(),
      },
    );

    expect(order).toEqual(["pull", "hygiene"]);
    expect(hygiene).toMatchObject({ cwd, agent: "claude_code" });
    expect(hygiene?.bundleDir).toBeTruthy();
  });

  it("Codex SessionStart spawns hygiene after auto-pull", async () => {
    const order: string[] = [];
    let hygiene: HygieneSpawnOptions | undefined;

    await processCodexSessionStart(
      {
        session_id: "s",
        cwd,
        hook_event_name: "SessionStart",
        model: "test",
      },
      {
        autoPullFn: async () => {
          order.push("pull");
          return { pulled: 0, skipped: true };
        },
        spawnHygieneFn: (opts) => {
          order.push("hygiene");
          hygiene = opts;
          return { triggered: true };
        },
        loadConfigFn: () => null,
        spawnGraphPullFn: vi.fn(),
        spawnFn: (() => ({
          stdin: { write: vi.fn(), end: vi.fn() },
          unref: vi.fn(),
        })) as any,
      },
    );

    expect(order).toEqual(["pull", "hygiene"]);
    expect(hygiene).toMatchObject({ cwd, agent: "codex" });
    expect(hygiene?.bundleDir).toBeTruthy();
  });
});
