/**
 * Skill catalog hygiene: look at the skill shelf (not the last 10 chats)
 * and merge, shrink, or archive Memoree-managed skills.
 *
 * Session miner KEEP/SKIP/MERGE is unchanged. This curator may delete
 * Memoree-managed skills; it never touches a hand-written SKILL.md with
 * no Memoree frontmatter.
 */

import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, renameSync, cpSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { listAllExistingSkills, type TaggedSkill } from "./existing-skills.js";
import { parseFrontmatter, mergeSkill, resolveSkillsRoot, assertValidSkillName } from "./skill-writer.js";
import { runGate, type Agent, type GateRunResult } from "./gate-runner.js";
import { parseHygieneActions, type HygieneOp } from "./hygiene-parser.js";
import { tryAcquireWorkerLock, releaseWorkerLock } from "./state.js";
import { getStateDir } from "./state-dir.js";
import { loadManifest, removePullEntry, unlinkSymlinks } from "./manifest.js";

export const HYGIENE_QUIET_MS = 24 * 60 * 60 * 1000;
export const HYGIENE_SKILLS_CHAR_CAP = 30_000;

export type HygieneSkipReason = "recursion" | "quiet" | "lock" | "no-managed";

export interface HygieneCycleResult {
  kind: "applied" | "dry-run" | "failed-llm" | "failed-apply" | "skipped";
  reason?: HygieneSkipReason;
  actions: HygieneOp[];
  lines: string[];
  advancedLastRun: boolean;
}

export function parseHygieneCliArgs(args: string[]): { dryRun: boolean; force: boolean } {
  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
  };
}

export interface HygieneCycleDeps {
  cwd: string;
  projectKey: string;
  agent: Agent;
  dryRun?: boolean;
  force?: boolean;
  now?: () => number;
  runGateFn?: (opts: { agent: Agent; prompt: string }) => GateRunResult;
  /** When true, caller already holds the worker lock (detached spawn). */
  lockHeld?: boolean;
  listSkillsFn?: (cwd: string) => TaggedSkill[];
  applyDeps?: ApplyHygieneDeps;
}

export function hygieneLockKey(projectKey: string): string {
  return `${projectKey}::hygiene`;
}

export function hygieneStampPath(projectKey: string): string {
  return join(getStateDir(), `${projectKey}.hygiene.json`);
}

export function readHygieneLastRun(projectKey: string): number | null {
  const path = hygieneStampPath(projectKey);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { lastRunAt?: unknown };
    return typeof parsed.lastRunAt === "number" && Number.isFinite(parsed.lastRunAt)
      ? parsed.lastRunAt
      : null;
  } catch {
    return null;
  }
}

