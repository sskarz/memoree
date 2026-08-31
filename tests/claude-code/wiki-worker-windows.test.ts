import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Windows regression guard for the wiki-worker summary generation path.
 *
 * Root cause (confirmed against a real Windows user whose memory table held
 * 54/54 empty placeholder summaries):
 *   1. The CLI resolver shelled out to `which claude 2>/dev/null` — `which`
 *      does not exist on Windows (it's `where`) — and fell back to an
 *      extensionless `~/.claude/local/claude`, which is not a runnable
 *      Windows program.
 *   2. The worker then ran `execFileSync(claudeBin, ["-p", prompt, ...])` with
 *      no shell. Node cannot launch a `.cmd`/`.bat` shim without a shell, so
 *      the spawn threw ENOENT, the worker swallowed it, the summary file was
 *      never written, and the SessionStart placeholder was never replaced.
 *
 * These tests pin the cross-platform resolution + the shell/stdin spawn shape
 * without launching any real process.
 */

const execFileSyncMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: (...a: unknown[]) => execFileSyncMock(...a) };
});
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => "/home/tester" };
});

import { resolveCliBin, binNeedsShell, shellFile } from "../../src/utils/resolve-cli-bin.js";
import {
  buildAgyInvocation,
  buildClaudeInvocation,
  buildClaudeStdinInvocation,
  buildClaudeWorkerEnvironment,
  buildStdinPromptInvocation,
  buildTrailingPromptInvocation,
} from "../../src/hooks/wiki-worker-spawn.js";

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  execFileSyncMock.mockReset();
});

const CLAUDE_FLAGS = [
  "--no-session-persistence",
  "--model",
  "haiku",
  "--permission-mode",
  "bypassPermissions",
];

describe("resolveCliBin — Windows", () => {
  it("locates the CLI with `where` (not `which`)", () => {
    setPlatform("win32");
    execFileSyncMock.mockReturnValue("C:\\npm\\claude.cmd\r\n");
    resolveCliBin("claude");
    expect(execFileSyncMock).toHaveBeenCalledWith("where", ["claude"], { encoding: "utf-8", windowsHide: true });
  });

  it("prefers a .exe over a .cmd shim when both are on PATH", () => {
    setPlatform("win32");
    execFileSyncMock.mockReturnValue(
      ["C:\\npm\\claude", "C:\\npm\\claude.ps1", "C:\\npm\\claude.cmd", "C:\\pf\\claude.exe"].join("\r\n") + "\r\n",
    );
    expect(resolveCliBin("claude")).toBe("C:\\pf\\claude.exe");
  });

  it("prefers a .cmd shim when no .exe is present", () => {
    setPlatform("win32");
    execFileSyncMock.mockReturnValue(["C:\\npm\\claude", "C:\\npm\\claude.cmd", "C:\\npm\\claude.ps1"].join("\r\n"));
    expect(resolveCliBin("claude")).toBe("C:\\npm\\claude.cmd");
  });

  it("returns the first match when `where` lists no .exe/.cmd (e.g. only .ps1)", () => {
    setPlatform("win32");
    execFileSyncMock.mockReturnValue(["C:\\npm\\claude.ps1", "C:\\npm\\claude"].join("\r\n"));
    expect(resolveCliBin("claude")).toBe("C:\\npm\\claude.ps1");
  });

  it("falls back to ~/.claude/local/<cli>.cmd when `where` finds nothing", () => {
    setPlatform("win32");
    execFileSyncMock.mockImplementation(() => { throw new Error("INFO: Could not find files"); });
    const bin = resolveCliBin("claude");
    expect(bin.endsWith("claude.cmd")).toBe(true);
    expect(bin.includes("local")).toBe(true);
  });

  it("falls back when `where` prints no usable matches", () => {
    setPlatform("win32");
    execFileSyncMock.mockReturnValue("\r\n  \r\n");
    expect(resolveCliBin("claude").endsWith("claude.cmd")).toBe(true);
  });
});

