/**
 * Branch-coverage suite for `src/hooks/codex/pre-tool-use.ts`.
 *
 * The codex hook mirrors the Claude Code pre-tool-use hook's routing
 * logic but has its own decision shape (`action: "pass" | "guide" |
 * "block"`) and a single Bash-command input (no separate Read tool).
 * Before this suite the file sat at 0% coverage. This file drives the
 * real `processCodexPreToolUse` entry point across every branch
 * that the hook supports — not smoke tests, actual routing + content
 * assertions per-branch.
 */

import { describe, expect, it, vi } from "vitest";
import { Bash } from "just-bash";
import {
  buildUnsupportedGuidance,
  processCodexPreToolUse,
} from "../../src/hooks/codex/pre-tool-use.js";

const BASE_CONFIG = {
  token: "t",
  apiUrl: "http://example",
  orgId: "org",
  orgName: "org",
  userName: "u",
  workspaceId: "default",
};

function makeApi(queryResponses: Record<string, unknown>[] | ((sql: string) => Record<string, unknown>[]) = []) {
  return {
    query: vi.fn(async (sql: string) =>
      typeof queryResponses === "function" ? queryResponses(sql) : queryResponses,
    ),
  } as any;
}

/** Base deps every test wants: neutral cache (no hit) + log silent. */
function baseDeps(extra: Record<string, any> = {}) {
  return {
    config: BASE_CONFIG as any,
    createApi: vi.fn(() => makeApi()),
    readCachedIndexContentFn: vi.fn(() => null) as any,
    writeCachedIndexContentFn: vi.fn() as any,
    logFn: vi.fn(),
    ...extra,
  };
}

function toolInput(command: string, overrides: Record<string, unknown> = {}) {
  return {
    session_id: "s",
    tool_name: "shell",
    tool_use_id: "tu-1",
    tool_input: { command },
    cwd: "/tmp",
    hook_event_name: "pre_tool_use",
    model: "gpt-test",
    ...overrides,
  };
}

describe("codex: pure helpers", () => {
  it("buildUnsupportedGuidance names the public sandbox contract and security limits", () => {
    const s = buildUnsupportedGuidance();
    expect(s).toContain("Supported sandboxed commands: cat, ls, grep, head, tail, wc, find, jq, echo, printf, tee.");
    expect(s).toContain("Interpreters");
    expect(s).toContain("sed and awk are unavailable");
  });

});

describe("processCodexPreToolUse: pass-through + unsafe", () => {
  it("returns `pass` when the command doesn't mention the memory path", async () => {
    const d = await processCodexPreToolUse(
      toolInput("ls /tmp"),
      baseDeps(),
    );
    expect(d.action).toBe("pass");
  });

  it("blocks (not `guide`) the unsafe command when a memory-path command uses an interpreter", async () => {
    // "guide" exits 0 and would let Codex run python on the host; must block.
    const d = await processCodexPreToolUse(
      toolInput("python ~/.memoree/memory/x.py"),
      baseDeps(),
    );
    expect(d.action).toBe("block");
    expect(d.output).toContain("denied");
    expect(d.rewrittenCommand).toContain("python");
  });

  it.each([
    "sed -n '1p' ~/.memoree/memory/index.md",
    "awk '{print $1}' ~/.memoree/memory/index.md",
    "python ~/.memoree/memory/x.py",
    "node ~/.memoree/memory/x.js",
    "curl file://~/.memoree/memory/index.md",
    "cat $(printf ~/.memoree/memory/index.md)",
    "cat `printf ~/.memoree/memory/index.md`",
    "find ~/.memoree/memory -name '*.md' -exec cat {} ;",
  ])("reserves block for policy-rejected command: %s", async (command) => {
    const d = await processCodexPreToolUse(toolInput(command), baseDeps());
    expect(d.action).toBe("block");
    expect(d.output).toContain("denied");
    expect(d.replacementCommand).toBeUndefined();
  });

  it("turns unavailable storage into an ordinary nonzero command failure", async () => {
    const d = await processCodexPreToolUse(
      toolInput("cat ~/.memoree/memory/index.md"),
      { ...baseDeps(), config: null as any },
    );
    expect(d.action).toBe("allow");
    expect(d.output).toContain("storage is unavailable");
    expect(d.replacementCommand).toContain(">&2");
    expect(d.replacementCommand).toContain("exit 1");
  });

  it("turns storage backend construction failure into an ordinary nonzero command failure", async () => {
    const d = await processCodexPreToolUse(
      toolInput("cat ~/.memoree/memory/index.md"),
      {
        ...baseDeps(),
        createApi: vi.fn(() => { throw new Error("database locked"); }),
      },
    );
    expect(d.action).toBe("allow");
    expect(d.output).toContain("database locked");
    expect(d.replacementCommand).toContain("exit 1");
  });

  it("returns a normal nonzero failure for a concrete cat on a missing VFS file", async () => {
    const d = await processCodexPreToolUse(
      toolInput("cat ~/.memoree/memory/nonexistent.md"),
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () => null) as any,
      },
    );
    expect(d.action).toBe("allow");
    expect(d.output).toContain("No such file or directory");
    // Path-specific, not a generic error (a regression to generic text must fail).
    expect(d.output).toContain("nonexistent.md");
    expect(d.output).not.toContain("denied");
    expect(d.replacementCommand).toContain("exit 1");
    expect(d.replacementCommand).not.toContain(".memoree/memory");
  });
});

