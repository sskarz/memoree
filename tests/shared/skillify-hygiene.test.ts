import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { parseHygieneActions } from "../../src/skillify/hygiene-parser.js";
import {
  applyHygieneActions,
  HYGIENE_QUIET_MS,
  isMemoreeManaged,
  parseHygieneCliArgs,
  readHygieneLastRun,
  runHygieneCycle,
  writeHygieneLastRun,
  hygieneLockKey,
  hygieneStampPath,
} from "../../src/skillify/hygiene.js";
import {
  maybeSpawnHygieneWorker,
  bundleDirFromImportMeta,
} from "../../src/skillify/spawn-hygiene-worker.js";
import { writeNewSkill } from "../../src/skillify/skill-writer.js";
import { recordPull, loadManifest } from "../../src/skillify/manifest.js";
import {
  tryAcquireWorkerLock,
  releaseWorkerLock,
} from "../../src/skillify/state.js";
import type { TaggedSkill } from "../../src/skillify/existing-skills.js";
import { deriveProjectKey } from "../../src/utils/repo-identity.js";

const BODY = "## When to use\n\nFor X.\n\n## Workflow\n\nStep 1.";

function managedMd(name: string, body = BODY): string {
  return `---
name: ${name}
description: "${name} skill"
source_sessions:
  - sess-1
created_by_agent: claude_code
version: 1
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
---

${body}
`;
}

describe("parseHygieneActions", () => {
  const names = new Set(["foo", "bar", "baz"]);

  it("parses unchanged, merge, shrink, and archive", () => {
    const parsed = parseHygieneActions(JSON.stringify({
      actions: [
        { op: "unchanged", name: "foo" },
        { op: "merge", from: ["foo", "bar"], into: "foo", body: "merged", description: "d", trigger: "t" },
        { op: "shrink", name: "baz", body: "short" },
        { op: "archive", name: "bar", reason: "dup" },
      ],
    }), names);
    expect(parsed).toHaveLength(4);
    expect(parsed?.[0]).toEqual({ op: "unchanged", name: "foo" });
    expect(parsed?.[1]?.op).toBe("merge");
    expect(parsed?.[2]).toEqual({ op: "shrink", name: "baz", body: "short" });
    expect(parsed?.[3]).toEqual({ op: "archive", name: "bar", reason: "dup" });
  });

  it("rejects unknown ops and unmanaged names", () => {
    expect(parseHygieneActions(`{"actions":[{"op":"delete","name":"foo"}]}`, names)).toBeNull();
    expect(parseHygieneActions(`{"actions":[{"op":"archive","name":"nope"}]}`, names)).toBeNull();
    expect(parseHygieneActions(`{"actions":[{"op":"merge","from":["foo","new"],"into":"foo","body":"x"}]}`, names)).toBeNull();
    expect(parseHygieneActions(`{"verdict":"KEEP"}`, names)).toBeNull();
    expect(parseHygieneActions("not json", names)).toBeNull();
  });

  it("rejects merge into a name that is not in from", () => {
    expect(parseHygieneActions(JSON.stringify({
      actions: [{ op: "merge", from: ["foo", "bar"], into: "baz", body: "x" }],
    }), names)).toBeNull();
  });

  it("rejects malformed action items", () => {
    expect(parseHygieneActions(`{"actions":[null]}`, names)).toBeNull();
    expect(parseHygieneActions(`{"actions":[{"op":"shrink","name":"foo"}]}`, names)).toBeNull();
    expect(parseHygieneActions(`{"actions":[{"op":"merge","from":["foo"],"into":"foo","body":"x"}]}`, names)).toBeNull();
    expect(parseHygieneActions(`{"actions":[{"op":"unchanged","name":""}]}`, names)).toBeNull();
    expect(parseHygieneActions("", names)).toBeNull();
  });
});

describe("isMemoreeManaged", () => {
  it("treats source_sessions-only frontmatter as managed", () => {
    expect(isMemoreeManaged(`---
name: foo
source_sessions:
  - abc
---
body
`)).toBe(true);
  });
});

