/**
 * Run the gate prompt through the originating agent's own CLI.
 *
 * Each agent ships its own headless CLI; we use the same one its
 * wiki-worker uses for summary generation, so a user who only has
 * Codex installed never needs `claude` in PATH.
 *
 * Per-agent invocation:
 *   claude_code → `claude -p <prompt> --no-session-persistence --model haiku --permission-mode bypassPermissions`
 *   codex       → `codex exec --dangerously-bypass-approvals-and-sandbox <prompt>`
 *
 * The worker passes a verdict-write path inside the prompt; the runner
 * captures stdout regardless so the worker's stdout-fallback path still
 * works on agents whose models don't reliably use the Write tool.
 */

import { existsSync } from "node:fs";
import { execFileSync as runChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export type Agent = "claude_code" | "codex";

export interface GateRunOptions {
  agent: Agent;
  prompt: string;
  /** Override the binary path. If absent, the runner finds it in PATH or uses a fallback. */
  bin?: string;
  /** Max wall-clock for the CLI call; default 120s. */
  timeoutMs?: number;
}

export interface GateRunResult {
  stdout: string;
  stderr: string;
  /** true if the CLI exited non-zero. stdout/stderr are still populated when possible. */
  errored: boolean;
  errorMessage?: string;
}

/**
 * Locate the binary for an agent by checking a hard-coded list of known
 * install locations, in priority order, until one exists on disk.
 *
 * Each agent's documented install paths cover the common cases; users
 * who put the binary somewhere exotic can either symlink it into one of
 * these locations, or set up a per-agent override (future env-driven
 * config can flow in via the worker config JSON, not env vars).
 */
function firstExistingPath(candidates: string[]): string | null {
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export function findAgentBin(agent: Agent): string {
  const home = homedir();
  switch (agent) {
    // /usr/bin/<name> is included in every candidate list — that's the
    // common Linux package-manager install path (apt, dnf, pacman). Old
    // code used `which` which always checked it; the static-scan fix
    // dropped `which`, so /usr/bin needs to be explicit. CodeRabbit on
    // #170 caught the gap.
    case "claude_code":
      return firstExistingPath([
        join(home, ".claude", "local", "claude"),
        "/usr/local/bin/claude",
        "/usr/bin/claude",
        join(home, ".npm-global", "bin", "claude"),
        join(home, ".local", "bin", "claude"),
        "/opt/homebrew/bin/claude",
      ]) ?? join(home, ".claude", "local", "claude");
    case "codex":
      return firstExistingPath([
        "/usr/local/bin/codex",
        "/usr/bin/codex",
        join(home, ".npm-global", "bin", "codex"),
        join(home, ".local", "bin", "codex"),
        "/opt/homebrew/bin/codex",
      ]) ?? "/usr/local/bin/codex";
  }
}

export function buildArgs(agent: Agent, prompt: string, opts: GateRunOptions): string[] {
  switch (agent) {
    case "claude_code":
      return [
        "-p", prompt,
        "--no-session-persistence",
        "--model", "haiku",
        "--permission-mode", "bypassPermissions",
      ];
    case "codex":
      return [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        prompt,
      ];
  }
}

export function runGate(opts: GateRunOptions): GateRunResult {
  const bin = opts.bin ?? findAgentBin(opts.agent);
  if (!existsSync(bin)) {
    return {
      stdout: "", stderr: "",
      errored: true,
      errorMessage: `agent binary not found at ${bin} (agent=${opts.agent})`,
    };
  }
  const args = buildArgs(opts.agent, opts.prompt, opts);
  try {
    const result = runChildProcess(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // Suppress the visible console window Windows would otherwise pop for
      // a child of the console-less detached skillify worker. No-op on POSIX.
      windowsHide: true,
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, MEMOREE_WIKI_WORKER: "1", MEMOREE_CAPTURE: "false" },
    });
    return { stdout: result.toString("utf-8"), stderr: "", errored: false };
  } catch (e: any) {
    return {
      stdout: e.stdout?.toString("utf-8") ?? "",
      stderr: e.stderr?.toString("utf-8") ?? "",
      errored: true,
      errorMessage: `${opts.agent} CLI failed: ${e.status ?? e.code ?? e.message}`,
    };
  }
}
