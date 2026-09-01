#!/usr/bin/env node
/**
 * Antigravity PreToolUse — steer off the virtual mount. Memory reads/writes
 * go through MCP tools; this hook never smuggles file contents through deny.
 */

import { readStdin } from "../../utils/stdin.js";
import { isDirectRun } from "../../utils/direct-run.js";
import { log as _log } from "../../utils/debug.js";
import { touchesMemory } from "../memory-path-utils.js";
import {
  MEMORY_STEER,
  normalizeAntigravityInput,
  toolPayloadTouchesMemory,
  type AntigravityHookInput,
} from "./payload.js";

const log = (msg: string) => _log("agy-pre", msg);

export function decidePreToolUse(input: unknown): Record<string, unknown> {
  const normalized = normalizeAntigravityInput(input);
  if (!toolPayloadTouchesMemory(normalized, touchesMemory)) return {};
  log(`steer off mount tool=${normalized.toolCall?.name ?? "?"}`);
  return { decision: "deny", reason: MEMORY_STEER };
}

/* c8 ignore start */
async function main(): Promise<void> {
  const input = await readStdin<AntigravityHookInput>();
  process.stdout.write(JSON.stringify(decidePreToolUse(input)) + "\n");
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write("{}\n");
  });
}
/* c8 ignore stop */