describe("parseHygieneCliArgs", () => {
  it("reads --dry-run and --force", () => {
    expect(parseHygieneCliArgs([])).toEqual({ dryRun: false, force: false });
    expect(parseHygieneCliArgs(["--dry-run", "--force"])).toEqual({ dryRun: true, force: true });
  });
});

describe("runHygieneCycle + apply", () => {
  let cwd: string;
  let skillsRoot: string;
  let projectKey: string;
  let prevWorker: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "hygiene-cwd-"));
    skillsRoot = join(cwd, ".claude", "skills");
    mkdirSync(skillsRoot, { recursive: true });
    projectKey = `hygiene-${randomUUID()}`;
    prevWorker = process.env.MEMOREE_SKILLIFY_WORKER;
    delete process.env.MEMOREE_SKILLIFY_WORKER;
  });

  afterEach(() => {
    try { releaseWorkerLock(hygieneLockKey(projectKey)); } catch { /* ignore */ }
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevWorker === undefined) delete process.env.MEMOREE_SKILLIFY_WORKER;
    else process.env.MEMOREE_SKILLIFY_WORKER = prevWorker;
  });

  function writeManaged(name: string, body = BODY): TaggedSkill {
    writeNewSkill({
      skillsRoot,
      name,
      description: `${name} skill`,
      body,
      sourceSessions: ["sess-1"],
      agent: "claude_code",
    });
    return {
      name,
      body: readFileSync(join(skillsRoot, name, "SKILL.md"), "utf-8"),
      source: "project",
    };
  }

  function writeUser(name: string): void {
    const dir = join(skillsRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# Hand written\n\nDo the thing.\n");
  }

  it("dry-run does not rewrite or delete", async () => {
    const foo = writeManaged("foo");
    const bar = writeManaged("bar");
    writeUser("hand");
    const result = await runHygieneCycle({
      cwd,
      projectKey,
      agent: "claude_code",
      dryRun: true,
      force: true,
      listSkillsFn: () => [foo, bar],
      runGateFn: () => ({
        stdout: JSON.stringify({
          actions: [
            { op: "archive", name: "bar", reason: "dup" },
            { op: "shrink", name: "foo", body: "tiny" },
          ],
        }),
        stderr: "",
        errored: false,
      }),
    });
    expect(result.kind).toBe("dry-run");
    expect(result.advancedLastRun).toBe(false);
    expect(existsSync(join(skillsRoot, "bar", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(skillsRoot, "foo", "SKILL.md"), "utf-8")).toContain("For X.");
    expect(readHygieneLastRun(projectKey)).toBeNull();
  });

  it("archive removes a Memoree-managed skill and leaves a user skill", async () => {
    const foo = writeManaged("foo");
    writeUser("hand");
    const result = await runHygieneCycle({
      cwd,
      projectKey,
      agent: "claude_code",
      force: true,
      listSkillsFn: () => [foo],
      runGateFn: () => ({
        stdout: JSON.stringify({ actions: [{ op: "archive", name: "foo", reason: "unused" }] }),
        stderr: "",
        errored: false,
      }),
    });
    expect(result.kind).toBe("applied");
    expect(existsSync(join(skillsRoot, "foo", "SKILL.md"))).toBe(false);
    expect(existsSync(join(skillsRoot, "hand", "SKILL.md"))).toBe(true);
    expect(result.advancedLastRun).toBe(true);
  });

  it("merge rewrites the target and removes the extra managed dir", async () => {
    const a = writeManaged("alpha");
    const b = writeManaged("beta");
    const result = await runHygieneCycle({
      cwd,
      projectKey,
      agent: "claude_code",
      force: true,
      listSkillsFn: () => [a, b],
      runGateFn: () => ({
        stdout: JSON.stringify({
          actions: [{
            op: "merge",
            from: ["alpha", "beta"],
            into: "alpha",
            body: "combined body",
            description: "combined",
          }],
        }),
        stderr: "",
        errored: false,
      }),
    });
    expect(result.kind).toBe("applied");
    expect(existsSync(join(skillsRoot, "beta", "SKILL.md"))).toBe(false);
    const text = readFileSync(join(skillsRoot, "alpha", "SKILL.md"), "utf-8");
    expect(text).toContain("combined body");
    expect(text).toMatch(/version: 2/);
  });

  it("24h gate skips; --force does not", async () => {
    const t0 = 1_000_000;
    writeHygieneLastRun(projectKey, t0);
    const skipped = await runHygieneCycle({
      cwd,
      projectKey,
      agent: "claude_code",
      now: () => t0 + HYGIENE_QUIET_MS - 1,
      runGateFn: () => ({ stdout: "", stderr: "", errored: true, errorMessage: "should not run" }),
    });
    expect(skipped.kind).toBe("skipped");
    expect(skipped.reason).toBe("quiet");

    const foo = writeManaged("foo");
    const forced = await runHygieneCycle({
      cwd,
      projectKey,
      agent: "claude_code",
      force: true,
      now: () => t0 + HYGIENE_QUIET_MS - 1,
      listSkillsFn: () => [foo],
      runGateFn: () => ({
        stdout: JSON.stringify({ actions: [{ op: "unchanged", name: "foo" }] }),
        stderr: "",
        errored: false,
      }),
    });
    expect(forced.kind).toBe("applied");
  });

  it("skips when MEMOREE_SKILLIFY_WORKER=1 unless lock is already held", async () => {
    process.env.MEMOREE_SKILLIFY_WORKER = "1";
    const skipped = await runHygieneCycle({
      cwd,
      projectKey,
      agent: "claude_code",
      force: false,
      runGateFn: () => ({ stdout: "", stderr: "", errored: true, errorMessage: "no" }),
    });
    expect(skipped.reason).toBe("recursion");
  });

  it("skips when the hygiene lock is held", async () => {
    expect(tryAcquireWorkerLock(hygieneLockKey(projectKey))).toBe(true);
    const result = await runHygieneCycle({
      cwd,
      projectKey,
      agent: "claude_code",
      force: true,
      runGateFn: () => ({ stdout: "", stderr: "", errored: true, errorMessage: "no" }),
    });
    expect(result.kind).toBe("skipped");
    expect(result.reason).toBe("lock");
  });

  it("does not apply or advance last-run on a failed LLM plan", async () => {
    const foo = writeManaged("foo");
    const result = await runHygieneCycle({
      cwd,
      projectKey,
      agent: "claude_code",
      force: true,
      listSkillsFn: () => [foo],
      runGateFn: () => ({ stdout: "I refuse", stderr: "", errored: false }),
    });
    expect(result.kind).toBe("failed-llm");
    expect(result.advancedLastRun).toBe(false);
    expect(existsSync(join(skillsRoot, "foo", "SKILL.md"))).toBe(true);
    expect(readHygieneLastRun(projectKey)).toBeNull();
  });

  it("does not apply when the gate errors with empty stdout", async () => {
    const foo = writeManaged("foo");
    const result = await runHygieneCycle({
      cwd,
      projectKey,
      agent: "claude_code",
      force: true,
      listSkillsFn: () => [foo],
      runGateFn: () => ({ stdout: "", stderr: "boom", errored: true, errorMessage: "cli failed" }),
    });
    expect(result.kind).toBe("failed-llm");
    expect(result.advancedLastRun).toBe(false);
  });

  it("advances last-run when every op is unchanged", async () => {
    const foo = writeManaged("foo");
    const result = await runHygieneCycle({
      cwd,
      projectKey,
      agent: "claude_code",
      force: true,
      listSkillsFn: () => [foo],
      runGateFn: () => ({
        stdout: JSON.stringify({ actions: [{ op: "unchanged", name: "foo" }] }),
        stderr: "",
        errored: false,
      }),
    });
    expect(result.kind).toBe("applied");
    expect(result.advancedLastRun).toBe(true);
    expect(readHygieneLastRun(projectKey)).toBeTypeOf("number");
  });

  it("chunks an oversized shelf into multiple gate calls", async () => {
    const pad = "x".repeat(20_000);
    const big1: TaggedSkill = { name: "big1", body: managedMd("big1", pad), source: "project" };
    const big2: TaggedSkill = { name: "big2", body: managedMd("big2", pad), source: "project" };
    const seen: string[] = [];
    const result = await runHygieneCycle({
      cwd,
      projectKey,
      agent: "claude_code",
      force: true,
      listSkillsFn: () => [big1, big2],
      runGateFn: ({ prompt }) => {
        const name = prompt.includes("big1") && !prompt.includes("big2") ? "big1"
          : prompt.includes("big2") && !prompt.includes("big1") ? "big2"
          : "both";
        seen.push(name);
        return {
          stdout: JSON.stringify({ actions: [{ op: "unchanged", name }] }),
          stderr: "",
          errored: false,
        };
      },
    });
    expect(result.kind).toBe("applied");
    expect(seen).toEqual(["big1", "big2"]);
  });

  it("succeeds with no managed skills and still stamps last-run", async () => {
    writeUser("hand");
    const result = await runHygieneCycle({
      cwd,
      projectKey,
      agent: "claude_code",
      force: true,
      listSkillsFn: () => [{
        name: "hand",
        body: "# Hand written\n",
        source: "project",
      }],
    });
    expect(result.reason).toBe("no-managed");
    expect(result.advancedLastRun).toBe(true);
    expect(existsSync(join(skillsRoot, "hand", "SKILL.md"))).toBe(true);
  });

  it("shrink rewrites the body and bumps version", async () => {
    const foo = writeManaged("foo", BODY + "\n\n" + "padding\n".repeat(20));
    const result = await runHygieneCycle({
      cwd,
      projectKey,
      agent: "claude_code",
      force: true,
      listSkillsFn: () => [foo],
      runGateFn: () => ({
        stdout: JSON.stringify({ actions: [{ op: "shrink", name: "foo", body: "tight" }] }),
        stderr: "",
        errored: false,
      }),
    });
    expect(result.kind).toBe("applied");
    const text = readFileSync(join(skillsRoot, "foo", "SKILL.md"), "utf-8");
    expect(text).toContain("tight");
    expect(text).not.toContain("padding");
    expect(text).toMatch(/version: 2/);
  });

  it("applyHygieneActions dry-run leaves files in place", () => {
    const foo = writeManaged("foo");
    applyHygieneActions(
      [{ op: "archive", name: "foo", reason: "x" }],
      [foo],
      cwd,
      true,
    );
    expect(existsSync(join(skillsRoot, "foo", "SKILL.md"))).toBe(true);
  });

  it("returns null for a corrupt last-run stamp", () => {
    writeHygieneLastRun(projectKey, 1);
    writeFileSync(hygieneStampPath(projectKey), "{not json");
    expect(readHygieneLastRun(projectKey)).toBeNull();
    writeFileSync(hygieneStampPath(projectKey), JSON.stringify({ lastRunAt: "soon" }));
    expect(readHygieneLastRun(projectKey)).toBeNull();
  });

  it("does not re-acquire the lock when lockHeld is set", async () => {
    expect(tryAcquireWorkerLock(hygieneLockKey(projectKey))).toBe(true);
    const result = await runHygieneCycle({
      cwd,
      projectKey,
      agent: "claude_code",
      force: true,
      lockHeld: true,
      listSkillsFn: () => [],
    });
    expect(result.reason).toBe("no-managed");
    // lock still held by us — cycle must not have released it
    expect(tryAcquireWorkerLock(hygieneLockKey(projectKey))).toBe(false);
  });

  it("drops a pulled manifest entry when archiving", async () => {
    const foo = writeManaged("foo");
    recordPull({
      dirName: "foo",
      name: "foo",
      author: "me",
      projectKey,
      remoteVersion: 1,
      install: "project",
      installRoot: skillsRoot,
      pulledAt: new Date().toISOString(),
      symlinks: [],
    });
    await runHygieneCycle({
      cwd,
      projectKey,
      agent: "claude_code",
      force: true,
      listSkillsFn: () => [foo],
      runGateFn: () => ({
        stdout: JSON.stringify({ actions: [{ op: "archive", name: "foo", reason: "dup" }] }),
        stderr: "",
        errored: false,
      }),
    });
    expect(loadManifest().entries.filter((e) => e.dirName === "foo")).toEqual([]);
  });

  it("merge dry-run does not delete extras", () => {
    const a = writeManaged("alpha");
    const b = writeManaged("beta");
    applyHygieneActions(
      [{ op: "merge", from: ["alpha", "beta"], into: "alpha", body: "x" }],
      [a, b],
      cwd,
      true,
    );
    expect(existsSync(join(skillsRoot, "beta", "SKILL.md"))).toBe(true);
  });
});

