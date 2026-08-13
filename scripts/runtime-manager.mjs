#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY = resolve(SCRIPT_DIR, "..");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: options.env ?? process.env,
  });
}

function capture(command, args, cwd) {
  return run(command, args, { cwd, capture: true }).trim();
}

export function runtimePaths(env = process.env) {
  const home = homedir();
  const runtimeDir = resolve(env.MEMOREE_RUNTIME_DIR ?? join(home, ".local", "share", "memoree-runtime"));
  const metadataPath = resolve(env.MEMOREE_RUNTIME_METADATA ?? join(home, ".local", "state", "memoree", "runtime.json"));
  const repository = resolve(env.MEMOREE_DEV_REPOSITORY ?? DEFAULT_REPOSITORY);
  return { runtimeDir, metadataPath, repository };
}

export function activeAgentProcesses(processList, currentPid = process.pid) {
  const active = [];
  for (const line of processList.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || Number(match[1]) === currentPid) continue;
    const command = match[2];
    // Match actual lowercase CLI executable names, not macOS helpers such as
    // "Codex (Renderer).app" that can remain resident without a live session.
    const isCli = /(^|\/)(claude|codex)(?:\s|$)/.test(command);
    const isClaudeNodeCli = /\/@anthropic-ai\/claude-code\/.*\/cli\.(?:js|mjs)(?:\s|$)/.test(command);
    // IDE extensions keep `codex ... app-server` processes resident even when
    // every interactive Codex session is closed. They do not load or execute
    // Memoree hooks, so treating them as sessions makes runtime management
    // impossible until the entire IDE is quit. Real `codex exec` / `resume`
    // processes continue to be blocked.
    const isCodexAppServer = /(^|\s)(?:\S*\/)?codex(?:\s+(?:-c|--config)\s+\S+)*\s+app-server(?:\s|$)/.test(command);
    if ((isCli || isClaudeNodeCli) && !isCodexAppServer) active.push(line.trim());
  }
  return active;
}

export function assertNoActiveAgentSessions(deps = {}) {
  const processList = deps.processList ?? capture("ps", ["-axo", "pid=,command="], process.cwd());
  const active = activeAgentProcesses(processList, deps.currentPid);
  if (active.length > 0) {
    throw new Error(
      "Refusing to change the Memoree runtime while Claude Code or Codex sessions are active. " +
      "Close every interactive session and retry. No processes were terminated.\n" + active.join("\n"),
    );
  }
}

export function resolveCommit(repository, ref = "HEAD") {
  return capture("git", ["rev-parse", "--verify", `${ref}^{commit}`], repository);
}

export function runtimeHead(runtimeDir) {
  return capture("git", ["rev-parse", "HEAD"], runtimeDir);
}

export function assertCleanRuntime(runtimeDir) {
  const dirty = capture("git", ["status", "--porcelain", "--untracked-files=all"], runtimeDir);
  if (dirty) throw new Error(`Runtime checkout is dirty; refusing to overwrite it:\n${dirty}`);
}

export function readRuntimeMetadata(metadataPath) {
  if (!existsSync(metadataPath)) return null;
  return JSON.parse(readFileSync(metadataPath, "utf8"));
}

function writeRuntimeMetadata(metadataPath, metadata) {
  mkdirSync(dirname(metadataPath), { recursive: true, mode: 0o700 });
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
}

function hasExistingState(env) {
  const home = homedir();
  const configPath = env.MEMOREE_CONFIG_PATH ?? join(home, ".memoree", "config.json");
  const databasePath = env.MEMOREE_SQLITE_PATH ?? join(home, ".memoree", "memoree.sqlite3");
  return existsSync(configPath) || existsSync(databasePath);
}

function installRuntime(runtimeDir, env = process.env) {
  run("npm", ["ci"], { cwd: runtimeDir, env });
  run("npm", ["run", "build"], { cwd: runtimeDir, env });
  run("npm", ["link"], { cwd: runtimeDir, env });

  const cli = join(runtimeDir, "bundle", "cli.js");
  if (hasExistingState(env)) {
    run(process.execPath, [cli, "claude", "install"], { cwd: runtimeDir, env });
  } else {
    run(process.execPath, [cli, "install"], { cwd: runtimeDir, env });
  }
  run(process.execPath, [cli, "codex", "install"], { cwd: runtimeDir, env });
  run(process.execPath, [cli, "doctor"], { cwd: runtimeDir, env });
}

function checkoutRuntime(runtimeDir, sha) {
  run("git", ["checkout", "--detach", sha], { cwd: runtimeDir });
}

