import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { isDirectRun } from "../../src/utils/direct-run.js";

const repoRoot = process.cwd();
const mcpServer = join(repoRoot, "harnesses", "antigravity", "bundle", "mcp-server.js");
const codexPre = join(repoRoot, "harnesses", "codex", "bundle", "pre-tool-use.js");

describe("isDirectRun entry-name guard", () => {
  it("does not treat the Vitest worker as an MCP or Codex hook entry", () => {
    expect(isDirectRun(import.meta.url, "mcp-server")).toBe(false);
    expect(isDirectRun(import.meta.url, "pre-tool-use")).toBe(false);
  });
});

describe("shipped mcp-server.js — Codex PreToolUse main must not steal stdin", () => {
  it("mcp-server.js exists after build", () => {
    expect(existsSync(mcpServer), `missing: ${mcpServer}`).toBe(true);
  });

  it("guards MCP and Codex CLI mains with distinct entry names", () => {
    const mcp = readFileSync(mcpServer, "utf-8");
    const pre = readFileSync(codexPre, "utf-8");
    expect(mcp).toMatch(/isDirectRun\([^,]+,\s*"mcp-server"\)/);
    expect(mcp).toMatch(/isDirectRun\([^,]+,\s*"capture"\)/);
    expect(pre).toMatch(/isDirectRun\([^,]+,\s*"pre-tool-use"\)/);
  });

  it("persists unaided agy -p sessions from MCP tool calls", () => {
    const mcp = readFileSync(mcpServer, "utf-8");
    expect(mcp).toContain("captureMcpToolCall");
    expect(mcp).toContain("mcp-");
  });

  it("answers initialize over Content-Length stdio", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const framed = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const result = spawnSync(process.execPath, [mcpServer], {
      encoding: "utf8",
      input: framed,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"name":"memoree"');
    expect(result.stdout).toContain("protocolVersion");
  });

  it("answers initialize over NDJSON stdio the way Antigravity speaks MCP", () => {
    const framed = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "agy", version: "0" } },
    })}\n`;
    const result = spawnSync(process.execPath, [mcpServer], {
      encoding: "utf8",
      input: framed,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"name":"memoree"');
    expect(result.stdout).toContain("2025-03-26");
    expect(result.stdout.trim().startsWith("{")).toBe(true);
    expect(result.stdout).not.toMatch(/Content-Length/i);
  });

  it("does not pause stdin after the first JSON-RPC frame (agy sends tools/list later)", async () => {
    const child = spawn(process.execPath, [mcpServer], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    const waitFor = (re: RegExp, ms: number) => new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (re.test(stdout)) return resolve();
        if (Date.now() - start > ms) return reject(new Error(`timeout waiting for ${re} in ${stdout.slice(0, 400)}`));
        setTimeout(tick, 25);
      };
      tick();
    });
    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "agy", version: "0" } },
      })}\n`);
      await waitFor(/"name":"memoree"/, 3_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
      await waitFor(/memoree_read/, 3_000);
      expect(stdout).toContain("memoree_ls");
    } finally {
      child.kill("SIGTERM");
    }
  }, 10_000);
});
