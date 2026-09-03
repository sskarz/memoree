import { describe, expect, it, afterEach } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../../src/config.js";
import { spawnWikiWorkerCore } from "../../src/hooks/shared/wiki-spawn.js";
import { WIKI_PROMPT_TEMPLATE, WIKI_PROMPT_TEMPLATE_COMPACT, WIKI_NEXT_STEPS_BODY } from "../../src/hooks/shared/wiki-prompt.js";

const config = {
  kind: "sqlite",
  userName: "ada",
  workspaceId: "ws",
  orgId: "org",
  orgName: "Org",
  tableName: "memory",
  sessionsTableName: "sessions",
  skillsTableName: "skills",
  rulesTableName: "rules",
  goalsTableName: "goals",
  kpisTableName: "kpis",
  docsTableName: "docs",
  codebaseTableName: "codebase",
  memoryPath: "/tmp/memory",
  vectorScanLimit: 50,
  storage: { kind: "sqlite", path: "/tmp/x.sqlite3" },
} as unknown as Config;

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
});

describe("spawnWikiWorkerCore", () => {
  it("writes a worker config and invokes the spawn seam", () => {
    const spawned: Array<{ worker: string; args: readonly string[] }> = [];
    const logs: string[] = [];
    const configFile = spawnWikiWorkerCore({
      config,
      sessionId: "sess-1",
      cwd: process.cwd(),
      bundleDir: "/bundle",
      reason: "SessionEnd",
      hooksDir: "/tmp/hooks",
      pluginMarker: ".claude-plugin",
      promptTemplate: WIKI_PROMPT_TEMPLATE,
      wikiLog: "/tmp/hooks/memoree-wiki.log",
      extraConfig: { claudeBin: "/usr/bin/claude", agent: "claude_code" },
      log: (msg) => logs.push(msg),
      spawnFn: (worker, args = []) => {
        spawned.push({ worker, args });
      },
    });
    temps.push(dirname(configFile));

    const written = JSON.parse(readFileSync(configFile, "utf-8")) as Record<string, unknown>;
    expect(written.sessionId).toBe("sess-1");
    expect(written.memoryTable).toBe("memory");
    expect(written.sessionsTable).toBe("sessions");
    expect(written.claudeBin).toBe("/usr/bin/claude");
    expect(written.agent).toBe("claude_code");
    expect(written.promptTemplate).toBe(WIKI_PROMPT_TEMPLATE);
    expect(spawned).toEqual([{ worker: "/bundle/wiki-worker.js", args: [configFile] }]);
    expect(logs[0]).toMatch(/SessionEnd: spawning summary worker for sess-1/);
    expect(logs[1]).toMatch(/spawned summary worker for sess-1/);
  });
});

describe("wiki prompt templates", () => {
  it("shares one Next Steps body across the full and compact prompts", () => {
    expect(WIKI_PROMPT_TEMPLATE).toContain(WIKI_NEXT_STEPS_BODY);
    expect(WIKI_PROMPT_TEMPLATE_COMPACT).toContain(WIKI_NEXT_STEPS_BODY);
  });
});
