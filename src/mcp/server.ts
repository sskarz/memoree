#!/usr/bin/env node
/**
 * Minimal stdio MCP server exposing Memoree VFS tools.
 * Framed with MCP Content-Length headers. Tools wrap the existing sandbox.
 */

import { MEMOREE_MCP_TOOLS, runMemoreeTool } from "./vfs-tools.js";
import { isDirectRun } from "../utils/direct-run.js";
import { log as _log } from "../utils/debug.js";

const log = (msg: string) => _log("mcp", msg);

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export async function handleMcpRequest(msg: JsonRpcRequest): Promise<Record<string, unknown> | null> {
  const id = msg.id ?? null;
  const method = msg.method ?? "";
  if (method === "notifications/initialized" || method.startsWith("notifications/")) return null;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "memoree", version: "0.0.0" },
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: MEMOREE_MCP_TOOLS } };
  }
  if (method === "tools/call") {
    const params = msg.params ?? {};
    const name = String(params.name ?? "");
    const args = (params.arguments && typeof params.arguments === "object")
      ? params.arguments as Record<string, unknown>
      : {};
    try {
      const result = await runMemoreeTool(name, args);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: result.text }],
          isError: !result.ok,
        },
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text }], isError: true },
      };
    }
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

function writeMessage(msg: Record<string, unknown>): void {
  const json = JSON.stringify(msg);
  const buf = Buffer.from(json, "utf8");
  process.stdout.write(`Content-Length: ${buf.length}\r\n\r\n`);
  process.stdout.write(buf);
}

async function readMessages(): Promise<void> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, chunk as Buffer]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) break;
      const body = buffer.subarray(start, start + length).toString("utf8");
      buffer = buffer.subarray(start + length);
      let parsed: JsonRpcRequest;
      try { parsed = JSON.parse(body) as JsonRpcRequest; }
      catch (error) {
        log(`bad json: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const reply = await handleMcpRequest(parsed);
      if (reply) writeMessage(reply);
    }
  }
}

/* c8 ignore start */
if (isDirectRun(import.meta.url, "mcp-server") || isDirectRun(import.meta.url, "server")) {
  readMessages().catch((error) => {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(0);
  });
}
/* c8 ignore stop */