describe("resolveCliBin — Unix (unchanged behavior)", () => {
  it("locates the CLI with `which` and returns the first match", () => {
    setPlatform("linux");
    execFileSyncMock.mockReturnValue("/usr/local/bin/claude\n");
    expect(resolveCliBin("claude")).toBe("/usr/local/bin/claude");
    // windowsHide is a no-op on POSIX but the option object is platform-agnostic.
    expect(execFileSyncMock).toHaveBeenCalledWith("which", ["claude"], { encoding: "utf-8", windowsHide: true });
  });

  it("falls back to an extensionless ~/.claude/local/<cli> when not found", () => {
    setPlatform("linux");
    execFileSyncMock.mockImplementation(() => { throw new Error("not found"); });
    const bin = resolveCliBin("claude");
    expect(bin.endsWith("claude")).toBe(true);
    expect(bin.endsWith(".cmd")).toBe(false);
  });
});

describe("binNeedsShell", () => {
  it("stdin builders add shell:true for a Windows .cmd shim, and omit it otherwise", () => {
    setPlatform("win32");
    const winInv = buildStdinPromptInvocation("claude.cmd", ["-p"], "PROMPT");
    expect(winInv.options.shell).toBe(true);
    expect(winInv.options.input).toBe("PROMPT");
    const winClaude = buildClaudeStdinInvocation("claude.cmd", "PROMPT");
    expect(winClaude.options.shell).toBe(true);
    setPlatform("linux");
    const nixInv = buildStdinPromptInvocation("/usr/bin/claude", ["-p"], "PROMPT");
    expect(nixInv.options.shell).toBeUndefined();
  });

  it("is true only for Windows .cmd/.bat shims", () => {
    setPlatform("win32");
    expect(binNeedsShell("C:\\x\\claude.cmd")).toBe(true);
    expect(binNeedsShell("C:\\x\\claude.BAT")).toBe(true);
    expect(binNeedsShell("C:\\x\\claude.exe")).toBe(false);
  });

  it("is false on Unix even for a .cmd-looking name", () => {
    setPlatform("linux");
    expect(binNeedsShell("/x/claude.cmd")).toBe(false);
  });
});

describe("buildClaudeInvocation", () => {
  it("Windows .cmd: spawns through a shell with the prompt over stdin, never on the command line", () => {
    setPlatform("win32");
    const inv = buildClaudeInvocation("C:\\npm\\claude.cmd", "PROMPT-TEXT");
    // quoted: under shell:true Node concatenates without escaping, so the
    // path must carry its own quotes (see the spaced-path describe below)
    expect(inv.file).toBe('"C:\\npm\\claude.cmd"');
    expect(inv.options.shell).toBe(true);
    expect(inv.options.input).toBe("PROMPT-TEXT");
    expect(inv.args).toEqual(["-p", ...CLAUDE_FLAGS]);
    expect(inv.args).not.toContain("PROMPT-TEXT");
  });

  it("Unix: prompt is a positional arg, no shell, no stdin (byte-identical to the original)", () => {
    setPlatform("linux");
    const inv = buildClaudeInvocation("/usr/local/bin/claude", "PROMPT-TEXT");
    expect(inv.options.shell).toBeFalsy();
    expect(inv.options.input).toBeUndefined();
    expect(inv.args).toEqual(["-p", "PROMPT-TEXT", ...CLAUDE_FLAGS]);
  });

  it("Windows .exe: spawns directly (no shell), prompt as arg", () => {
    setPlatform("win32");
    const inv = buildClaudeInvocation("C:\\pf\\claude.exe", "PROMPT-TEXT");
    expect(inv.options.shell).toBeFalsy();
    expect(inv.args).toContain("PROMPT-TEXT");
  });

  it("adds safe mode only for authenticated runtime validation", () => {
    setPlatform("linux");
    expect(buildClaudeInvocation("/usr/local/bin/claude", "P", {
      MEMOREE_RUNTIME_VALIDATION: "1",
    }).args).toContain("--safe-mode");
    expect(buildClaudeInvocation("/usr/local/bin/claude", "P", {}).args).not.toContain("--safe-mode");
  });
});

describe("buildAgyInvocation", () => {
  it("Unix: prompt is a positional arg with dangerously-skip-permissions, no GEMINI_API_KEY rewrite", () => {
    setPlatform("linux");
    const inv = buildAgyInvocation("/usr/local/bin/agy", "PROMPT-TEXT");
    expect(inv.file).toBe("/usr/local/bin/agy");
    expect(inv.args).toEqual(["-p", "PROMPT-TEXT", "--dangerously-skip-permissions"]);
    expect(inv.options.shell).toBeFalsy();
    expect(inv.options.windowsHide).toBe(true);
  });

  it("Windows .cmd: prompt travels over stdin, never argv", () => {
    setPlatform("win32");
    const inv = buildAgyInvocation("C:\\npm\\agy.cmd", "PROMPT-TEXT");
    expect(inv.options.shell).toBe(true);
    expect(inv.options.input).toBe("PROMPT-TEXT");
    expect(inv.args).toEqual(["-p", "--dangerously-skip-permissions"]);
    expect(inv.args).not.toContain("PROMPT-TEXT");
    expect(inv.options.windowsHide).toBe(true);
  });
});