describe("processCodexPreToolUse: compiled bash fast-path", () => {
  it("delegates to executeCompiledBashCommand and allows a harmless output replacement", async () => {
    const executeCompiledBashCommandFn = vi.fn(async () => "COMPILED OUTPUT") as any;
    const d = await processCodexPreToolUse(
      toolInput("cat ~/.memoree/memory/index.md && ls ~/.memoree/memory/summaries"),
      { ...baseDeps(), executeCompiledBashCommandFn },
    );
    expect(d.action).toBe("allow");
    expect(d.output).toBe("COMPILED OUTPUT");
    expect(executeCompiledBashCommandFn).toHaveBeenCalled();
  });

  it.each([
    ["cat", "cat ~/.memoree/memory/index.md"],
    ["ls", "ls ~/.memoree/memory/summaries"],
    ["grep", "grep -ri 'runtime' ~/.memoree/memory/summaries/"],
    ["head", "head -5 ~/.memoree/memory/index.md"],
    ["tail", "tail -5 ~/.memoree/memory/index.md"],
    ["wc", "wc -l ~/.memoree/memory/index.md"],
    ["find", "find ~/.memoree/memory/summaries -name '*.md'"],
  ])(
    "returns allow for a successful curated %s read",
    async (command, invocation) => {
      const d = await processCodexPreToolUse(
        toolInput(invocation),
        {
          ...baseDeps(),
          executeCompiledBashCommandFn: vi.fn(async () => `${command} output`) as any,
        },
      );
      expect(d.action).toBe("allow");
      expect(d.output).toBe(`${command} output`);
      expect(d.replacementCommand).toBe(`printf '%s\\n' '${command} output'`);
    },
  );

  it("returns allow for successful jq processing through the VFS shell", async () => {
    const d = await processCodexPreToolUse(
      toolInput("cat ~/.memoree/memory/valid.json | jq '.items | length'"),
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        runVfsShellFn: vi.fn(() => ({ status: 0, stdout: "3\n", stderr: "" })),
      },
    );
    expect(d.action).toBe("allow");
    expect(d.output).toBe("3");
    expect(d.replacementCommand).toBe("printf '%s\\n' '3'");
  });

  it("caps successful output and keeps quotes, substitutions, newlines, and percent signs literal", async () => {
    const dangerous = "quote ' `touch /escaped` $HOME 100%\n" + "x".repeat(12_000);
    const d = await processCodexPreToolUse(
      toolInput("cat ~/.memoree/memory/index.md"),
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => dangerous) as any,
      },
    );

    expect(d.action).toBe("allow");
    expect(Buffer.byteLength(d.output ?? "", "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(d.output).toContain("quote ' `touch /escaped` $HOME 100%");
    expect(d.output).toContain("truncated");
    expect(d.replacementCommand).not.toContain(".memoree/memory");
    expect(d.replacementCommand).not.toContain("cat ~/.memoree");

    const replacement = await new Bash().exec(d.replacementCommand!);
    expect(replacement.exitCode).toBe(0);
    expect(replacement.stderr).toBe("");
    expect(replacement.stdout).toBe(`${d.output}\n`);
  });

  it("the compiled fallback callback cache-hits /index.md without re-querying the sessions table", async () => {
    const readCachedIndexContentFn = vi.fn(() => "CACHED INDEX");
    const readVirtualPathContentsFn = vi.fn(async (_api, _m, _s, paths: string[]) =>
      new Map<string, string | null>(paths.map((p) => [p, `FETCHED:${p}`])),
    ) as any;
    // Bash compiler asks for both /index.md and /sessions/x.json; only
    // /sessions/x.json must reach the SQL layer.
    const executeCompiledBashCommandFn = vi.fn(async (_api, _m, _s, _cmd, deps) => {
      const fetched = await deps.readVirtualPathContentsFn(_api, _m, _s, ["/index.md", "/sessions/x.json"]);
      return `idx=${fetched.get("/index.md")};x=${fetched.get("/sessions/x.json")}`;
    }) as any;

    const d = await processCodexPreToolUse(
      toolInput("cat ~/.memoree/memory/index.md && cat ~/.memoree/memory/sessions/x.json", { session_id: "sess-A" }),
      {
        ...baseDeps({ readCachedIndexContentFn, readVirtualPathContentsFn }),
        executeCompiledBashCommandFn,
      },
    );
    expect(d.output).toContain("idx=CACHED INDEX");
    expect(d.output).toContain("x=FETCHED:/sessions/x.json");
    // Cache read was issued; the SQL read only fetched the non-cached path.
    expect(readCachedIndexContentFn).toHaveBeenCalledWith("sess-A");
    expect(readVirtualPathContentsFn).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(),
      ["/sessions/x.json"],
    );
  });
});

