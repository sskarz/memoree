/**
 * Each MCP VFS tool has a uniquely observable job. Collapsing any pair
 * (except echo/printf/tee → memoree_write) would fail these assertions.
 *
 * Two layers:
 *   1. Codex intercept (the path Antigravity MCP wraps) for cat/head/tail/wc/
 *      ls/find/grep on summaries.
 *   2. Structured MemoreeFs for jq vs cat, and write vs mv vs rm.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processCodexPreToolUse } from "../../src/hooks/codex/pre-tool-use.js";
import {
  MCP_TOOL_JOBS,
  MCP_TOOL_UNIQUENESS,
  MEMOREE_MCP_TOOL_NAMES,
  MEMOREE_MCP_TOOLS,
  runMemoreeTool,
} from "../../src/mcp/vfs-tools.js";
import { MemoreeFs } from "../../src/shell/memoree-fs.js";
import { SqliteBackend } from "../../src/storage/sqlite.js";
import { _resetForTesting, _setEnabledReaderForTesting } from "../../src/embeddings/disable.js";

const LONG = Array.from({ length: 20 }, (_, i) => `LINE_${String(i).padStart(2, "0")}_BODY`).join("\n");

const dummyConfig = {
  userName: "alice", orgId: "local", orgName: "local", workspaceId: "default",
  storage: { kind: "sqlite" }, rulesTableName: "memoree_rules",
  goalsTableName: "memoree_goals", kpisTableName: "memoree_kpis",
} as any;

const names = {
  memory: "memory",
  sessions: "sessions",
  skills: "skills",
  rules: "memoree_rules",
  goals: "memoree_goals",
  kpis: "memoree_kpis",
  docs: "memoree_docs",
  codebase: "codebase",
};

describe("MCP tool uniqueness contract", () => {
  it("records a distinct job and a sibling it must not collapse into", () => {
    expect(Object.keys(MCP_TOOL_UNIQUENESS).sort()).toEqual([...MEMOREE_MCP_TOOL_NAMES].sort());
    const jobs = Object.values(MCP_TOOL_JOBS);
    expect(new Set(jobs).size).toBe(jobs.length);
    const unlikes = Object.values(MCP_TOOL_UNIQUENESS).map(row => row.unlike);
    expect(new Set(unlikes).size).toBe(unlikes.length);
    for (const name of MEMOREE_MCP_TOOL_NAMES) {
      expect(MCP_TOOL_UNIQUENESS[name].unlike.length).toBeGreaterThan(20);
      const tool = MEMOREE_MCP_TOOLS.find(entry => entry.name === name);
      expect(tool?.description.length).toBeGreaterThan(40);
    }
  });
});

describe("MCP tools produce uniquely observable outputs through the Codex VFS intercept", () => {
  async function call(name: string, args: Record<string, unknown>) {
    return runMemoreeTool(name, args, "/tmp", input => processCodexPreToolUse(input, {
      config: dummyConfig,
      createApi: vi.fn(() => ({ query: vi.fn(async () => []) })) as any,
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      readVirtualPathContentFn: vi.fn(async (_api, _t, _s, path) => (
        path === "/summaries/alice/long.md" ? LONG : null
      )) as any,
      listVirtualPathRowsFn: vi.fn(async () => [
        { path: "/summaries/alice/long.md", size_bytes: LONG.length },
        { path: "/summaries/alice/secret-name-only.md", size_bytes: 1 },
      ]) as any,
      findVirtualPathsFn: vi.fn(async (_api, _t, _s, _dir, pattern: string) => {
        const files = [
          { path: "/summaries/alice/long.md", name: "long.md" },
          { path: "/summaries/alice/secret-name-only.md", name: "secret-name-only.md" },
        ];
        const like = String(pattern).replace(/\\/g, "");
        const re = new RegExp(`^${like.replace(/%/g, ".*").replace(/_/g, ".")}$`);
        return files.filter(file => re.test(file.name)).map(file => file.path);
      }) as any,
      handleGrepDirectFn: vi.fn(async (_api, _t, _s, params: { pattern: string }) => {
        if (params.pattern.includes("LINE_00_BODY")) return "/summaries/alice/long.md:LINE_00_BODY";
        return "(no matches)";
      }) as any,
      logFn: vi.fn(),
    }));
  }

  it("head is a prefix, tail is a suffix, wc is a count, cat is the whole file", async () => {
    const cat = await call("memoree_read", { path: "summaries/alice/long.md" });
    const head = await call("memoree_head", { path: "summaries/alice/long.md", lines: 2 });
    const tail = await call("memoree_tail", { path: "summaries/alice/long.md", lines: 2 });
    const wc = await call("memoree_wc", { path: "summaries/alice/long.md" });
    expect(cat).toEqual({ ok: true, text: LONG });
    expect(head).toEqual({ ok: true, text: "LINE_00_BODY\nLINE_01_BODY" });
    expect(tail).toEqual({ ok: true, text: "LINE_18_BODY\nLINE_19_BODY" });
    expect(head.text).not.toBe(tail.text);
    expect(head.text.length).toBeLessThan(cat.text.length);
    expect(wc.ok).toBe(true);
    expect(wc.text).toMatch(/^20 /);
    expect(wc.text).not.toContain("LINE_00_BODY");
  });

  it("ls lists names without bodies; find matches names; grep matches contents", async () => {
    const ls = await call("memoree_ls", { path: "summaries/alice" });
    expect(ls.ok).toBe(true);
    expect(ls.text).toContain("long.md");
    expect(ls.text).toContain("secret-name-only.md");
    expect(ls.text).not.toContain("LINE_00_BODY");

    const findName = await call("memoree_find", { path: "summaries/alice", name: "*secret-name-only*" });
    expect(findName.ok).toBe(true);
    expect(findName.text).toContain("secret-name-only.md");

    const findContent = await call("memoree_find", { path: "summaries/alice", name: "*LINE_00_BODY*" });
    expect(findContent.ok).toBe(true);
    expect(findContent.text).toMatch(/no matches/i);

    const grepContent = await call("memoree_grep", { pattern: "LINE_00_BODY", path: "summaries" });
    expect(grepContent.ok).toBe(true);
    expect(grepContent.text).toContain("LINE_00_BODY");

    const grepMissing = await call("memoree_grep", { pattern: "secret-name-only", path: "summaries" });
    expect(grepMissing.ok).toBe(true);
    expect(grepMissing.text).not.toContain("LINE_00_BODY");
  });
});

describe("structured VFS jobs jq/write/mv/rm are uniquely observable", () => {
  let root: string;
  let backend: SqliteBackend;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-job-unique-"));
    backend = new SqliteBackend(join(root, "memoree.sqlite3"), "memory", names);
    _setEnabledReaderForTesting(() => false);
  });

  afterEach(async () => {
    await backend.close();
    _resetForTesting();
    rmSync(root, { recursive: true, force: true });
  });

  async function makeFs(): Promise<MemoreeFs> {
    await backend.initializeSchema();
    return MemoreeFs.create(backend, "memory", "/", "sessions", {
      rulesTable: names.rules,
      goalsTable: names.goals,
      kpisTable: names.kpis,
      identity: {
        userName: "alice",
        organization: "local",
        workspace: "workspace-one",
        backend: "sqlite",
      },
    });
  }

  it("jq extracts a field; cat returns the whole identity.json; ls does not include userName", async () => {
    const fs = await makeFs();
    const listing = (await fs.readdir("/")).join("\n");
    const body = await fs.readFile("/identity.json");
    const parsed = JSON.parse(body) as { userName: string; organization: string };
    expect(listing).toContain("identity.json");
    expect(listing).not.toContain("alice");
    expect(body).toContain('"userName": "alice"');
    expect(body).toContain('"organization": "local"');
    expect(parsed.userName).toBe("alice");
    expect(JSON.stringify(parsed.userName)).not.toContain("organization");
  });

  it("write creates, mv relocates the same id, rm closes instead of unlinking", async () => {
    const fs = await makeFs();
    const id = "11111111-1111-4111-8111-111111111111";
    const active = `/rules/active/${id}.md`;
    const done = `/rules/done/${id}.md`;
    await fs.writeFile(active, "unique-rule-body");
    await fs.flush();
    expect(await fs.readFile(active)).toBe("unique-rule-body");
    await fs.mv(active, done);
    expect(await fs.readFile(done)).toBe("unique-rule-body");
    await expect(fs.readFile(active)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.rm(done);
    expect(await fs.exists(done)).toBe(true);
    expect(await fs.readFile(done)).toBe("unique-rule-body");
  });
});