describe("buildClaudeWorkerEnvironment", () => {
  it("keeps ordinary summary workers on their existing HOME", () => {
    expect(buildClaudeWorkerEnvironment({ HOME: "/home/normal" })).toMatchObject({
      HOME: "/home/normal",
      MEMOREE_WIKI_WORKER: "1",
      MEMOREE_CAPTURE: "false",
    });
  });

  it("uses authenticated Claude context only during isolated runtime validation", () => {
    const env = buildClaudeWorkerEnvironment({
      HOME: "/tmp/disposable",
      CLAUDE_CONFIG_DIR: "/tmp/disposable/.claude",
      MEMOREE_RUNTIME_VALIDATION: "1",
      MEMOREE_VALIDATION_CLAUDE_HOME: "/Users/tester",
    });
    expect(env).toMatchObject({
      HOME: "/Users/tester",
      CLAUDE_CODE_SAFE_MODE: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      MEMOREE_WIKI_WORKER: "1",
      MEMOREE_CAPTURE: "false",
    });
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("preserves an explicitly configured authenticated Claude directory", () => {
    const env = buildClaudeWorkerEnvironment({
      MEMOREE_RUNTIME_VALIDATION: "1",
      MEMOREE_VALIDATION_CLAUDE_HOME: "/Users/tester",
      MEMOREE_VALIDATION_CLAUDE_CONFIG_DIR: "/custom/claude",
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/custom/claude");
  });
});

describe("buildTrailingPromptInvocation (Codex)", () => {
  // Prompt is the LAST positional arg; `flags` are everything before it.
  const FLAGS = ["exec", "--dangerously-bypass-approvals-and-sandbox"];

  it("Windows .cmd: shell + prompt over stdin; flags only on the command line", () => {
    setPlatform("win32");
    const inv = buildTrailingPromptInvocation("C:\\npm\\codex.cmd", FLAGS, "PROMPT-TEXT");
    expect(inv.file).toBe('"C:\\npm\\codex.cmd"');
    expect(inv.options.shell).toBe(true);
    expect(inv.options.input).toBe("PROMPT-TEXT");
    expect(inv.args).toEqual(FLAGS);
    expect(inv.args).not.toContain("PROMPT-TEXT");
  });

  it("Unix: prompt is the trailing arg, no shell, no stdin (byte-identical to the original)", () => {
    setPlatform("linux");
    const inv = buildTrailingPromptInvocation("/usr/local/bin/codex", FLAGS, "PROMPT-TEXT");
    expect(inv.options.shell).toBeFalsy();
    expect(inv.options.input).toBeUndefined();
    expect(inv.args).toEqual([...FLAGS, "PROMPT-TEXT"]);
  });
});

describe("windowsHide — no visible console window for the summarizer CLI", () => {
  // The wiki worker is spawned detached and console-less (spawn-detached.ts
  // sets windowsHide on the worker itself). Without CREATE_NO_WINDOW on the
  // INNER spawn too, Windows allocates a fresh visible console window titled
  // after the CLI exe (users reported a bare "claude.exe" window popping up).
  it("buildClaudeInvocation sets windowsHide on every branch", () => {
    setPlatform("win32");
    expect(buildClaudeInvocation("C:\\npm\\claude.cmd", "P").options.windowsHide).toBe(true);
    expect(buildClaudeInvocation("C:\\pf\\claude.exe", "P").options.windowsHide).toBe(true);
    setPlatform("linux");
    expect(buildClaudeInvocation("/usr/local/bin/claude", "P").options.windowsHide).toBe(true);
  });

  it("buildTrailingPromptInvocation sets windowsHide on every branch", () => {
    const FLAGS = ["exec"];
    setPlatform("win32");
    expect(buildTrailingPromptInvocation("C:\\npm\\codex.cmd", FLAGS, "P").options.windowsHide).toBe(true);
    expect(buildTrailingPromptInvocation("C:\\pf\\codex.exe", FLAGS, "P").options.windowsHide).toBe(true);
    setPlatform("linux");
    expect(buildTrailingPromptInvocation("/usr/local/bin/codex", FLAGS, "P").options.windowsHide).toBe(true);
  });

  // buildStdinPromptInvocation feeds whole-file prompts over stdin for the doc
  // REFRESH/GENERATE path (refresh-llm.ts runHostPrompt execFileSyncs it), so
  // it is another inner summarizer-CLI spawn that must not pop a console window.
  it("buildStdinPromptInvocation sets windowsHide on the .cmd (shell) branch", () => {
    setPlatform("win32");
    expect(buildStdinPromptInvocation("C:\\npm\\codex.cmd", ["-"], "P").options.windowsHide).toBe(true);
    expect(buildStdinPromptInvocation("C:\\npm\\codex.cmd", ["-"], "P").options.shell).toBe(true);
  });

  it("buildStdinPromptInvocation sets windowsHide on the .exe / Unix branch", () => {
    setPlatform("win32");
    expect(buildStdinPromptInvocation("C:\\pf\\codex.exe", ["-"], "P").options.windowsHide).toBe(true);
    setPlatform("linux");
    expect(buildStdinPromptInvocation("/usr/local/bin/codex", ["-"], "P").options.windowsHide).toBe(true);
  });

  it("buildClaudeStdinInvocation inherits windowsHide from the stdin builder", () => {
    setPlatform("win32");
    expect(buildClaudeStdinInvocation("C:\\npm\\claude.cmd", "P").options.windowsHide).toBe(true);
    setPlatform("linux");
    expect(buildClaudeStdinInvocation("/usr/local/bin/claude", "P").options.windowsHide).toBe(true);
  });
});

/**
 * Behavioral cover for the spaced-path bug. `shell: true` makes Node
 * concatenate file + args into one command string with NO escaping, so an
 * unquoted path with a space is parsed as two tokens and the spawn fails.
 *
 * This is the default npm layout for any Windows account whose name contains
 * a space — `C:\Users\Jane Doe\AppData\Roaming\npm\claude.cmd` — and npm
 * ships no .exe, so those users always take the shell branch. A failing
 * summary run is what drives the #331 respawn loop, so this path matters.
 */
describe("shell-mode spawns quote a shim path containing spaces", () => {
  const SPACED = "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd";

  it("shellFile quotes a Windows shim and leaves everything else alone", () => {
    setPlatform("win32");
    expect(shellFile(SPACED)).toBe(`"${SPACED}"`);
    expect(shellFile("C:\\x\\claude.exe")).toBe("C:\\x\\claude.exe");
    setPlatform("linux");
    // a POSIX file merely named *.cmd is spawned directly — quoting it would
    // make the path itself wrong
    expect(shellFile("/usr/bin/weird.cmd")).toBe("/usr/bin/weird.cmd");
  });

  it("buildClaudeInvocation quotes the spaced shim and keeps the prompt off argv", () => {
    setPlatform("win32");
    const inv = buildClaudeInvocation(SPACED, "PROMPT");
    expect(inv.file).toBe(`"${SPACED}"`);
    expect(inv.options.shell).toBe(true);
    expect(inv.options.input).toBe("PROMPT");
    expect(inv.args).not.toContain("PROMPT");
  });

  it("buildTrailingPromptInvocation quotes the spaced shim", () => {
    setPlatform("win32");
    const inv = buildTrailingPromptInvocation(SPACED, ["exec"], "PROMPT");
    expect(inv.file).toBe(`"${SPACED}"`);
    expect(inv.options.shell).toBe(true);
  });

  it("buildStdinPromptInvocation quotes the spaced shim", () => {
    setPlatform("win32");
    const inv = buildStdinPromptInvocation(SPACED, ["-p"], "PROMPT");
    expect(inv.file).toBe(`"${SPACED}"`);
    expect(inv.options.shell).toBe(true);
  });

  it("does NOT quote on the non-shell path, where argv is passed directly", () => {
    setPlatform("win32");
    const exe = "C:\\Program Files\\claude\\claude.exe";
    const inv = buildClaudeInvocation(exe, "PROMPT");
    // no shell -> argv, so a quoted path would be a literally wrong filename
    expect(inv.file).toBe(exe);
    expect(inv.options.shell).toBeUndefined();
  });
});