describe("processCodexPreToolUse: direct read (cat/head/tail/wc)", () => {
  it("cat <file> returns raw content", async () => {
    const d = await processCodexPreToolUse(
      toolInput("cat ~/.memoree/memory/sessions/a.json"),
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () => "line1\nline2\nline3") as any,
      },
    );
    expect(d.output).toBe("line1\nline2\nline3");
  });

  it("head -N <file> slices to the first N lines", async () => {
    const d = await processCodexPreToolUse(
      toolInput("head -2 ~/.memoree/memory/sessions/a.json"),
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () => "l1\nl2\nl3\nl4") as any,
      },
    );
    expect(d.output).toBe("l1\nl2");
  });

  it("head <file> (no -N) defaults to 10 lines", async () => {
    const d = await processCodexPreToolUse(
      toolInput("head ~/.memoree/memory/sessions/a.json"),
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () =>
          Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n"),
        ) as any,
      },
    );
    expect(d.output).toBe(Array.from({ length: 10 }, (_, i) => `L${i}`).join("\n"));
  });

  it("tail -N <file> slices to the last N lines", async () => {
    const d = await processCodexPreToolUse(
      toolInput("tail -2 ~/.memoree/memory/sessions/a.json"),
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () => "l1\nl2\nl3\nl4") as any,
      },
    );
    expect(d.output).toBe("l3\nl4");
  });

  it("tail <file> defaults to the last 10 lines", async () => {
    const d = await processCodexPreToolUse(
      toolInput("tail ~/.memoree/memory/sessions/a.json"),
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () =>
          Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n"),
        ) as any,
      },
    );
    expect(d.output).toBe(Array.from({ length: 10 }, (_, i) => `L${i + 10}`).join("\n"));
  });

  it("wc -l <file> returns `<count> <virtualPath>`", async () => {
    const d = await processCodexPreToolUse(
      toolInput("wc -l ~/.memoree/memory/sessions/a.json"),
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () => "a\nb\nc") as any,
      },
    );
    expect(d.output).toBe("3 /sessions/a.json");
  });

  it("cat | head pipeline collapses to a single head read", async () => {
    const d = await processCodexPreToolUse(
      toolInput("cat ~/.memoree/memory/sessions/a.json | head -3"),
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () =>
          Array.from({ length: 30 }, (_, i) => `L${i}`).join("\n"),
        ) as any,
      },
    );
    expect(d.output).toBe("L0\nL1\nL2");
  });
});

