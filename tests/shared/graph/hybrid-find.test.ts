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
    expect(patternIsSemanticFriendly("login")).toBe(true);
    expect(patternIsSemanticFriendly("auth+middleware")).toBe(true);
    expect(patternIsSemanticFriendly("a")).toBe(false);
    expect(patternIsSemanticFriendly("foo(bar)|baz")).toBe(false);
  });
});

describe("findMatches", () => {
  const login = node("src/a.ts:login:function", "login");
  const loginHelper = node("src/a.ts:loginHelper:function", "loginHelper");
  const myLogin = node("src/a.ts:myLogin:function", "myLogin");
  const fileHit = node("src/login.ts:foo:function", "foo");
  const helper = node("src/a.ts:helper:function", "helper");
  const graph = snap([login, loginHelper, myLogin, fileHit, helper]);

  it("ranks exact, prefix, contains, then id hits", () => {
    const hits = findMatches(graph, "login");
    expect(hits[0]?.label).toBe("login");
    expect(hits.map((n) => n.label)).toContain("loginHelper");
    expect(hits.map((n) => n.label)).toContain("myLogin");
    expect(hits.map((n) => n.id)).toContain("src/login.ts:foo:function");
  });

  it("AND-matches multi-token patterns and tie-breaks by id", () => {
    const a = node("src/a.ts:authMiddleware:function", "authMiddleware");
    const b = node("src/b.ts:authMiddleware:function", "authMiddleware");
    const hits = findMatches(snap([a, b, helper]), "auth+middleware");
    expect(hits.map((n) => n.id)).toEqual([
      "src/a.ts:authMiddleware:function",
      "src/b.ts:authMiddleware:function",
    ]);
  });

  it("falls back to fuzzy when there is no substring hit", () => {
    const hits = findMatches(graph, "loginn");
    expect(hits[0]?.label).toBe("login");
  });

  it("returns no hits for an empty token list", () => {
    expect(findMatches(graph, "+++")).toEqual([]);
  });
});

describe("hybridFindNodes", () => {
  const login = node("src/a.ts:login:function", "login");
  const authenticate = node("src/a.ts:authenticate:function", "authenticate");
  const helper = node("src/a.ts:helper:function", "helper");
  const graph = snap([login, authenticate, helper]);

  it("returns lexical-only when no sidecar or embedding is present", () => {
    expect(hybridFindNodes(graph, "login")).toEqual(findMatches(graph, "login"));
    expect(hybridFindNodes(graph, "login", { queryEmbedding: [1, 0], sidecar: null })).toEqual(
      findMatches(graph, "login"),
    );
  });

  it("places a lexical login hit above a semantic authenticate fill", () => {
    const merged = hybridFindNodes(graph, "login", {
      queryEmbedding: [1, 0],
      sidecar: {
        "src/a.ts:authenticate:function": [0.98, 0.1],
        "src/a.ts:helper:function": [0, 1],
      },
    });
    expect(merged[0]?.id).toBe("src/a.ts:login:function");
    expect(merged.map((n) => n.id)).toContain("src/a.ts:authenticate:function");
    expect(merged.map((n) => n.id).indexOf("src/a.ts:login:function")).toBeLessThan(
      merged.map((n) => n.id).indexOf("src/a.ts:authenticate:function"),
    );
  });

  it("dedupes a node that is both a lexical and semantic hit", () => {
    const merged = mergeHybridMatches([login, helper], [login, authenticate]);
    expect(merged.map((n) => n.id)).toEqual([
      "src/a.ts:login:function",
      "src/a.ts:helper:function",
      "src/a.ts:authenticate:function",
    ]);
  });

  it("drops semantic hits below the cosine floor", () => {
    const semantic = semanticMatchesFromSidecar(graph, [1, 0], {
      "src/a.ts:authenticate:function": [0.1, 0.99],
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
