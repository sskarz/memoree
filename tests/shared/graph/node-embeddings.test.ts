import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  nodeEmbedText,
  readNodeEmbeddings,
  writeNodeEmbeddings,
  nodeEmbeddingSidecarPath,
  readCachedNodeVector,
  writeCachedNodeVector,
} from "../../../src/graph/node-embeddings.js";
import { fileContentHash } from "../../../src/graph/cache.js";
import {
  _setEnabledReaderForTesting,
  _resetForTesting,
} from "../../../src/embeddings/disable.js";
import type { GraphNode, GraphSnapshot } from "../../../src/graph/types.js";

function node(partial: Partial<GraphNode> & Pick<GraphNode, "id" | "label">): GraphNode {
  return {
    kind: "function",
    source_file: "src/a.ts",
    source_location: "L1",
    language: "typescript",
    exported: true,
    ...partial,
  };
}

function snap(nodes: GraphNode[]): GraphSnapshot {
  return {
    directed: true,
    multigraph: true,
    graph: { schema_version: 1, generator: "memoree-graph", commit_sha: "c", repo_key: "k" },
    observation: {
      ts: "2026-01-01T00:00:00Z",
      branch: "main",
      worktree_path: "/t",
      repo_project: "t",
      generator_version: "0",
      source_files_extracted: 1,
      source_files_skipped: 0,
    },
    nodes,
    links: [],
  };
}

describe("nodeEmbedText", () => {
  it("joins kind label signature doc source_file", () => {
    expect(nodeEmbedText(node({
      id: "src/a.ts:foo:function",
      label: "foo",
      signature: "function foo()",
      doc: "does the thing",
    }))).toBe("function foo function foo() does the thing src/a.ts");
  });
});

