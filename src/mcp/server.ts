#!/usr/bin/env node
/**
 * Minimal stdio MCP server exposing Memoree VFS tools.
 *
 * Official MCP stdio is newline-delimited JSON (NDJSON). Antigravity speaks
 * that. Content-Length framing is still accepted so older clients and our
 * existing tests keep working. Replies use the same framing as the request.
 */

import { MEMOREE_MCP_TOOLS, runMemoreeTool } from "./vfs-tools.js";
import { isDirectRun } from "../utils/direct-run.js";
import { log as _log } from "../utils/debug.js";

const log = (msg: string) => _log("mcp", msg);

export const DEFAULT_MCP_PROTOCOL_VERSION = "2024-11-05";

export type McpFraming = "ndjson" | "content-length";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpStdioMessage {
  msg: JsonRpcRequest;
  framing: McpFraming;
}

function protocolVersionOf(params: Record<string, unknown> | undefined): string {
  const requested = params && typeof params.protocolVersion === "string"
    ? params.protocolVersion.trim()
    : "";
  return requested.length > 0 ? requested : DEFAULT_MCP_PROTOCOL_VERSION;
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
        protocolVersion: protocolVersionOf(msg.params),
        capabilities: { tools: {} },
        serverInfo: { name: "memoree", version: "0.0.0" },
      },
    };
  }
  if (method === "ping" || method === "logging/setLevel") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: MEMOREE_MCP_TOOLS } };
  }
  if (method === "prompts/list") {
    return { jsonrpc: "2.0", id, result: { prompts: [] } };
  }
  if (method === "resources/list") {
    return { jsonrpc: "2.0", id, result: { resources: [] } };
  }
  if (method === "resources/templates/list") {
    return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
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

export function encodeMcpMessage(msg: Record<string, unknown>, framing: McpFraming): string {
  const json = JSON.stringify(msg);
  if (framing === "ndjson") return `${json}\n`;
  const length = Buffer.byteLength(json, "utf8");
  return `Content-Length: ${length}\r\n\r\n${json}`;
}

function skipLeadingSpace(buffer: Buffer): Buffer {
  let i = 0;
  while (i < buffer.length) {
    const b = buffer[i];
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) break;
    i += 1;
  }
  return i === 0 ? buffer : buffer.subarray(i);
}

function parseJsonRpc(text: string): JsonRpcRequest | null {
  try {
    return JSON.parse(text) as JsonRpcRequest;
  } catch {
    return null;
  }
}

/**
 * Pull complete MCP stdio frames off the front of `buffer`. Incomplete
 * frames stay in `rest` so the caller can append the next stdin chunk.
 */
export function consumeMcpBuffer(buffer: Buffer): { rest: Buffer; messages: McpStdioMessage[] } {
  const messages: McpStdioMessage[] = [];
  let rest = buffer;
  while (rest.length > 0) {
    rest = skipLeadingSpace(rest);
    if (rest.length === 0) break;
    const head = rest.toString("utf8", 0, Math.min(rest.length, 16));
    if (/^Content-Length:/i.test(head)) {
      const crlf = rest.indexOf("\r\n\r\n");
      const lf = rest.indexOf("\n\n");
      let headerEnd = -1;
      let sepLen = 0;
      if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
        headerEnd = crlf;
        sepLen = 4;
      } else if (lf >= 0) {
        headerEnd = lf;
        sepLen = 2;
      } else {
        break;
      }
      const header = rest.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        rest = rest.subarray(headerEnd + sepLen);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + sepLen;
      if (rest.length < start + length) break;
      const body = rest.subarray(start, start + length).toString("utf8");
      rest = rest.subarray(start + length);
      const msg = parseJsonRpc(body);
      if (msg) messages.push({ msg, framing: "content-length" });
      continue;
    }
    const nl = rest.indexOf(0x0a);
    if (nl < 0) break;
    let line = rest.subarray(0, nl).toString("utf8");
    rest = rest.subarray(nl + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    const msg = parseJsonRpc(line);
    if (msg) messages.push({ msg, framing: "ndjson" });
  }
  return { rest, messages };
}

function chunkToBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

async function readMessages(): Promise<void> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buffer = Buffer.from(Buffer.concat([buffer, chunkToBuffer(chunk)]));
    const consumed = consumeMcpBuffer(buffer);
    buffer = Buffer.from(consumed.rest);
    for (const item of consumed.messages) {
      const reply = await handleMcpRequest(item.msg);
      if (reply) process.stdout.write(encodeMcpMessage(reply, item.framing));
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
