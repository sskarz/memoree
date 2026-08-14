/**
 * Parse catalog-hygiene gate output. Separate from KEEP/SKIP/MERGE so the
 * session miner and the shelf curator cannot be confused.
 */

import { extractJsonBlock } from "./gate-parser.js";

export type HygieneOp =
  | { op: "unchanged"; name: string }
  | { op: "merge"; from: string[]; into: string; body: string; description?: string; trigger?: string }
  | { op: "shrink"; name: string; body: string }
  | { op: "archive"; name: string; reason?: string };

const OPS = new Set(["unchanged", "merge", "shrink", "archive"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parse a hygiene plan. Returns null when the payload is missing, malformed,
 * contains an unknown op / unmanaged name, or does not mention every listed
 * name in exactly one action — the worker then applies nothing and does not
 * advance last-run.
 */
export function parseHygieneActions(raw: string, managedNames: ReadonlySet<string>): HygieneOp[] | null {
  const block = extractJsonBlock(raw);
  if (!block) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const actions = (parsed as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return null;

  const out: HygieneOp[] = [];
  const claimed = new Set<string>();
  for (const item of actions) {
    const op = parseOne(item, managedNames);
    if (op === null) return null;
    const names = claimedNames(op);
    for (const name of names) {
      if (claimed.has(name)) return null;
      claimed.add(name);
    }
    out.push(op);
  }
  if (claimed.size !== managedNames.size) return null;
  return out;
}

function claimedNames(op: HygieneOp): string[] {
  if (op.op === "merge") return op.from;
  return [op.name];
}

function parseOne(item: unknown, managedNames: ReadonlySet<string>): HygieneOp | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
  const rec = item as Record<string, unknown>;
  const op = rec.op;
  if (typeof op !== "string" || !OPS.has(op)) return null;

  if (op === "unchanged") {
    if (!isNonEmptyString(rec.name) || !managedNames.has(rec.name)) return null;
    return { op: "unchanged", name: rec.name };
  }
  if (op === "shrink") {
    if (!isNonEmptyString(rec.name) || !managedNames.has(rec.name)) return null;
    if (!isNonEmptyString(rec.body)) return null;
    return { op: "shrink", name: rec.name, body: rec.body };
  }
  if (op === "archive") {
    if (!isNonEmptyString(rec.name) || !managedNames.has(rec.name)) return null;
    return {
      op: "archive",
      name: rec.name,
      reason: typeof rec.reason === "string" ? rec.reason : undefined,
    };
  }
  // merge
  if (!Array.isArray(rec.from) || rec.from.length < 2) return null;
  const from = rec.from.filter(isNonEmptyString);
  if (from.length !== rec.from.length) return null;
  if (!isNonEmptyString(rec.into) || !isNonEmptyString(rec.body)) return null;
  if (!managedNames.has(rec.into)) return null;
  if (!from.includes(rec.into)) return null;
  for (const name of from) {
    if (!managedNames.has(name)) return null;
  }
  return {
    op: "merge",
    from,
    into: rec.into,
    body: rec.body,
    description: typeof rec.description === "string" ? rec.description : undefined,
    trigger: typeof rec.trigger === "string" ? rec.trigger : undefined,
  };
}