describe("processCodexPreToolUse: /index.md caching + fallback", () => {
  it("serves /index.md from the session cache when present — no virtual-path fetch", async () => {
    const readCachedIndexContentFn = vi.fn(() => "CACHED-BODY");
    const readVirtualPathContentFn = vi.fn(async () => "FRESH") as any;
    const d = await processCodexPreToolUse(
      toolInput("cat ~/.memoree/memory/index.md", { session_id: "s-cache" }),
      {
        ...baseDeps({ readCachedIndexContentFn, readVirtualPathContentFn }),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d.output).toBe("CACHED-BODY");
    expect(readVirtualPathContentFn).not.toHaveBeenCalled();
  });

  it("on cache miss fetches /index.md via readVirtualPathContent + writes it into the cache", async () => {
    const writeCachedIndexContentFn = vi.fn();
    const d = await processCodexPreToolUse(
      toolInput("cat ~/.memoree/memory/index.md", { session_id: "s-miss" }),
      {
        ...baseDeps({ writeCachedIndexContentFn }),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () => "FRESH INDEX") as any,
      },
    );
    expect(d.output).toBe("FRESH INDEX");
    expect(writeCachedIndexContentFn).toHaveBeenCalledWith("s-miss", "FRESH INDEX");
  });

  it("falls back to the inline memory-table SELECT when readVirtualPathContent returns null for /index.md", async () => {
    // Simulates a table where memory has rows but the path isn't in the
    // exact-path union. Codex's fallback builder queries /summaries/%.
    const api = makeApi([
      { path: "/summaries/a/s1.md", project: "proj", description: "desc", creation_date: "2026-04-20" },
      { path: "/summaries/a/s2.md", project: "", description: "", creation_date: "2026-04-19" },
    ]);
    const d = await processCodexPreToolUse(
      toolInput("cat ~/.memoree/memory/index.md"),
      {
        ...baseDeps({ createApi: vi.fn(() => api) }),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () => null) as any,
      },
    );
    expect(d.output).toContain("# Memory Index");
    expect(d.output).toContain("2 sessions:");
    expect(d.output).toContain("/summaries/a/s1.md");
    expect(d.output).toContain("[proj]");
  });
});

describe("processCodexPreToolUse: ls branch", () => {
  it("short-format listing renders file vs dir entries + empty-name rows are skipped", async () => {
    const listVirtualPathRowsFn = vi.fn(async () => [
      { path: "/summaries/top.md", size_bytes: 10 },       // file directly under /summaries
      { path: "/summaries/alice/s1.md", size_bytes: 42 },  // nested → alice becomes a dir
      { path: "/summaries/", size_bytes: 0 },               // trailing slash — skipped
    ]) as any;

    const d = await processCodexPreToolUse(
      toolInput("ls ~/.memoree/memory/summaries"),
      {
        ...baseDeps({ listVirtualPathRowsFn }),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d.output).toContain("top.md");
    expect(d.output).toContain("alice/");
    expect(d.output!.split("\n").filter(l => l).length).toBe(2);
  });

  it("long-format listing includes permission strings and sizes", async () => {
    const d = await processCodexPreToolUse(
      toolInput("ls -la ~/.memoree/memory/summaries"),
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        listVirtualPathRowsFn: vi.fn(async () => [
          { path: "/summaries/top.md", size_bytes: 42 },
          { path: "/summaries/alice/s1.md", size_bytes: 100 },
        ]) as any,
      },
    );
    expect(d.output).toContain("-rw-r--r--");
    expect(d.output).toContain("top.md");
    expect(d.output).toContain("drwxr-xr-x");
    expect(d.output).toContain("alice/");
  });

  it("ls on an empty or non-existent directory returns a 'cannot access' message", async () => {
    const d = await processCodexPreToolUse(
      toolInput("ls ~/.memoree/memory/nope"),
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        listVirtualPathRowsFn: vi.fn(async () => []) as any,
      },
    );
    expect(d.output).toContain("cannot access");
    expect(d.output).toContain("No such file or directory");
  });
});