describe("writeNodeEmbeddings", () => {
  let baseDir: string;
  const sha = "a".repeat(64);

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "node-embed-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("omits the sidecar when embeddings are disabled", async () => {
    const result = await writeNodeEmbeddings(
      snap([node({ id: "src/a.ts:foo:function", label: "foo" })]),
      baseDir,
      sha,
      { enabled: false, embed: async () => [1, 0] },
    );
    expect(result.written).toBe(false);
    expect(existsSync(nodeEmbeddingSidecarPath(baseDir, sha))).toBe(false);
  });

  it("writes a sidecar and reuses the text-hash cache on a second build", async () => {
    const graph = snap([
      node({ id: "src/a.ts:foo:function", label: "foo", signature: "function foo()" }),
      node({ id: "src/a.ts:bar:function", label: "bar" }),
    ]);
    const calls: string[] = [];
    const embed = async (text: string) => {
      calls.push(text);
      return [1, 0, 0];
    };
    const first = await writeNodeEmbeddings(graph, baseDir, sha, { enabled: true, embed });
    expect(first.written).toBe(true);
    expect(first.embedded).toBe(2);
    expect(first.cached).toBe(0);
    expect(calls).toHaveLength(2);

    const second = await writeNodeEmbeddings(graph, baseDir, "b".repeat(64), { enabled: true, embed });
    expect(second.written).toBe(true);
    expect(second.embedded).toBe(0);
    expect(second.cached).toBe(2);
    expect(calls).toHaveLength(2);

    const vectors = readNodeEmbeddings(baseDir, sha);
    expect(vectors?.["src/a.ts:foo:function"]).toEqual([1, 0, 0]);
  });

  it("leaves no sidecar when every embed fails", async () => {
    const result = await writeNodeEmbeddings(
      snap([node({ id: "src/a.ts:foo:function", label: "foo" })]),
      baseDir,
      sha,
      { enabled: true, embed: async () => null },
    );
    expect(result.written).toBe(false);
    expect(existsSync(nodeEmbeddingSidecarPath(baseDir, sha))).toBe(false);
  });

  it("returns null for a missing or corrupt sidecar", () => {
    expect(readNodeEmbeddings(baseDir, sha)).toBeNull();
    mkdirSync(join(baseDir, ".cache", "node-embeddings"), { recursive: true });
    writeFileSync(nodeEmbeddingSidecarPath(baseDir, sha), "{not json");
    expect(readNodeEmbeddings(baseDir, sha)).toBeNull();
    writeFileSync(nodeEmbeddingSidecarPath(baseDir, sha), JSON.stringify({
      schema: 99,
      snapshot_sha256: sha,
      vectors: { "src/a.ts:foo:function": [1] },
    }));
    expect(readNodeEmbeddings(baseDir, sha)).toBeNull();
    writeFileSync(nodeEmbeddingSidecarPath(baseDir, sha), JSON.stringify({
      schema: 1,
      snapshot_sha256: "b".repeat(64),
      vectors: { "src/a.ts:foo:function": [1] },
    }));
    expect(readNodeEmbeddings(baseDir, sha)).toBeNull();
    writeFileSync(nodeEmbeddingSidecarPath(baseDir, sha), JSON.stringify({
      schema: 1,
      snapshot_sha256: sha,
      vectors: { "src/a.ts:foo:function": "nope" },
    }));
    expect(readNodeEmbeddings(baseDir, sha)).toBeNull();
  });

  it("skips a node whose embedder throws and still writes the rest", async () => {
    const graph = snap([
      node({ id: "src/a.ts:foo:function", label: "foo" }),
      node({ id: "src/a.ts:bar:function", label: "bar" }),
    ]);
    const result = await writeNodeEmbeddings(graph, baseDir, sha, {
      enabled: true,
      embed: async (text) => {
        if (text.includes("foo")) throw new Error("boom");
        return [0, 1];
      },
    });
    expect(result.written).toBe(true);
    const vectors = readNodeEmbeddings(baseDir, sha);
    expect(vectors?.["src/a.ts:foo:function"]).toBeUndefined();
    expect(vectors?.["src/a.ts:bar:function"]).toEqual([0, 1]);
  });

  it("ignores a corrupt text-hash cache entry and re-embeds", async () => {
    const n = node({ id: "src/a.ts:foo:function", label: "foo" });
    const hash = fileContentHash(nodeEmbedText(n));
    writeCachedNodeVector(baseDir, hash, [9, 9]);
    mkdirSync(join(baseDir, ".cache", "node-embed-vectors"), { recursive: true });
    writeFileSync(join(baseDir, ".cache", "node-embed-vectors", `${hash}.json`), "nope");
    expect(readCachedNodeVector(baseDir, hash)).toBeNull();
    const result = await writeNodeEmbeddings(snap([n]), baseDir, sha, {
      enabled: true,
      embed: async () => [1, 2],
    });
    expect(result.embedded).toBe(1);
    expect(readCachedNodeVector(baseDir, hash)).toEqual([1, 2]);
  });

  it("omits the sidecar when embeddings are disabled by default", async () => {
    _setEnabledReaderForTesting(() => false);
    try {
      const result = await writeNodeEmbeddings(
        snap([node({ id: "src/a.ts:foo:function", label: "foo" })]),
        baseDir,
        sha,
      );
      expect(result.written).toBe(false);
    } finally {
      _resetForTesting();
    }
  });

  it("returns written:false when the sidecar path cannot be created", async () => {
    mkdirSync(join(baseDir, ".cache"), { recursive: true });
    writeFileSync(join(baseDir, ".cache", "node-embeddings"), "not-a-dir");
    const result = await writeNodeEmbeddings(
      snap([node({ id: "src/a.ts:foo:function", label: "foo" })]),
      baseDir,
      sha,
      { enabled: true, embed: async () => [1, 0] },
    );
    expect(result.written).toBe(false);
  });

  it("ignores cache entries with a mismatched schema", () => {
    const hash = "c".repeat(64);
    mkdirSync(join(baseDir, ".cache", "node-embed-vectors"), { recursive: true });
    writeFileSync(join(baseDir, ".cache", "node-embed-vectors", `${hash}.json`), JSON.stringify({
      schema: 99,
      content_sha256: hash,
      vector: [1],
    }));
    expect(readCachedNodeVector(baseDir, hash)).toBeNull();
  });

  it("embeds uncached nodes in batches and reuses identical text in-build", async () => {
    const nodes = [
      ...Array.from({ length: 33 }, (_, i) => node({ id: `src/a.ts:f${i}:function`, label: `f${i}` })),
      node({ id: "src/a.ts:copy:function", label: "f0" }),
    ];
    const batches: string[][] = [];
    const result = await writeNodeEmbeddings(snap(nodes), baseDir, sha, {
      enabled: true,
      embedBatch: async (texts) => {
        batches.push([...texts]);
        return texts.map(() => [1, 0]);
      },
    });
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(32);
    expect(batches[1]).toHaveLength(1);
    expect(result.written).toBe(true);
    expect(result.embedded).toBe(33);
    expect(result.cached).toBe(1);
    const vectors = readNodeEmbeddings(baseDir, sha);
    expect(vectors?.["src/a.ts:f0:function"]).toEqual([1, 0]);
    expect(vectors?.["src/a.ts:copy:function"]).toEqual([1, 0]);
  });

  it("skips remaining default embeds after the first miss", async () => {
    _setEnabledReaderForTesting(() => false);
    try {
      const result = await writeNodeEmbeddings(
        snap([
          node({ id: "src/a.ts:foo:function", label: "foo" }),
          node({ id: "src/a.ts:bar:function", label: "bar" }),
        ]),
        baseDir,
        sha,
        { enabled: true },
      );
      expect(result.embedded).toBe(0);
      expect(result.written).toBe(false);
    } finally {
      _resetForTesting();
    }
  });
});