describe("maybeSpawnHygieneWorker", () => {
  let cwd: string;
  let projectKey: string;
  let prevWorker: string | undefined;
  const spawnCalls: string[][] = [];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "hygiene-spawn-"));
    prevWorker = process.env.MEMOREE_SKILLIFY_WORKER;
    delete process.env.MEMOREE_SKILLIFY_WORKER;
    spawnCalls.length = 0;
    projectKey = deriveProjectKey(cwd).key;
  });

  afterEach(() => {
    try { releaseWorkerLock(hygieneLockKey(projectKey)); } catch { /* ignore */ }
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevWorker === undefined) delete process.env.MEMOREE_SKILLIFY_WORKER;
    else process.env.MEMOREE_SKILLIFY_WORKER = prevWorker;
  });

  const spawnFn = (workerPath: string, args: readonly string[] = []) => {
    spawnCalls.push([workerPath, ...args]);
  };

  it("skips when MEMOREE_SKILLIFY_WORKER=1", () => {
    process.env.MEMOREE_SKILLIFY_WORKER = "1";
    const r = maybeSpawnHygieneWorker({ cwd, bundleDir: "/bundle", agent: "claude_code", spawnFn });
    expect(r).toEqual({ triggered: false, reason: "recursion" });
    expect(spawnCalls).toHaveLength(0);
  });

  it("skips during the 24h quiet period", () => {
    const t0 = 5_000_000;
    writeHygieneLastRun(projectKey, t0);
    const r = maybeSpawnHygieneWorker({
      cwd,
      bundleDir: "/bundle",
      agent: "claude_code",
      now: () => t0 + 1000,
      spawnFn,
    });
    expect(r).toEqual({ triggered: false, reason: "quiet" });
  });

  it("skips when the lock is held", () => {
    expect(tryAcquireWorkerLock(hygieneLockKey(projectKey))).toBe(true);
    const r = maybeSpawnHygieneWorker({ cwd, bundleDir: "/bundle", agent: "claude_code", spawnFn });
    expect(r).toEqual({ triggered: false, reason: "lock" });
    expect(spawnCalls).toHaveLength(0);
  });

  it("spawns the hygiene worker", () => {
    const r = maybeSpawnHygieneWorker({ cwd, bundleDir: "/bundle", agent: "claude_code", spawnFn });
    expect(r).toEqual({ triggered: true });
    expect(spawnCalls[0]?.[0]).toBe("/bundle/hygiene-worker.js");
  });

  it("releases the lock when spawn throws", () => {
    const r = maybeSpawnHygieneWorker({
      cwd,
      bundleDir: "/bundle",
      agent: "claude_code",
      spawnFn: () => { throw new Error("nope"); },
    });
    expect(r).toEqual({ triggered: false, reason: "spawn-failed" });
    expect(tryAcquireWorkerLock(hygieneLockKey(projectKey))).toBe(true);
  });

  it("bundleDirFromImportMeta returns the file directory", () => {
    expect(bundleDirFromImportMeta("file:///tmp/foo/bar.js")).toBe("/tmp/foo");
  });

  it("skips an empty cwd", () => {
    const r = maybeSpawnHygieneWorker({ cwd: "", bundleDir: "/bundle", agent: "claude_code", spawnFn });
    expect(r).toEqual({ triggered: false, reason: "spawn-failed" });
  });
});