describe("processCodexPreToolUse: find + grep + fallback", () => {
  it("find <dir> -name '<pat>' returns matching paths joined with newlines", async () => {
    const findVirtualPathsFn = vi.fn(async () => [
      "/sessions/conv_0_session_1.json",
      "/sessions/conv_0_session_2.json",
    ]) as any;

    const d = await processCodexPreToolUse(
      toolInput("find ~/.memoree/memory/sessions -name '*.json'"),
      {
        ...baseDeps({ findVirtualPathsFn }),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d.output).toBe("/sessions/conv_0_session_1.json\n/sessions/conv_0_session_2.json");
  });

  it("find … | wc -l collapses to the count", async () => {
    const d = await processCodexPreToolUse(
      toolInput("find ~/.memoree/memory/sessions -name '*.json' | wc -l"),
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        findVirtualPathsFn: vi.fn(async () => ["/a", "/b", "/c"]) as any,
      },
    );
    expect(d.output).toBe("3");
  });

  it("find with zero matches returns '(no matches)'", async () => {
    const d = await processCodexPreToolUse(
      toolInput("find ~/.memoree/memory/sessions -name '*.xyz'"),
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        findVirtualPathsFn: vi.fn(async () => []) as any,
      },
    );
    expect(d.output).toBe("(no matches)");
  });

  it("grep via parseBashGrep delegates to handleGrepDirect", async () => {
    const handleGrepDirectFn = vi.fn(async () => "/sessions/a.json:matching line") as any;
    const d = await processCodexPreToolUse(
      toolInput("grep -l foo ~/.memoree/memory/sessions/*.json"),
      {
        ...baseDeps({ handleGrepDirectFn }),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
      },
    );
    expect(d.output).toBe("/sessions/a.json:matching line");
    expect(handleGrepDirectFn).toHaveBeenCalled();
  });

  it("turns a direct-query exception into an ordinary nonzero command failure", async () => {
    const d = await processCodexPreToolUse(
      toolInput("cat ~/.memoree/memory/sessions/a.json"),
      {
        ...baseDeps(),
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () => { throw new Error("network bonk"); }) as any,
      },
    );
    expect(d.action).toBe("allow");
    expect(d.output).toContain("network bonk");
    expect(d.replacementCommand).toContain("exit 1");
  });
});

