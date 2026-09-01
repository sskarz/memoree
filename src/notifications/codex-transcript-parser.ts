/**
 * Codex transcript parser — extracts memory-search byte counts from a
 * Codex `~/.codex/sessions/.../*.jsonl` rollout at SessionEnd.
 *
 * Claude's `parseTranscript` walks `entry.message` tool_use / tool_result
 * blocks. Codex records are `session_meta`, `response_item`, and
 * `event_msg` with nested `payload`, so that parser always returns zeros
 * and never writes `~/.memoree/usage-stats.jsonl`.
 *
 * This parser returns the same `UsageRecord` Claude's SessionEnd hook
 * appends. Memory lookups are any tool command whose text contains
 * `.memoree/memory` (same `isMemoryLookupCommand` substring). Codex
 * records the same shell call twice (`function_call` plus
 * `exec_command_*` with one `call_id`); we count each id once.
 */

import { existsSync, readFileSync } from "node:fs";
import type { UsageRecord } from "./usage-tracker.js";
import { isMemoryLookupCommand, toolResultByteLength } from "./transcript-parser.js";
import { log as _log } from "../utils/debug.js";

const log = (msg: string) => _log("codex-transcript-parser", msg);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function commandFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((part): part is string => typeof part === "string").join(" ");
  }
  return "";
}

function parseArguments(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asRecord(value);
}

function commandFromPayload(payload: Record<string, unknown>): string {
  const fromCommand = commandFromUnknown(payload.command);
  if (fromCommand) return fromCommand;
  const fromCmd = commandFromUnknown(payload.cmd);
  if (fromCmd) return fromCmd;
  const parsed = parseArguments(payload.arguments);
  if (parsed) {
    return commandFromUnknown(parsed.command) || commandFromUnknown(parsed.cmd);
  }
  return typeof payload.arguments === "string" ? payload.arguments : "";
}

function payloadOf(item: Record<string, unknown>): Record<string, unknown> {
  return asRecord(item.payload) ?? item;
}

function callIdOf(payload: Record<string, unknown>, item: Record<string, unknown>): string {
  return asString(payload.call_id) || asString(payload.callId) || asString(item.call_id);
}

function payloadType(item: Record<string, unknown>, payload: Record<string, unknown>): string {
  return asString(payload.type) || asString(item.type);
}

function isToolStart(type: string): boolean {
  return type === "function_call" || type === "exec_command_begin" || type === "custom_tool_call";
}

function isToolEnd(type: string): boolean {
  return type === "function_call_output"
    || type === "exec_command_end"
    || type === "custom_tool_call_output";
}

function outputBytesFromPayload(payload: Record<string, unknown>): number {
  const stringCandidates = [
    payload.aggregated_output,
    payload.formatted_output,
    payload.stdout,
  ];
  for (const candidate of stringCandidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return toolResultByteLength(candidate);
    }
  }
  const output = payload.output;
  if (typeof output === "string" && output.length > 0) {
    return toolResultByteLength(output);
  }
  const nested = asRecord(output);
  if (nested) {
    if (typeof nested.output === "string") return toolResultByteLength(nested.output);
    if (typeof nested.stdout === "string") return toolResultByteLength(nested.stdout);
    if (typeof nested.text === "string") return toolResultByteLength(nested.text);
  }
  if (payload.content !== undefined) return toolResultByteLength(payload.content);
  return toolResultByteLength(output ?? "");
}

/**
 * Parse a Codex rollout JSONL into a usage recap record. Never throws.
 * Missing or unreadable files return zeros and `fallbackSessionId`.
 */
export function parseCodexTranscript(
  transcriptPath: string,
  fallbackSessionId: string,
  now: Date = new Date(),
): UsageRecord {
  const empty: UsageRecord = {
    endedAt: now.toISOString(),
    sessionId: fallbackSessionId,
    memorySearchBytes: 0,
    memorySearchCount: 0,
  };

  if (!transcriptPath || !existsSync(transcriptPath)) {
    log(`transcript missing: ${transcriptPath}`);
    return empty;
  }

  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log(`read failed: ${message}`);
    return empty;
  }

  const memoryLookupCallIds = new Set<string>();
  const memorySearchBytesByCall = new Map<string, number>();
  let unlabeledMemorySearchCount = 0;
  let unlabeledMemorySearchBytes = 0;
  let sessionId = fallbackSessionId;
  let endedAt = "";

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let item: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const record = asRecord(parsed);
      if (!record) continue;
      item = record;
    } catch {
      continue;
    }

    const payload = payloadOf(item);
    const timestamp = asString(item.timestamp) || asString(payload.timestamp);
    if (timestamp) endedAt = timestamp;

    const type = payloadType(item, payload);
    if (item.type === "session_meta" || type === "session_meta") {
      const fromPayload = asString(payload.session_id) || asString(item.session_id);
      if (fromPayload) sessionId = fromPayload;
      continue;
    }

    const callId = callIdOf(payload, item);

    if (isToolStart(type)) {
      const command = commandFromPayload(payload);
      if (!isMemoryLookupCommand(command)) continue;
      if (callId) {
        memoryLookupCallIds.add(callId);
      } else {
        unlabeledMemorySearchCount += 1;
      }
      continue;
    }

    if (!isToolEnd(type)) continue;
    const bytes = outputBytesFromPayload(payload);
    if (callId && memoryLookupCallIds.has(callId)) {
      const previous = memorySearchBytesByCall.get(callId) ?? 0;
      memorySearchBytesByCall.set(callId, Math.max(previous, bytes));
    } else if (!callId && unlabeledMemorySearchCount > 0) {
      unlabeledMemorySearchBytes += bytes;
    }
  }

  return {
    endedAt: endedAt || now.toISOString(),
    sessionId,
    memorySearchBytes: [...memorySearchBytesByCall.values()].reduce((sum, n) => sum + n, 0)
      + unlabeledMemorySearchBytes,
    memorySearchCount: memoryLookupCallIds.size + unlabeledMemorySearchCount,
  };
}
