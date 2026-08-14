/**
 * Product behavior for hybrid graph query/ and skill-catalog hygiene.
 * Calls the VFS and hygiene functions directly — no Claude Code or Codex.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleGraphVfs, handleGraphVfsAsync } from "../../src/graph/vfs-handler.js";
import { writeLastBuild } from "../../src/graph/last-build.js";
import { repoDir } from "../../src/graph/snapshot.js";
import {
  writeNodeEmbeddings,
  _clearNodeEmbeddingIndexCacheForTesting,
} from "../../src/graph/node-embeddings.js";
import { deriveProjectKey } from "../../src/utils/repo-identity.js";
import type { GraphSnapshot } from "../../src/graph/types.js";
import { maybeSpawnHygieneWorker } from "../../src/skillify/spawn-hygiene-worker.js";
import { hygieneLockKey, runHygieneCycle } from "../../src/skillify/hygiene.js";
import { writeNewSkill } from "../../src/skillify/skill-writer.js";
import { releaseWorkerLock } from "../../src/skillify/state.js";

const SNAPSHOT_SHA = "a".repeat(64);
const COMMIT = "deadbeef";

const WRITE = "src/snapshot.ts:writeSnapshot:function";
const PERSIST = "src/snapshot.ts:persistGraph:function";

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
        id: WRITE, label: "writeSnapshot", kind: "function",
        source_file: "src/snapshot.ts", source_location: "L1", language: "typescript", exported: true,
      },
      {
        id: PERSIST, label: "persistGraph", kind: "function",
        source_file: "src/snapshot.ts", source_location: "L20", language: "typescript", exported: true,
        doc: "flush the snapshot bytes to disk",
      },
    ],
    links: [
      { source: PERSIST, target: WRITE, relation: "calls", confidence: "EXTRACTED" },
    ],
  };
}

describe("graph query/ and hygiene (VFS)", () => {
  let cwd: string;
  let baseDir: string;
  let prevWorker: string | undefined;
  let projectKey: string;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "vfs-behavior-"));
    _clearNodeEmbeddingIndexCacheForTesting();
    prevWorker = process.env.MEMOREE_SKILLIFY_WORKER;
    delete process.env.MEMOREE_SKILLIFY_WORKER;
    projectKey = deriveProjectKey(cwd).key;
    baseDir = repoDir(projectKey);

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
    try { releaseWorkerLock(hygieneLockKey(projectKey)); } catch { /* ignore */ }
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevWorker === undefined) delete process.env.MEMOREE_SKILLIFY_WORKER;
    else process.env.MEMOREE_SKILLIFY_WORKER = prevWorker;
    _clearNodeEmbeddingIndexCacheForTesting();
  });

  const hybrid = {
    embeddingsEnabled: true,
    embedQuery: async () => [1, 0],
  };

  it("query/store fills persistGraph from the sidecar; find/store does not", async () => {
    const find = handleGraphVfs("find/store", cwd);
    expect(find.kind).toBe("ok");
    if (find.kind === "ok") expect(find.body).toMatch(/No matches for "store"/);

    const query = await handleGraphVfsAsync("query/store", cwd, hybrid);
    expect(query.kind).toBe("ok");
    if (query.kind === "ok") {
      expect(query.body).toContain(PERSIST);
      expect(query.body).not.toMatch(/No matches for "store"/);
    }
  });

  it("query/writeSnapshot ranks the name hit above the persistGraph fill", async () => {
    const r = await handleGraphVfsAsync("query/writeSnapshot", cwd, hybrid);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      const writeAt = r.body.indexOf(WRITE);
      const persistAt = r.body.indexOf(PERSIST);
      expect(writeAt).toBeGreaterThan(-1);
      expect(persistAt).toBeGreaterThan(-1);
      expect(writeAt).toBeLessThan(persistAt);
    }
  });

  it("query/store is lexical-only when embeddings are off", async () => {
    const r = await handleGraphVfsAsync("query/store", cwd, {
      embeddingsEnabled: false,
      embedQuery: async () => [1, 0],
    });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.body).toMatch(/No matches for "store"/);
  });

  it("impact/ and show/ stay exact walks", async () => {
    const impact = await handleGraphVfsAsync("impact/writeSnapshot", cwd, hybrid);
    expect(impact).toEqual(handleGraphVfs("impact/writeSnapshot", cwd));
    if (impact.kind === "ok") expect(impact.body).toContain("persistGraph");

    const show = await handleGraphVfsAsync("show/writeSnapshot", cwd, hybrid);
    expect(show).toEqual(handleGraphVfs("show/writeSnapshot", cwd));
  });

  it("SessionStart spawn requests the hygiene worker", () => {
    const spawnCalls: string[][] = [];
    const spawned = maybeSpawnHygieneWorker({
      cwd,
      bundleDir: "/bundle",
      agent: "claude_code",
      spawnFn: (workerPath, args = []) => {
        spawnCalls.push([workerPath, ...args]);
      },
    });
    expect(spawned).toEqual({ triggered: true });
    expect(spawnCalls[0]?.[0]).toBe("/bundle/hygiene-worker.js");
  });

  it("hygiene dry-run prints a plan and does not delete", async () => {
    const skillsRoot = join(cwd, ".claude", "skills");
    mkdirSync(skillsRoot, { recursive: true });
    writeNewSkill({
      skillsRoot, name: "alpha", description: "alpha skill",
      body: "## When to use\n\nFor A.\n", sourceSessions: ["sess-1"], agent: "claude_code",
    });
    writeNewSkill({
      skillsRoot, name: "beta", description: "beta skill",
      body: "## When to use\n\nFor B.\n", sourceSessions: ["sess-1"], agent: "claude_code",
    });
    mkdirSync(join(skillsRoot, "hand"), { recursive: true });
    writeFileSync(join(skillsRoot, "hand", "SKILL.md"), "# Hand written\n\nDo not touch.\n");

    const result = await runHygieneCycle({
      cwd, projectKey, agent: "claude_code", dryRun: true, force: true,
      runGateFn: () => ({
        stdout: JSON.stringify({
          actions: [
            { op: "unchanged", name: "alpha" },
            { op: "archive", name: "beta", reason: "dup" },
          ],
        }),
        stderr: "", errored: false,
      }),
    });
    expect(result.kind).toBe("dry-run");
    expect(existsSync(join(skillsRoot, "beta", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsRoot, "hand", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(skillsRoot, "hand", "SKILL.md"), "utf8")).toContain("Do not touch");
  });

  it("hygiene refuses an incomplete plan and leaves skills on disk", async () => {
    const skillsRoot = join(cwd, ".claude", "skills");
    mkdirSync(skillsRoot, { recursive: true });
    writeNewSkill({
      skillsRoot, name: "alpha", description: "alpha skill",
      body: "## When to use\n\nFor A.\n", sourceSessions: ["sess-1"], agent: "claude_code",
    });
    writeNewSkill({
      skillsRoot, name: "beta", description: "beta skill",
      body: "## When to use\n\nFor B.\n", sourceSessions: ["sess-1"], agent: "claude_code",
    });

    const result = await runHygieneCycle({
      cwd, projectKey, agent: "claude_code", force: true,
      runGateFn: () => ({
        stdout: JSON.stringify({
          actions: [{ op: "archive", name: "beta", reason: "dup" }],
        }),
        stderr: "", errored: false,
      }),
    });
    expect(result.kind).toBe("failed-llm");
    expect(existsSync(join(skillsRoot, "alpha", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsRoot, "beta", "SKILL.md"))).toBe(true);
  });
});