export function writeHygieneLastRun(projectKey: string, lastRunAt: number): void {
  mkdirSync(getStateDir(), { recursive: true });
  const path = hygieneStampPath(projectKey);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ lastRunAt }));
  try {
    renameSync(tmp, path);
  } catch {
    writeFileSync(path, JSON.stringify({ lastRunAt }));
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

export function isMemoreeManaged(body: string): boolean {
  const parsed = parseFrontmatter(body);
  if (!parsed) return false;
  const agent = parsed.fm.created_by_agent;
  if (typeof agent === "string" && agent.trim().length > 0) return true;
  const sources = parsed.fm.source_sessions;
  return Array.isArray(sources) && sources.length > 0;
}

export function managedSkills(skills: TaggedSkill[]): TaggedSkill[] {
  return skills.filter((s) => isMemoreeManaged(s.body));
}

function skillsRootFor(skill: TaggedSkill, cwd: string): string {
  return resolveSkillsRoot(skill.source, cwd);
}

function chunkSkills(skills: TaggedSkill[], charCap: number): TaggedSkill[][] {
  if (skills.length === 0) return [];
  const chunks: TaggedSkill[][] = [];
  let current: TaggedSkill[] = [];
  let total = 0;
  for (const s of skills) {
    const block = `--- existing skill [${s.source}]: ${s.name} ---\n${s.body}\n`;
    if (current.length > 0 && total + block.length > charCap) {
      chunks.push(current);
      current = [];
      total = 0;
    }
    current.push(s);
    total += block.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function buildHygienePrompt(skills: TaggedSkill[]): string {
  const names = skills.map((s) => s.name).join(", ");
  const blocks = skills.map((s) => `--- existing skill [${s.source}]: ${s.name} ---\n${s.body}`).join("\n\n");
  return `You are curating a Memoree skill catalog. Prefer unchanged. Merge only true duplicates. Shrink only when a body is padded with repetition or filler. Archive only unused or duplicate Memoree-managed skills. Do not invent new skill names. Do not touch skills that are not listed. Every listed name MUST appear in exactly one action.

Listed skills: ${names}

Return JSON only:
{"actions":[
  {"op":"unchanged","name":"<existing>"},
  {"op":"merge","from":["a","b"],"into":"a","body":"...","description":"...","trigger":"..."},
  {"op":"shrink","name":"<existing>","body":"..."},
  {"op":"archive","name":"<existing>","reason":"duplicate of a"}
]}

${blocks}
`;
}

export interface AppliedHygiene {
  op: HygieneOp["op"];
  names: string[];
  detail: string;
}

export interface ApplyHygieneDeps {
  /** Test seam: run after the backup is taken, before mutations. */
  afterBackup?: () => void;
}

function dropPulledManifest(installRoot: string, dirName: string): void {
  const manifest = loadManifest();
  for (const entry of manifest.entries) {
    if (entry.installRoot !== installRoot) continue;
    if (entry.dirName !== dirName && entry.name !== dirName) continue;
    unlinkSymlinks(entry.symlinks);
    removePullEntry(entry.install, entry.installRoot, entry.dirName);
  }
}

export function removeManagedSkillDir(skillsRoot: string, name: string): void {
  const dir = join(skillsRoot, name);
  dropPulledManifest(skillsRoot, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function skillDirFor(skill: TaggedSkill, cwd: string): string {
  return join(skillsRootFor(skill, cwd), skill.name);
}

function mutatedSkills(actions: HygieneOp[], byName: Map<string, TaggedSkill>): TaggedSkill[] {
  const names = new Set<string>();
  for (const action of actions) {
    if (action.op === "unchanged") continue;
    if (action.op === "merge") {
      for (const n of action.from) names.add(n);
      continue;
    }
    names.add(action.name);
  }
  const out: TaggedSkill[] = [];
  for (const name of names) {
    const skill = byName.get(name);
    if (skill) out.push(skill);
  }
  return out;
}

function preflightHygieneActions(actions: HygieneOp[], byName: Map<string, TaggedSkill>, cwd: string): void {
  for (const action of actions) {
    const names = action.op === "merge" ? action.from : [action.name];
    for (const name of names) {
      assertValidSkillName(name);
      const skill = byName.get(name);
      if (!skill) throw new Error(`hygiene: unknown skill ${name}`);
      if (action.op === "unchanged") continue;
      const dir = skillDirFor(skill, cwd);
      if (!existsSync(dir)) throw new Error(`hygiene: missing skill dir ${dir}`);
    }
  }
}

function restoreHygieneBackup(mutated: TaggedSkill[], cwd: string, backupRoot: string): void {
  for (const skill of mutated) {
    const dest = skillDirFor(skill, cwd);
    const src = join(backupRoot, skill.source, skill.name);
    rmSync(dest, { recursive: true, force: true });
    if (existsSync(src)) cpSync(src, dest, { recursive: true });
  }
}

export function applyHygieneActions(
  actions: HygieneOp[],
  skills: TaggedSkill[],
  cwd: string,
  dryRun: boolean,
  deps: ApplyHygieneDeps = {},
): AppliedHygiene[] {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const applied: AppliedHygiene[] = [];
  const gone = new Set<string>();

  if (dryRun) {
    for (const action of actions) {
      if (action.op === "unchanged") {
        applied.push({ op: "unchanged", names: [action.name], detail: "left as-is" });
        continue;
      }
      if (action.op === "shrink") {
        applied.push({ op: "shrink", names: [action.name], detail: "would rewrite body" });
        continue;
      }
      if (action.op === "archive") {
        applied.push({ op: "archive", names: [action.name], detail: action.reason ?? "would remove" });
        continue;
      }
      const extras = action.from.filter((n) => n !== action.into);
      applied.push({
        op: "merge",
        names: [action.into, ...extras],
        detail: `would merge ${extras.join(", ")} into ${action.into}`,
      });
    }
    return applied;
  }

  preflightHygieneActions(actions, byName, cwd);
  const mutated = mutatedSkills(actions, byName);
  const backupRoot = mkdtempSync(join(tmpdir(), "memoree-hygiene-bak-"));
  try {
    for (const skill of mutated) {
      const src = skillDirFor(skill, cwd);
      if (!existsSync(src)) continue;
      const dest = join(backupRoot, skill.source, skill.name);
      mkdirSync(join(backupRoot, skill.source), { recursive: true });
      cpSync(src, dest, { recursive: true });
    }
    deps.afterBackup?.();

    for (const action of actions) {
      if (action.op === "unchanged") {
        applied.push({ op: "unchanged", names: [action.name], detail: "left as-is" });
        continue;
      }
      if (action.op === "shrink") {
        const skill = byName.get(action.name);
        if (!skill || gone.has(action.name)) continue;
        mergeSkill({
          skillsRoot: skillsRootFor(skill, cwd),
          name: action.name,
          body: action.body,
          newSourceSessions: [],
          agent: "hygiene",
        });
        applied.push({ op: "shrink", names: [action.name], detail: "rewrote body" });
        continue;
      }
      if (action.op === "archive") {
        const skill = byName.get(action.name);
        if (!skill || gone.has(action.name)) continue;
        removeManagedSkillDir(skillsRootFor(skill, cwd), action.name);
        gone.add(action.name);
        applied.push({ op: "archive", names: [action.name], detail: action.reason ?? "removed" });
        continue;
      }
      const target = byName.get(action.into);
      if (!target || gone.has(action.into)) continue;
      const extras = action.from.filter((n) => n !== action.into && !gone.has(n));
      mergeSkill({
        skillsRoot: skillsRootFor(target, cwd),
        name: action.into,
        body: action.body,
        description: action.description,
        trigger: action.trigger,
        newSourceSessions: [],
        agent: "hygiene",
      });
      for (const extra of extras) {
        const extraSkill = byName.get(extra);
        if (!extraSkill) continue;
        removeManagedSkillDir(skillsRootFor(extraSkill, cwd), extra);
        gone.add(extra);
      }
      applied.push({
        op: "merge",
        names: [action.into, ...extras],
        detail: `merged ${extras.join(", ")} into ${action.into}`,
      });
    }
    return applied;
  } catch (e) {
    try { restoreHygieneBackup(mutated, cwd, backupRoot); } catch { /* restore is best-effort */ }
    throw e;
  } finally {
    try { rmSync(backupRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function skipped(reason: HygieneSkipReason): HygieneCycleResult {
  return { kind: "skipped", reason, actions: [], lines: [`hygiene skipped (${reason})`], advancedLastRun: false };
}

/**
 * One hygiene cycle. Failed LLM → no writes, last-run not advanced.
 * Successful cycle (including all-unchanged) advances last-run unless dry-run.
 */
export async function runHygieneCycle(deps: HygieneCycleDeps): Promise<HygieneCycleResult> {
  if (process.env.MEMOREE_SKILLIFY_WORKER === "1" && !deps.lockHeld) {
    // Recursion guard for SessionStart spawn. CLI/worker-with-lockHeld continue.
    if (!deps.force) return skipped("recursion");
  }

  const now = (deps.now ?? Date.now)();
  if (!deps.force) {
    const last = readHygieneLastRun(deps.projectKey);
    if (last !== null && now - last < HYGIENE_QUIET_MS) return skipped("quiet");
  }

  const lockKey = hygieneLockKey(deps.projectKey);
  let acquired = deps.lockHeld === true;
  if (!acquired) {
    acquired = tryAcquireWorkerLock(lockKey);
    if (!acquired) return skipped("lock");
  }

  try {
    const listed = managedSkills((deps.listSkillsFn ?? listAllExistingSkills)(deps.cwd));
    if (listed.length === 0) {
      if (!deps.dryRun) writeHygieneLastRun(deps.projectKey, now);
      return {
        kind: deps.dryRun ? "dry-run" : "applied",
        reason: "no-managed",
        actions: [],
        lines: ["No Memoree-managed skills to curate."],
        advancedLastRun: !deps.dryRun,
      };
    }

    const chunks = chunkSkills(listed, HYGIENE_SKILLS_CHAR_CAP);
    const runGateFn = deps.runGateFn ?? ((opts) => runGate(opts));
    const actions: HygieneOp[] = [];
    for (const chunk of chunks) {
      const managedNames = new Set(chunk.map((s) => s.name));
      const result = runGateFn({ agent: deps.agent, prompt: buildHygienePrompt(chunk) });
      if (result.errored && !result.stdout.trim()) {
        return {
          kind: "failed-llm",
          actions: [],
          lines: [`hygiene LLM failed: ${result.errorMessage ?? "empty stdout"}`],
          advancedLastRun: false,
        };
      }
      const parsed = parseHygieneActions(result.stdout, managedNames);
      if (parsed === null) {
        return {
          kind: "failed-llm",
          actions: [],
          lines: ["hygiene LLM returned an unusable plan; no changes applied."],
          advancedLastRun: false,
        };
      }
      actions.push(...parsed);
    }

    let applied;
    try {
      applied = applyHygieneActions(actions, listed, deps.cwd, Boolean(deps.dryRun), deps.applyDeps);
    } catch (e) {
      return {
        kind: "failed-apply",
        actions: [],
        lines: [`hygiene apply failed: ${e instanceof Error ? e.message : String(e)}`],
        advancedLastRun: false,
      };
    }
    const lines = applied.map((a) => `${a.op}: ${a.names.join(", ")} (${a.detail})`);
    if (lines.length === 0) lines.push("hygiene: no actions");

    if (!deps.dryRun) writeHygieneLastRun(deps.projectKey, now);
    return {
      kind: deps.dryRun ? "dry-run" : "applied",
      actions,
      lines,
      advancedLastRun: !deps.dryRun,
    };
  } finally {
    if (deps.lockHeld !== true) {
      try { releaseWorkerLock(lockKey); } catch { /* best effort */ }
    }
  }
}