function ensureRuntimeCheckout(repository, runtimeDir, sha) {
  if (!existsSync(runtimeDir)) {
    mkdirSync(dirname(runtimeDir), { recursive: true });
    run("git", ["worktree", "add", "--detach", runtimeDir, sha], { cwd: repository });
    return;
  }
  const top = capture("git", ["rev-parse", "--show-toplevel"], runtimeDir);
  if (realpathSync(top) !== realpathSync(runtimeDir)) {
    throw new Error(`${runtimeDir} exists but is not the root of a Git worktree`);
  }
  const repositoryCommonDir = resolve(repository, capture("git", ["rev-parse", "--git-common-dir"], repository));
  const runtimeCommonDir = resolve(runtimeDir, capture("git", ["rev-parse", "--git-common-dir"], runtimeDir));
  if (realpathSync(repositoryCommonDir) !== realpathSync(runtimeCommonDir)) {
    throw new Error(`${runtimeDir} belongs to a different Git repository`);
  }
  assertCleanRuntime(runtimeDir);
  checkoutRuntime(runtimeDir, sha);
}

function promoteTo({ repository, runtimeDir, metadataPath }, targetSha, options = {}) {
  assertCleanRuntime(runtimeDir);
  const previousSha = runtimeHead(runtimeDir);
  if (targetSha === previousSha && options.allowSame !== true) {
    throw new Error(`Runtime is already at ${targetSha}`);
  }

  checkoutRuntime(runtimeDir, targetSha);
  try {
    installRuntime(runtimeDir);
  } catch (cause) {
    let restoreError;
    try {
      checkoutRuntime(runtimeDir, previousSha);
      installRuntime(runtimeDir);
    } catch (error) {
      restoreError = error;
    }
    if (restoreError) {
      throw new Error(`Promotion failed and automatic restoration also failed: ${restoreError.message}`, { cause });
    }
    throw new Error(`Promotion failed; restored runtime ${previousSha}`, { cause });
  }

  writeRuntimeMetadata(metadataPath, {
    repository: realpathSync(repository),
    runtimeDir: realpathSync(runtimeDir),
    currentSha: targetSha,
    previousSha,
    updatedAt: new Date().toISOString(),
  });
}

export function initializeRuntime(ref = "HEAD") {
  assertNoActiveAgentSessions();
  const paths = runtimePaths();
  const sha = resolveCommit(paths.repository, ref);
  const existed = existsSync(paths.runtimeDir);
  const previousSha = existed ? runtimeHead(paths.runtimeDir) : null;
  ensureRuntimeCheckout(paths.repository, paths.runtimeDir, sha);
  try {
    installRuntime(paths.runtimeDir);
  } catch (cause) {
    if (previousSha && previousSha !== sha) {
      try {
        checkoutRuntime(paths.runtimeDir, previousSha);
        installRuntime(paths.runtimeDir);
      } catch (restoreError) {
        throw new Error(`Runtime initialization failed and restoration also failed: ${restoreError.message}`, { cause });
      }
    }
    throw new Error(`Runtime initialization failed at ${sha}`, { cause });
  }
  writeRuntimeMetadata(paths.metadataPath, {
    repository: realpathSync(paths.repository),
    runtimeDir: realpathSync(paths.runtimeDir),
    currentSha: sha,
    previousSha,
    updatedAt: new Date().toISOString(),
  });
  process.stdout.write(`Memoree runtime initialized at ${sha}\n`);
}

export function promoteRuntime(ref = "HEAD") {
  assertNoActiveAgentSessions();
  const paths = runtimePaths();
  if (!existsSync(paths.runtimeDir)) throw new Error("Runtime checkout is missing; run `npm run runtime:init` first");
  promoteTo(paths, resolveCommit(paths.repository, ref));
  process.stdout.write(`Memoree runtime promoted to ${runtimeHead(paths.runtimeDir)}\n`);
}

export function rollbackRuntime() {
  assertNoActiveAgentSessions();
  const paths = runtimePaths();
  const metadata = readRuntimeMetadata(paths.metadataPath);
  if (!metadata?.previousSha) throw new Error("No previous runtime revision is recorded");
  if (!existsSync(paths.runtimeDir)) throw new Error("Runtime checkout is missing; rollback is unavailable");
  promoteTo(paths, resolveCommit(paths.repository, metadata.previousSha));
  process.stdout.write(`Memoree runtime rolled back to ${runtimeHead(paths.runtimeDir)}\n`);
}

async function main() {
  const [command, ref = "HEAD"] = process.argv.slice(2);
  if (command === "init") initializeRuntime(ref);
  else if (command === "promote") promoteRuntime(ref);
  else if (command === "rollback") rollbackRuntime();
  else throw new Error("Usage: runtime-manager.mjs <init|promote|rollback> [git-ref]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`memoree runtime: ${error.message}\n`);
    if (error.cause instanceof Error) process.stderr.write(`cause: ${error.cause.message}\n`);
    process.exitCode = 1;
  });
}
