#!/usr/bin/env node
/**
 * Antigravity PreToolUse — steer off the virtual mount. Memory reads/writes
 * go through MCP tools; this hook never smuggles file contents through deny.
 *
 * `decision` is required by agy. Returning `{}` is invalid_args and denies the
 * call. Returning `"allow"` auto-approves (skip user grants), so unrelated
 * tools use `"ask"` and Memoree MCP tools are never steered off themselves.
 */

import { readStdin } from "../../utils/stdin.js";
import { isDirectRun } from "../../utils/direct-run.js";
import { log as _log } from "../../utils/debug.js";
import { touchesMemory } from "../memory-path-utils.js";
import {
  MEMORY_STEER,
  PRE_TOOL_PASS,
  isMemoreeMcpToolCall,
  normalizeAntigravityInput,
  toolPayloadTouchesMemory,
  type AntigravityHookInput,
} from "./payload.js";

const log = (msg: string) => _log("agy-pre", msg);

export function decidePreToolUse(input: unknown): Record<string, unknown> {
  const normalized = normalizeAntigravityInput(input);
  const name = normalized.toolCall?.name;
  const args = normalized.toolCall?.args;
  if (isMemoreeMcpToolCall(name, args)) return { ...PRE_TOOL_PASS };
  if (!toolPayloadTouchesMemory(normalized, touchesMemory)) return { ...PRE_TOOL_PASS };
  log(`steer off mount tool=${name ?? "?"}`);
  return { decision: "deny", reason: MEMORY_STEER };
}

/* c8 ignore start */
async function main(): Promise<void> {
  const input = await readStdin<AntigravityHookInput>();
  process.stdout.write(JSON.stringify(decidePreToolUse(input)) + "\n");
}

if (isDirectRun(import.meta.url, "pre-tool-use")) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(JSON.stringify(PRE_TOOL_PASS) + "\n");
  });
}
/* c8 ignore stop */