describe("processCodexPreToolUse: memory write redirect (F3 — no double execution)", () => {
  const writeCmd = "echo 'hello' > ~/.memoree/memory/h2h/relay-codex.md";

  function writeDeps(extra: Record<string, any> = {}) {
    return {
      ...baseDeps(extra),
      // Writes are not compiled reads — force the inline fast-path to miss so the
      // command reaches the VFS-shell fallback (the real production behavior).
      executeCompiledBashCommandFn: vi.fn(async () => null) as any,
    };
  }

  it.each([
    "echo 'hello' > ~/.memoree/memory/h2h/echo.md",
    "printf '%s' 'hello' > ~/.memoree/memory/h2h/printf.md",
    "printf '%s' 'hello' | tee ~/.memoree/memory/h2h/tee.md",
  ])("handles a curated sandboxed write without exposing the original command: %s", async (command) => {
    const runVfsShellFn = vi.fn(() => ({ status: 0, stdout: "written", stderr: "" }));
    const d = await processCodexPreToolUse(toolInput(command), writeDeps({ runVfsShellFn }));

    expect(d.action).toBe("allow");
    expect(d.replacementCommand).toBe("printf '%s\\n' 'written'");
    expect(d.replacementCommand).not.toContain(".memoree/memory");
    expect(d.replacementCommand).not.toContain("h2h/");
  });

  it("a successful VFS write returns action=allow with a rewritten host command, NOT guide/pass", async () => {
    const runVfsShellFn = vi.fn(() => ({ status: 0, stdout: "(done)", stderr: "" }));
    const d = await processCodexPreToolUse(toolInput(writeCmd), writeDeps({ runVfsShellFn }));

    // allow ⇒ main() emits permissionDecision:allow + updatedInput so Codex runs
    // the REPLACEMENT, not the original. pass/guide would let the original redirect
    // re-run on the host (the F3 "No such file or directory" double execution).
    expect(d.action).toBe("allow");
    expect(d.action).not.toBe("pass");
    expect(runVfsShellFn).toHaveBeenCalledTimes(1);
  });

  it("the replacement command echoes the VFS result and never re-runs the original redirect", async () => {
    const runVfsShellFn = vi.fn(() => ({ status: 0, stdout: "(done)", stderr: "" }));
    const d = await processCodexPreToolUse(toolInput(writeCmd), writeDeps({ runVfsShellFn }));

    expect(d.replacementCommand).toBe("printf '%s\\n' '(done)'");
    // Negative assertions: the host must NOT re-execute the write. The rewrite
    // must contain neither a redirect operator nor the memory path.
    expect(d.replacementCommand).not.toMatch(/>/);
    expect(d.replacementCommand).not.toContain(".memoree/memory");
  });

  it("POSIX-escapes single quotes in the VFS output so it can't break out of the rewrite", async () => {
    const runVfsShellFn = vi.fn(() => ({ status: 0, stdout: "it's done", stderr: "" }));
    const d = await processCodexPreToolUse(toolInput(writeCmd), writeDeps({ runVfsShellFn }));

    expect(d.action).toBe("allow");
    expect(d.replacementCommand).toBe(`printf '%s\\n' 'it'\\''s done'`);
  });

  it("treats a no-space redirect (echo foo>file) as a write → allow, not block", async () => {
    // CodeRabbit #284: `/\s>>?\s/` missed `echo foo>file`, misrouting it to block
    // and re-surfacing the F3 "write looks failed" symptom. The relaxed guard
    // must recognize the redirect regardless of surrounding whitespace.
    const runVfsShellFn = vi.fn(() => ({ status: 0, stdout: "(done)", stderr: "" }));
    const d = await processCodexPreToolUse(
      toolInput("echo 'hello'>~/.memoree/memory/h2h/relay-codex.md"),
      writeDeps({ runVfsShellFn }),
    );
    expect(d.action).toBe("allow");
    expect(d.replacementCommand).toBe("printf '%s\\n' '(done)'");
  });

  it("keeps an fd redirect inside the sandbox and replaces it with harmless output", async () => {
    const runVfsShellFn = vi.fn(() => ({ status: 0, stdout: "x", stderr: "" }));
    const d = await processCodexPreToolUse(
      toolInput("echo hello 2>~/.memoree/memory/h2h/err.md"),
      writeDeps({ runVfsShellFn }),
    );
    expect(d.action).toBe("allow");
    expect(d.replacementCommand).toBe("printf '%s\\n' 'x'");
    expect(d.replacementCommand).not.toContain(">");
  });

  it("preserves a VFS-shell error as an ordinary nonzero command failure", async () => {
    const runVfsShellFn = vi.fn(() => ({ status: 4, stdout: "", stderr: "jq: parse error\n" }));
    const d = await processCodexPreToolUse(
      toolInput("cat ~/.memoree/memory/malformed.json | jq '.items | length'"),
      writeDeps({ runVfsShellFn }),
    );

    expect(d.action).toBe("allow");
    expect(d.output).toBe("jq: parse error\n");
    expect(d.replacementCommand).toContain("jq: parse error\n");
    expect(d.replacementCommand).toContain(">&2");
    expect(d.replacementCommand).toContain("exit 4");
    expect(d.replacementCommand).not.toContain("denied");

    const replacement = await new Bash().exec(d.replacementCommand!);
    expect(replacement.stdout).toBe("");
    expect(replacement.stderr).toBe("jq: parse error\n");
    expect(replacement.exitCode).toBe(4);
  });
});

