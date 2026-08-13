import type { ExecFileSyncOptions } from "node:child_process";
import { binNeedsShell, shellFile } from "../utils/resolve-cli-bin.js";

/** Fixed flags for the summary-generation `claude -p` call (no user input). */
const CLAUDE_FLAGS = [
  "--no-session-persistence",
  "--model",
  "haiku",
  "--permission-mode",
  "bypassPermissions",
] as const;

export interface ClaudeInvocation {
  file: string;
  args: string[];
  options: ExecFileSyncOptions;
}

/**
 * Build the `execFileSync` descriptor for the summary-generation claude call.
 *
 * Windows (`.cmd`/`.bat` shim): the shim cannot be spawned without a shell,
 * and the multi-KB prompt must NOT ride the command line — cmd.exe would
 * expand `%VAR%`/metacharacters in it and it can blow the ~8 KB arg limit. So
 * the prompt goes over stdin (`input`) and only the fixed flags — never user
 * text — are passed as args under the shell, which keeps the shell call free
 * of injection.
 *
 * Everywhere else (Unix, or a Windows `.exe`): unchanged from the original —
 * prompt as a positional arg, no shell — so the already-working path stays
 * byte-identical.
 */
export function buildClaudeInvocation(claudeBin: string, prompt: string): ClaudeInvocation {
  if (binNeedsShell(claudeBin)) {
    return {
      file: shellFile(claudeBin),
      args: ["-p", ...CLAUDE_FLAGS],
      // windowsHide: the wiki worker is a detached, console-less process, so
      // without CREATE_NO_WINDOW Windows allocates a visible console window
      // (titled after the CLI exe) for the child. No-op on POSIX.
      options: { input: prompt, stdio: ["pipe", "pipe", "pipe"], shell: true, windowsHide: true },
    };
  }
  return {
    file: claudeBin,
    args: ["-p", prompt, ...CLAUDE_FLAGS],
    options: { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  };
}

/**
 * Build an `execFileSync` descriptor for an agent CLI that takes its prompt as
 * the LAST positional arg (Codex `exec … <prompt>`). `flags` are everything
 * BEFORE the prompt.
 *
 * Same Windows `.cmd` handling as {@link buildClaudeInvocation}: route the
 * prompt over stdin under a shell so it never hits the command line. Unix (and
 * Windows `.exe`) keep the prompt as the trailing arg — unchanged behavior.
 *
 * Regression-proof by construction: the non-shell branch is byte-identical to
 * the original call, and the shell branch only ever replaces a path that is
 * already unrunnable (a `.cmd` under the old no-shell `execFileSync`).
 */
export function buildTrailingPromptInvocation(bin: string, flags: string[], prompt: string): ClaudeInvocation {
  if (binNeedsShell(bin)) {
    return {
      file: shellFile(bin),
      args: [...flags],
      // windowsHide: see buildClaudeInvocation — suppress the visible console
      // window Windows would pop for a child of the console-less worker.
      options: { input: prompt, stdio: ["pipe", "pipe", "pipe"], shell: true, windowsHide: true },
    };
  }
  return {
    file: bin,
    args: [...flags, prompt],
    options: { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  };
}

/**
 * Build an invocation whose prompt ALWAYS travels over stdin, never argv.
 * Doc generation feeds whole source files into the prompt, which can exceed
 * the OS argv limit (E2BIG on multi-hundred-KB files); stdin has no such cap.
 * `flags` must already include whatever tells the CLI to read stdin
 * (claude: `-p` with no positional; codex: trailing `-`).
 */
export function buildStdinPromptInvocation(bin: string, flags: string[], prompt: string): ClaudeInvocation {
  return {
    file: shellFile(bin),
    args: [...flags],
    options: {
      input: prompt,
      stdio: ["pipe", "pipe", "pipe"],
      // windowsHide: see buildClaudeInvocation — the doc/wiki worker is a
      // detached, console-less process, so without CREATE_NO_WINDOW Windows
      // pops a visible console window for the summarizer CLI. No-op on POSIX.
      windowsHide: true,
      ...(binNeedsShell(bin) ? { shell: true } : {}),
    },
  };
}

/** Claude variant of {@link buildStdinPromptInvocation} (same fixed flags as the argv path). */
export function buildClaudeStdinInvocation(claudeBin: string, prompt: string): ClaudeInvocation {
  return buildStdinPromptInvocation(claudeBin, ["-p", ...CLAUDE_FLAGS], prompt);
}
