import { describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "../../src/mcp/server.js";
import {
  buildMemoryCommand,
  normalizeMemoryPath,
  runMemoreeTool,
  MEMOREE_MCP_TOOLS,
} from "../../src/mcp/vfs-tools.js";

describe("Memoree MCP VFS tools", () => {
  it("normalizes relative, absolute, and already-virtual paths", () => {
    expect(normalizeMemoryPath("")).toBe("~/.memoree/memory");
    expect(normalizeMemoryPath(".")).toBe("~/.memoree/memory");
    expect(normalizeMemoryPath("identity.json")).toBe("~/.memoree/memory/identity.json");
    expect(normalizeMemoryPath("~/.memoree/memory/rules.md")).toBe("~/.memoree/memory/rules.md");
    expect(normalizeMemoryPath("$HOME/.memoree/memory/x")).toBe("$HOME/.memoree/memory/x");
    expect(normalizeMemoryPath("graph/query/store")).toBe("~/.memoree/memory/graph/query/store");
    expect(normalizeMemoryPath("memory/summaries")).toBe("~/.memoree/memory/summaries");
    expect(normalizeMemoryPath("memory")).toBe("~/.memoree/memory");
    expect(normalizeMemoryPath(".memoree/memory/rules.md")).toBe("~/.memoree/memory/rules.md");
    expect(normalizeMemoryPath(".memoree/memory")).toBe("~/.memoree/memory");
  });

  it("builds sandboxed commands for every MCP tool", () => {
    expect(buildMemoryCommand("memoree_ls", { path: "summaries" })).toBe("ls ~/.memoree/memory/summaries");
    expect(buildMemoryCommand("memoree_read", { path: "identity.json" })).toBe("cat ~/.memoree/memory/identity.json");
    expect(buildMemoryCommand("memoree_grep", { pattern: "foo", path: "summaries" }))
      .toBe("grep -ri 'foo' ~/.memoree/memory/summaries");
    expect(buildMemoryCommand("memoree_write", { path: "rules/active/a.md", content: "x" }))
      .toContain("printf '%s' 'x' > ~/.memoree/memory/rules/active/a.md");
    expect(buildMemoryCommand("memoree_mv", { from: "rules/active/a.md", to: "rules/done/a.md" }))
      .toBe("mv ~/.memoree/memory/rules/active/a.md ~/.memoree/memory/rules/done/a.md");
    expect(buildMemoryCommand("memoree_rm", { path: "rules/active/a.md" }))
      .toBe("rm ~/.memoree/memory/rules/active/a.md");
  });

  it("lists tools over JSON-RPC", async () => {
    const reply = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(reply?.result).toEqual({ tools: MEMOREE_MCP_TOOLS });
  });

  it("calls a tool through the VFS process seam", async () => {
    const processFn = vi.fn(async () => ({ action: "allow" as const, output: "ok-identity" }));
    const result = await runMemoreeTool("memoree_read", { path: "identity.json" }, "/tmp", processFn);
    expect(result).toEqual({ ok: true, text: "ok-identity" });
    expect(processFn).toHaveBeenCalledWith(expect.objectContaining({
      tool_input: { command: "cat ~/.memoree/memory/identity.json" },
    }));
  });

  it("returns an error for unknown tools and blocked VFS paths", async () => {
    await expect(runMemoreeTool("nope", {})).rejects.toThrow(/unknown Memoree MCP tool/);
    const blocked = await runMemoreeTool("memoree_read", { path: "identity.json" }, "/tmp", async () => ({
      action: "block",
      output: "denied",
    }));
    expect(blocked).toEqual({ ok: false, text: "denied" });
    const passed = await runMemoreeTool("memoree_read", { path: "identity.json" }, "/tmp", async () => ({
      action: "pass",
      output: "",
    }));
    expect(passed).toEqual({ ok: false, text: "not a Memoree memory path" });
  });

  it("escapes single quotes in grep and write payloads", () => {
    expect(buildMemoryCommand("memoree_grep", { pattern: "it's", path: "" }))
      .toBe("grep -ri 'it'\\''s' ~/.memoree/memory");
  });

  it("calls tools over JSON-RPC including errors", async () => {
    const ok = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "memoree_ls", arguments: { path: "" } },
    });
    expect(ok?.result).toMatchObject({ isError: expect.any(Boolean) });
    const unknown = await handleMcpRequest({
      id: 10,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    expect(unknown?.result).toMatchObject({ isError: true });
  });

  it("handles initialize, ping, and unknown methods", async () => {
    expect((await handleMcpRequest({ id: 2, method: "initialize" }))?.result).toMatchObject({
      serverInfo: { name: "memoree" },
    });
    expect(await handleMcpRequest({ id: 3, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    expect((await handleMcpRequest({ id: 4, method: "nope" }))?.error).toMatchObject({ code: -32601 });
    expect(await handleMcpRequest({ method: "notifications/initialized" })).toBeNull();
  });
});
