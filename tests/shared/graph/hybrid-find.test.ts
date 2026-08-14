import { describe, it, expect } from "vitest";

import {
  findMatches,
  hybridFindNodes,
  mergeHybridMatches,
  patternIsSemanticFriendly,
  semanticMatchesFromSidecar,
  embedQueryWithTimeout,
} from "../../../src/graph/hybrid-find.js";
import type { GraphSnapshot, GraphNode } from "../../../src/graph/types.js";

function node(id: string, label: string): GraphNode {
  return {
    id,
    label,
    kind: "function",
    source_file: "src/x.ts",
    source_location: "L1",
    language: "typescript",
    exported: true,
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

describe("patternIsSemanticFriendly", () => {
  it("accepts plain tokens and query AND separators", () => {
    expect(patternIsSemanticFriendly("writeSnapshot")).toBe(true);
    expect(patternIsSemanticFriendly("write+snapshot")).toBe(true);
    expect(patternIsSemanticFriendly("a")).toBe(false);
    expect(patternIsSemanticFriendly("foo(bar)|baz")).toBe(false);
  });
});

describe("findMatches", () => {
  const hash = node("src/a.ts:hash:function", "hash");
  const hashHelper = node("src/a.ts:hashHelper:function", "hashHelper");
  const myHash = node("src/a.ts:myHash:function", "myHash");
  const fileHit = node("src/hash.ts:foo:function", "foo");
  const helper = node("src/a.ts:helper:function", "helper");
  const graph = snap([hash, hashHelper, myHash, fileHit, helper]);

  it("ranks exact, prefix, contains, then id hits", () => {
    const hits = findMatches(graph, "hash");
    expect(hits[0]?.label).toBe("hash");
    expect(hits.map((n) => n.label)).toContain("hashHelper");
    expect(hits.map((n) => n.label)).toContain("myHash");
    expect(hits.map((n) => n.id)).toContain("src/hash.ts:foo:function");
  });

  it("AND-matches multi-token patterns and tie-breaks by id", () => {
    const a = node("src/a.ts:writeSnapshot:function", "writeSnapshot");
    const b = node("src/b.ts:writeSnapshot:function", "writeSnapshot");
    const hits = findMatches(snap([a, b, helper]), "write+snapshot");
    expect(hits.map((n) => n.id)).toEqual([
      "src/a.ts:writeSnapshot:function",
      "src/b.ts:writeSnapshot:function",
    ]);
  });

  it("falls back to fuzzy when there is no substring hit", () => {
    const hits = findMatches(graph, "hxsh");
    expect(hits[0]?.label).toBe("hash");
  });

  it("returns no hits for an empty token list", () => {
    expect(findMatches(graph, "+++")).toEqual([]);
  });
});

describe("hybridFindNodes", () => {
  const writeSnapshot = node("src/a.ts:writeSnapshot:function", "writeSnapshot");
  const persistGraph = node("src/a.ts:persistGraph:function", "persistGraph");
  const helper = node("src/a.ts:helper:function", "helper");
  const graph = snap([writeSnapshot, persistGraph, helper]);

  it("returns lexical-only when no sidecar or embedding is present", () => {
    expect(hybridFindNodes(graph, "writeSnapshot")).toEqual(findMatches(graph, "writeSnapshot"));
    expect(hybridFindNodes(graph, "writeSnapshot", { queryEmbedding: [1, 0], sidecar: null })).toEqual(
      findMatches(graph, "writeSnapshot"),
    );
  });

  it("places a lexical name hit above a semantic fill", () => {
    const merged = hybridFindNodes(graph, "writeSnapshot", {
      queryEmbedding: [1, 0],
      sidecar: {
        "src/a.ts:persistGraph:function": [0.98, 0.1],
        "src/a.ts:helper:function": [0, 1],
      },
    });
    expect(merged[0]?.id).toBe("src/a.ts:writeSnapshot:function");
    expect(merged.map((n) => n.id)).toContain("src/a.ts:persistGraph:function");
    expect(merged.map((n) => n.id).indexOf("src/a.ts:writeSnapshot:function")).toBeLessThan(
      merged.map((n) => n.id).indexOf("src/a.ts:persistGraph:function"),
    );
  });

  it("skips semantic fills when the query vector dim does not match the sidecar", () => {
    const merged = hybridFindNodes(graph, "writeSnapshot", {
      queryEmbedding: [1, 0, 0],
      sidecar: { "src/a.ts:persistGraph:function": [0.98, 0.1] },
    });
    expect(merged).toEqual(findMatches(graph, "writeSnapshot"));
  });

  it("dedupes a node that is both a lexical and semantic hit", () => {
    const merged = mergeHybridMatches([writeSnapshot, helper], [writeSnapshot, persistGraph]);
    expect(merged.map((n) => n.id)).toEqual([
      "src/a.ts:writeSnapshot:function",
      "src/a.ts:helper:function",
      "src/a.ts:persistGraph:function",
    ]);
  });

  it("drops semantic hits below the cosine floor", () => {
    const semantic = semanticMatchesFromSidecar(graph, [1, 0], {
      "src/a.ts:persistGraph:function": [0.1, 0.99],
    });
    expect(semantic).toEqual([]);
  });
});

describe("embedQueryWithTimeout", () => {
  it("returns null when the embedder throws or times out", async () => {
    expect(await embedQueryWithTimeout("x", async () => { throw new Error("nope"); })).toBeNull();
    expect(await embedQueryWithTimeout("x", async () => {
      await new Promise((r) => setTimeout(r, 50));
      return [1];
    }, 1)).toBeNull();
  });

  it("returns a non-empty vector", async () => {
    expect(await embedQueryWithTimeout("x", async () => [0.1, 0.2])).toEqual([0.1, 0.2]);
    expect(await embedQueryWithTimeout("x", async () => [])).toBeNull();
  });
});