describe("processCodexPreToolUse: ls / find variants + fallback branches", () => {
  const noCompiled = () => ({ executeCompiledBashCommandFn: vi.fn(async () => null) as any });

  it("ls -l lists files and subdirs in long format, skipping rows outside the dir", async () => {
    const listVirtualPathRowsFn = vi.fn(async () => [
      { path: "/sessions/a.json", size_bytes: 42 },
      { path: "/sessions/sub/b.json", size_bytes: 10 }, // nested → directory entry
      { path: "/other/z.json", size_bytes: 5 },          // outside /sessions → skipped
    ]) as any;
    const d = await processCodexPreToolUse(
      toolInput("ls -l ~/.memoree/memory/sessions"),
      { ...baseDeps({ listVirtualPathRowsFn }), ...noCompiled() },
    );
    expect(d.action).toBe("allow");
    expect(d.output).toContain("a.json");
    expect(d.output).toContain("sub/");      // nested path collapses to a dir entry
    expect(d.output).toMatch(/drwx/);        // long-format directory line
    expect(d.output).toMatch(/-rw/);         // long-format file line
    expect(d.output).not.toContain("z.json"); // row outside the prefix is dropped
  });

  it("ls / (mount root) lists top-level entries", async () => {
    const listVirtualPathRowsFn = vi.fn(async () => [
      { path: "/sessions/a.json", size_bytes: 1 },
      { path: "/index.md", size_bytes: 2 },
    ]) as any;
    const d = await processCodexPreToolUse(
      toolInput("ls ~/.memoree/memory"),
      { ...baseDeps({ listVirtualPathRowsFn }), ...noCompiled() },
    );
    expect(d.action).toBe("allow");
    expect(d.output).toContain("sessions/");
    expect(d.output).toContain("index.md");
  });

  it("ls on an unknown dir returns 'cannot access'", async () => {
    const d = await processCodexPreToolUse(
      toolInput("ls ~/.memoree/memory/nope"),
      { ...baseDeps({ listVirtualPathRowsFn: vi.fn(async () => []) as any }), ...noCompiled() },
    );
    expect(d.action).toBe("allow");
    expect(d.output).toContain("cannot access");
  });

  it("find -name with a double-quoted pattern resolves matches", async () => {
    const d = await processCodexPreToolUse(
      toolInput('find ~/.memoree/memory/sessions -name "*.md"'),
      { ...baseDeps({ findVirtualPathsFn: vi.fn(async () => ["/sessions/a.md"]) as any }), ...noCompiled() },
    );
    expect(d.output).toBe("/sessions/a.md");
  });

  it("find -name with an unquoted pattern resolves matches", async () => {
    const d = await processCodexPreToolUse(
      toolInput("find ~/.memoree/memory/sessions -name *.md"),
      { ...baseDeps({ findVirtualPathsFn: vi.fn(async () => ["/sessions/b.md"]) as any }), ...noCompiled() },
    );
    expect(d.output).toBe("/sessions/b.md");
  });

  it("find rooted at the mount (/) normalizes the dir argument to '/'", async () => {
    const findVirtualPathsFn = vi.fn(async () => ["/x.json"]) as any;
    const d = await processCodexPreToolUse(
      toolInput("find ~/.memoree/memory -name '*.json'"),
      { ...baseDeps({ findVirtualPathsFn }), ...noCompiled() },
    );
    expect(d.output).toBe("/x.json");
    expect(findVirtualPathsFn).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), "/", expect.anything(),
    );
  });

  it("a non-redirect command handled by the VFS shell returns successful output", async () => {
    const runVfsShellFn = vi.fn(() => ({ status: 0, stdout: "echoed", stderr: "" }));
    const d = await processCodexPreToolUse(
      toolInput("echo hello ~/.memoree/memory/note.txt"),
      { ...baseDeps(), ...noCompiled(), runVfsShellFn },
    );
    expect(d.action).toBe("allow");
    expect(d.output).toBe("echoed");
    expect(d.replacementCommand).toBe("printf '%s\\n' 'echoed'");
  });

  it("a nonzero write preserves stdout but still exits nonzero", async () => {
    const runVfsShellFn = vi.fn(() => ({ status: 1, stdout: "still wrote", stderr: "write failed\n" }));
    const d = await processCodexPreToolUse(
      toolInput("echo 'x' > ~/.memoree/memory/h2h/a.md"),
      { ...baseDeps(), ...noCompiled(), runVfsShellFn },
    );
    expect(d.action).toBe("allow");
    expect(d.replacementCommand).toContain("printf '%s' 'still wrote'");
    expect(d.replacementCommand).toContain("write failed\n");
    expect(d.replacementCommand).toContain("exit 1");
  });

  it("a write with empty stdout defaults the echoed result to (done)", async () => {
    const runVfsShellFn = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const d = await processCodexPreToolUse(
      toolInput("echo 'x' > ~/.memoree/memory/h2h/a.md"),
      { ...baseDeps(), ...noCompiled(), runVfsShellFn },
    );
    expect(d.action).toBe("allow");
    expect(d.replacementCommand).toBe("printf '%s\\n' '(done)'");
  });

  it("a /graph read is answered as successful output before any SQL", async () => {
    const tryGraphReadFn = vi.fn(() => "GRAPH SNAPSHOT BODY") as any;
    const executeCompiledBashCommandFn = vi.fn(async () => "SHOULD-NOT-RUN") as any;
    const d = await processCodexPreToolUse(
      toolInput("cat ~/.memoree/memory/graph/index.md"),
      { ...baseDeps({ tryGraphReadFn }), executeCompiledBashCommandFn },
    );
    expect(d.action).toBe("allow");
    expect(d.output).toBe("GRAPH SNAPSHOT BODY");
    expect(executeCompiledBashCommandFn).not.toHaveBeenCalled(); // graph short-circuits before SQL
  });

  it("ls /docs renders the docs root index (not the memory listing), project-scoped", async () => {
    const calls: string[] = [];
    const api = { query: vi.fn(async (sql: string) => { calls.push(sql); return []; }) } as any;
    const d = await processCodexPreToolUse(
      toolInput("ls ~/.memoree/memory/docs") as any,
      baseDeps({ createApi: vi.fn(() => api), config: { ...BASE_CONFIG, docsTableName: "memoree_docs" } as any }),
    );
    expect(d.action).toBe("allow");
    expect(d.output).toContain("Docs Index");
    expect(calls.some((c) => /memoree_docs/.test(c))).toBe(true); // docs table, not memory
  });

  it("a cat of /docs/find is answered from the docs table, PROJECT-SCOPED to the cwd repo", async () => {
    const calls: string[] = [];
    const api = { query: vi.fn(async (sql: string) => { calls.push(sql); return [{ path: "src/a.ts", content: "# a" }]; }) } as any;
    const d = await processCodexPreToolUse(
      toolInput("cat ~/.memoree/memory/docs/find/auth") as any,
      baseDeps({ createApi: vi.fn(() => api), config: { ...BASE_CONFIG, docsTableName: "memoree_docs" } as any }),
    );
    expect(d.action).toBe("allow");
    expect(d.output).toContain("src/a.ts");
    // Shared-table safety: the search filters to this repo's project key,
    // keeping legacy unstamped rows ('') visible.
    expect(calls.some((c) => /\(project = '[0-9a-f]{16}' OR project = ''\)/.test(c))).toBe(true);
  });

  it("resolves a read using the DEFAULT createApi + log deps (no injection)", async () => {
    // Omit createApi / logFn / cache deps so their default values run: the default
    // createApi constructs a MemoreeApi (no network at construction) and the
    // module-level `log` executes. The injected read fn keeps it off the network.
    const d = await processCodexPreToolUse(
      toolInput("cat ~/.memoree/memory/sessions/a.json"),
      {
        config: BASE_CONFIG as any,
        executeCompiledBashCommandFn: vi.fn(async () => null) as any,
        readVirtualPathContentFn: vi.fn(async () => "DEFAULT-DEPS-CONTENT") as any,
      },
    );
    expect(d.action).toBe("allow");
    expect(d.output).toBe("DEFAULT-DEPS-CONTENT");
  });
});
