import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the subprocess boundary so the test never shells out to a real CLI.
const execFileSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

import { detectHostAgent, makeClaudeGenerate, resolveDocLlmSpec, unwrapModelOutput } from "../../src/docs/refresh-llm.js";
import type { RefreshContext } from "../../src/docs/index.js";

const ctx: RefreshContext = {
  doc: {
    id: "r", doc_id: "a.ts", path: "/docs/p/a.ts.md", content: "old doc",
    anchors: [], tier: "fast", status: "active", project: "p", version: 1,
    created_at: "t", updated_at: "t", agent: "m", plugin_version: "0",
  },
  reasons: [{ kind: "code_changed", symbol_id: "a.ts:foo:function" }],
  changedSymbols: [{ symbol_id: "a.ts:foo:function", signature: "function foo(): number", source: "function foo() { return 42; }" }],
};

beforeEach(() => execFileSyncMock.mockReset());

describe("resolveDocLlmSpec (per-agent LLM seam)", () => {
  it("defaults to claude — `-p` with the prompt on STDIN, never argv (E2BIG)", () => {
    const spec = resolveDocLlmSpec({});
    expect(spec.label).toBe("claude");
    expect(spec.bin).toBe("claude");
    const inv = spec.build("/usr/bin/claude", "PROMPT");
    expect(inv.file).toBe("/usr/bin/claude");
    expect(inv.args[0]).toBe("-p");
    expect(inv.args).not.toContain("PROMPT");
    expect(inv.options.input).toBe("PROMPT");
  });

  it("MEMOREE_DOCS_LLM_AGENT=codex → `codex exec … -` with the prompt on STDIN, LOW reasoning effort", () => {
    const spec = resolveDocLlmSpec({ MEMOREE_DOCS_LLM_AGENT: "codex" });
    expect(spec.bin).toBe("codex");
    const inv = spec.build("/usr/bin/codex", "PROMPT");
    // Cost pinning: reasoning effort is the account-safe knob (ChatGPT
    // accounts reject cheap model slugs with a 400).
    expect(inv.args).toEqual([
      "exec", "--dangerously-bypass-approvals-and-sandbox",
      "-c", 'model_reasoning_effort="low"', "-",
    ]);
    expect(inv.options.input).toBe("PROMPT");
  });

  it("MEMOREE_DOCS_CODEX_MODEL adds an explicit -m for API-key accounts", () => {
    const spec = resolveDocLlmSpec({ MEMOREE_DOCS_LLM_AGENT: "codex", MEMOREE_DOCS_CODEX_MODEL: "gpt-cheap" });
    const inv = spec.build("/usr/bin/codex", "PROMPT");
    expect(inv.args).toContain("-m");
    expect(inv.args[inv.args.indexOf("-m") + 1]).toBe("gpt-cheap");
    expect(inv.args[inv.args.length - 1]).toBe("-"); // stdin marker stays last
  });

  it("MEMOREE_DOCS_LLM_BIN (+FLAGS) → a fully custom CLI, prompt as the last arg", () => {
    const spec = resolveDocLlmSpec({ MEMOREE_DOCS_LLM_BIN: "my-llm", MEMOREE_DOCS_LLM_FLAGS: "run,--json" });
    expect(spec.bin).toBe("my-llm");
    const inv = spec.build("my-llm", "PROMPT");
    expect(inv.args).toEqual(["run", "--json", "PROMPT"]);
  });

  it("MEMOREE_DOCS_LLM_STDIN=1 routes the custom CLI's prompt via stdin (E2BIG safety)", () => {
    const spec = resolveDocLlmSpec({ MEMOREE_DOCS_LLM_BIN: "my-llm", MEMOREE_DOCS_LLM_FLAGS: "run", MEMOREE_DOCS_LLM_STDIN: "1" });
    const inv = spec.build("my-llm", "PROMPT");
    expect(inv.args).toEqual(["run"]); // no prompt in argv
    expect(inv.options.input).toBe("PROMPT");
  });

  it("auto-detects the host agent from installed CLIs, stdin-safe first, fail-loud on none", () => {
    expect(detectHostAgent((b) => (b === "codex" ? "/bin/codex" : null))).toBe("codex");
    expect(detectHostAgent((b) => (b === "claude" || b === "codex" ? `/bin/${b}` : null))).toBe("claude");
    expect(() => detectHostAgent(() => null)).toThrow(/No host agent CLI found/);
  });

  it("the custom escape hatch beats a named agent when both are set", () => {
    const spec = resolveDocLlmSpec({ MEMOREE_DOCS_LLM_BIN: "x", MEMOREE_DOCS_LLM_AGENT: "codex" });
    expect(spec.label).toBe("custom:x");
  });

  it("throws a helpful error on an unknown agent", () => {
    expect(() => resolveDocLlmSpec({ MEMOREE_DOCS_LLM_AGENT: "gpt5" })).toThrow(/Unknown MEMOREE_DOCS_LLM_AGENT="gpt5"/);
  });
});

describe("makeClaudeGenerate", () => {
  it("returns the model's stdout, trimmed", async () => {
    execFileSyncMock.mockReturnValue("  # Updated doc\nbody\n\n");
    const gen = makeClaudeGenerate("/usr/bin/claude");
    const out = await gen(ctx);
    expect(out).toBe("# Updated doc\nbody");
  });

  it("passes the refresh prompt to the claude binary over STDIN", async () => {
    execFileSyncMock.mockReturnValue("x");
    const gen = makeClaudeGenerate("/usr/bin/claude");
    await gen(ctx);
    expect(execFileSyncMock).toHaveBeenCalledOnce();
    const [file, args, options] = execFileSyncMock.mock.calls[0] as [string, string[], { input?: string }];
    expect(file).toBe("/usr/bin/claude");
    // The prompt (with the changed symbol source) must ride stdin, never argv,
    // so multi-hundred-KB source files cannot blow the OS arg limit (E2BIG).
    expect(args.join(" ")).not.toContain("function foo()");
    expect(options.input).toContain("function foo() { return 42; }");
    expect(options.input).toContain("SMALLEST edit");
  });

  it("tolerates empty/undefined stdout", async () => {
    execFileSyncMock.mockReturnValue(undefined);
    const gen = makeClaudeGenerate("/usr/bin/claude");
    expect(await gen(ctx)).toBe("");
  });

  it("unwraps an outer code fence the model may add around the whole body", async () => {
    execFileSyncMock.mockReturnValue("```markdown\n# Doc\nbody\n```");
    const gen = makeClaudeGenerate("/usr/bin/claude");
    expect(await gen(ctx)).toBe("# Doc\nbody");
  });
});

describe("unwrapModelOutput", () => {
  it("strips a single outer fence with a language tag", () => {
    expect(unwrapModelOutput("```md\nhello\nworld\n```")).toBe("hello\nworld");
  });
  it("strips a bare outer fence", () => {
    expect(unwrapModelOutput("```\nhello\n```")).toBe("hello");
  });
  it("leaves un-fenced content (just trims)", () => {
    expect(unwrapModelOutput("  # Title\nbody  ")).toBe("# Title\nbody");
  });
  it("does NOT strip inner/partial fences in normal markdown", () => {
    const md = "# Doc\n\n```ts\nconst x = 1;\n```\n\nmore";
    expect(unwrapModelOutput(md)).toBe(md);
  });
});
