import { vi } from "vitest";
import type { GraphNode, GraphSnapshot } from "../../../src/graph/types.js";

/** Minimal graph node for docs/wiki unit tests. */
export function docsGraphNode(
  id: string,
  source_file: string,
  source_location = "L1",
  kind: GraphNode["kind"] = "function",
): GraphNode {
  return {
    id,
    label: id,
    kind,
    source_file,
    source_location,
    language: "typescript",
    exported: true,
  };
}

export function docsGraphSnap(
  nodes: GraphNode[],
  links: GraphSnapshot["links"] = [],
): GraphSnapshot {
  return { nodes, links } as unknown as GraphSnapshot;
}

/** Query mock that records SQL and returns the same rows on every call. */
export function docsMockQuery(rowsPerCall: Array<Record<string, unknown>> = []) {
  const calls: string[] = [];
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    return rowsPerCall;
  });
  return { calls, query };
}
