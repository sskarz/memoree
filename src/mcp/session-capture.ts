/**
 * Persist Antigravity MCP tool calls as session events.
 *
 * `agy -p` loads hooks.json but does not execute command hooks (the leftover
 * unaided runs had 0 session rows and no wake lock). MCP still runs, so this
 * is the unaided capture path. Interactive IDE sessions still get hook
 * capture when the platform invokes them.
 *
 * The capture hook main must use isDirectRun(..., "capture"). Without the
 * entry name, esbuild inlines that main into mcp-server.js and it pauses
 * stdin after the first JSON-RPC frame, so `agy` never lists MCP tools.
 */

import { captureAntigravityEvent } from "../hooks/antigravity/capture.js";
import { log as _log } from "../utils/debug.js";
import type { MemoreeToolResult } from "./vfs-tools.js";

const log = (msg: string) => _log("mcp-capture", msg);

export function mcpSessionId(env: NodeJS.ProcessEnv = process.env): string {
  const fromAgy = env.ANTIGRAVITY_CONVERSATION_ID?.trim();
  if (fromAgy) return fromAgy;
  return `mcp-${process.pid}`;
}

export async function captureMcpToolCall(
  name: string,
  args: Record<string, unknown>,
  result: MemoreeToolResult,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.MEMOREE_CAPTURE === "false") return;
  try {
    await captureAntigravityEvent(
      {
        conversationId: mcpSessionId(env),
        workspacePaths: [process.cwd()],
      },
      "PostToolUse",
      {
        type: "tool_call",
        tool_name: name,
        tool_input: args,
        tool_response: { ok: result.ok, text: result.text.slice(0, 2000) },
      },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log(`capture skipped: ${message}`);
  }
}
