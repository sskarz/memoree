import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeMcpStdio,
  assertAgentResponseContainsIdentifier,
  authenticatedClaudeEnvironment,
  classifyAgentCommandError,
  claudeLiveCliArgs,
  copyCodexAuthentication,
  createValidationWorkspace,
  hookBodyContains,
  hookUpdatedInput,
  linkSharedEmbeddingRuntime,
  isolatedCounts,
  lexicalValidationPrompt,
  claudeLexicalRecallPrompt,
  CLAUDE_LEXICAL_RECALL_ATTEMPTS,
  CODEX_SEMANTIC_RECALL_ATTEMPTS,
  DEFAULT_LIVE_CLAUDE_MODEL,
  DEFAULT_LIVE_CODEX_MODEL,
  DEFAULT_LIVE_CODEX_REASONING_EFFORT,
  liveClaudeModel,
  liveCodexModel,
  liveCodexReasoningEffort,
  codexExecLiveArgs,
  codexSemanticRecallPrompt,
  skipLiveCodexRequested,
  skipLiveAntigravityRequested,
  writeIsolatedAntigravityGeminiSettings,
  parseMcpFramedMessages,
  antigravityLivePrompt,
  assertAntigravityLiveUsedMcp,
  waitForCapture,
} from "../../scripts/runtime-validate.mjs";
import { redactSecrets } from "../../src/hooks/shared/redact.js";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function createValidationDatabase(): { databasePath: string; db: DatabaseSync } {
  root = mkdtempSync(join(tmpdir(), "runtime-validate-test-"));
  const databasePath = join(root, "memoree.sqlite3");
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE sessions (message TEXT); CREATE TABLE memory (path TEXT, summary TEXT);");
  return { databasePath, db };
}

describe("runtime validation polling", () => {
  it("requires the requested fact to appear in a summary, not merely any summary", async () => {
    const { databasePath, db } = createValidationDatabase();
    db.prepare("INSERT INTO sessions (message) VALUES (?)").run("fact-123");
    db.prepare("INSERT INTO memory (path, summary) VALUES (?, ?)").run(
      "/summaries/test/unrelated.md",
      "an unrelated summary",
    );
    db.close();

    expect(isolatedCounts(databasePath, "fact-123")).toEqual({
      matchingEvents: 1,
      summaries: 1,
      matchingSummaries: 0,
    });
    await expect(waitForCapture(databasePath, "fact-123", {
      requireSummary: true,
      timeoutMs: 10,
      pollMs: 1,
    })).rejects.toThrow(/matchingSummaries=0/);
  });

  it("returns after both the event and matching summary are present", async () => {
    const { databasePath, db } = createValidationDatabase();
    db.prepare("INSERT INTO sessions (message) VALUES (?)").run("fact-456");
    db.prepare("INSERT INTO memory (path, summary) VALUES (?, ?)").run(
      "/summaries/test/matching.md",
      "the remembered value is fact-456",
    );
    db.close();

    await expect(waitForCapture(databasePath, "fact-456", {
      requireSummary: true,
      timeoutMs: 100,
      pollMs: 1,
    })).resolves.toEqual({
      matchingEvents: 1,
      summaries: 1,
      matchingSummaries: 1,
    });
  });

  it("accepts a summary that preserves the exact identifier while paraphrasing the fact", async () => {
    const { databasePath, db } = createValidationDatabase();
    const identifier = "a912d384-5605-43ab-bae7-e34b50e6f81a";
    db.prepare("INSERT INTO sessions (message) VALUES (?)").run(
      `the observatory lantern is ${identifier}`,
    );
    db.prepare("INSERT INTO memory (path, summary) VALUES (?, ?)").run(
      "/summaries/test/paraphrased.md",
      `The exact identifier recorded for the observatory lantern was ${identifier}.`,
    );
    db.close();

    await expect(waitForCapture(databasePath, identifier, {
      requireSummary: true,
      timeoutMs: 100,
      pollMs: 1,
    })).resolves.toEqual({
      matchingEvents: 1,
      summaries: 1,
      matchingSummaries: 1,
    });
  });
});

describe("runtime validation Claude configuration", () => {
  it("uses the authenticated HOME and suppresses nonessential profile writes", () => {
    expect(authenticatedClaudeEnvironment({ MEMOREE_SQLITE_PATH: "/tmp/test.sqlite3" }, "/Users/tester"))
      .toMatchObject({
        HOME: "/Users/tester",
        MEMOREE_SQLITE_PATH: "/tmp/test.sqlite3",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      });
  });

  it("removes the disposable config override for a default Claude profile", () => {
    const env = authenticatedClaudeEnvironment({
      HOME: "/tmp/disposable",
      CLAUDE_CONFIG_DIR: "/tmp/disposable/.claude",
    }, "/Users/tester");
    expect(env.HOME).toBe("/Users/tester");
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("preserves an explicitly configured authenticated Claude profile", () => {
    const env = authenticatedClaudeEnvironment({}, "/Users/tester", "/custom/claude");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/custom/claude");
  });
});

describe("runtime validation workspace isolation", () => {
  it("creates the disposable workspace under the real home cache, not /tmp", () => {
    root = mkdtempSync(join(tmpdir(), "runtime-validate-home-"));
    const workspace = createValidationWorkspace(root);
    expect(workspace.startsWith(join(root, ".cache", "memoree-runtime-validate-"))).toBe(true);
    expect(workspace.includes("/tmp/memoree-runtime-validate-")).toBe(false);
  });
});

describe("runtime validation Codex isolation", () => {
  it("copies only auth material into a clean Codex profile", () => {
    root = mkdtempSync(join(tmpdir(), "runtime-validate-auth-"));
    const realHome = join(root, "real");
    const isolated = join(root, "isolated", ".codex");
    mkdirSync(join(realHome, ".codex"), { recursive: true });
    writeFileSync(join(realHome, ".codex", "auth.json"), "{\"token\":\"test\"}\n");
    writeFileSync(join(realHome, ".codex", "config.toml"), "approval = 'saved'\n");
    copyCodexAuthentication(realHome, isolated);
    expect(readFileSync(join(isolated, "auth.json"), "utf8")).toContain("test");
    expect(existsSync(join(isolated, "config.toml"))).toBe(false);
  });
});

describe("runtime validation lexical marker", () => {
  it("survives capture redaction as an exact searchable identifier", () => {
    const identifier = "3b4aa504-2da6-4ad1-995b-293f1254d6c3";
    const prompt = lexicalValidationPrompt(identifier);
    expect(redactSecrets(prompt)).toBe(prompt);
    expect(prompt).toContain(identifier);
    expect(redactSecrets(`${prompt}.`)).toContain(identifier);
  });

  it("guards against the secret-like token label used by the failed validator", () => {
    const identifier = "3b4aa504-2da6-4ad1-995b-293f1254d6c3";
    expect(redactSecrets(`Repeat this exact lexical fallback token: memoree-lexical-${identifier}`))
      .not.toContain(identifier);
  });
});

describe("runtime validation Codex semantic recall prompt", () => {
  it("tells Codex to grep the whole Memoree mount instead of answering from the user message", () => {
    const prompt = codexSemanticRecallPrompt();
    expect(prompt).toContain("grep -ri");
    expect(prompt).toContain('grep -ri "observatory lantern" ~/.memoree/memory/');
    expect(prompt).not.toContain("summaries/");
    expect(prompt).toContain("observatory lantern");
    expect(prompt).toContain("NONE");
    expect(prompt).toMatch(/do not generate a uuid/i);
    expect(prompt).not.toMatch(/do not say none/i);
    expect(prompt).not.toMatch(/do not (read files|use tools)/i);
  });

  it("runs cheap Codex semantic recall with unaided-e2e hooks, not --ephemeral", () => {
    const source = readFileSync(new URL("../../scripts/runtime-validate.mjs", import.meta.url), "utf8");
    const recallBlock = source.slice(
      source.indexOf("checking semantic recall through Codex"),
      source.indexOf("running an authenticated Codex capture turn"),
    );
    expect(recallBlock).toContain("--dangerously-bypass-hook-trust");
    expect(recallBlock).toContain("codexSemanticRecallPrompt(");
    expect(recallBlock).not.toMatch(/["']--ephemeral["']/);
  });

  it("retries cheap-model Codex semantic recall", () => {
    expect(CODEX_SEMANTIC_RECALL_ATTEMPTS).toBe(5);
    const source = readFileSync(new URL("../../scripts/runtime-validate.mjs", import.meta.url), "utf8");
    expect(source).toContain("CODEX_SEMANTIC_RECALL_ATTEMPTS");
    expect(source).toContain("codexSemanticRecallPrompt(");
  });
});

describe("runtime validation Claude lexical fallback recall prompt", () => {
  it("tells Claude to grep the exact UUID and not echo another identifier", () => {
    const identifier = "06f71ade-bba5-4fda-8f73-a9cebb7d8ff9";
    const prompt = claudeLexicalRecallPrompt(identifier);
    expect(prompt).toContain("grep");
    expect(prompt).toContain(identifier);
    expect(prompt).toMatch(/do not return any other UUID/i);
  });

  it("retries the live Claude lexical turn", () => {
    expect(CLAUDE_LEXICAL_RECALL_ATTEMPTS).toBe(3);
    const source = readFileSync(new URL("../../scripts/runtime-validate.mjs", import.meta.url), "utf8");
    expect(source).toContain("claudeLexicalRecallPrompt(");
    expect(source).toContain("CLAUDE_LEXICAL_RECALL_ATTEMPTS");
  });
});

describe("runtime validation agent responses", () => {
  const identifier = "a912d384-5605-43ab-bae7-e34b50e6f81a";

  it("accepts model paraphrasing and capitalization around the stable identifier", () => {
    expect(() => assertAgentResponseContainsIdentifier(
      `The Observatory Lantern's identifier is ${identifier}.`,
      identifier,
      "Claude Code capture turn",
    )).not.toThrow();
  });

  it("reports the phase, identifier, and response excerpt when the identifier is absent", () => {
    expect(() => assertAgentResponseContainsIdentifier(
      "I cannot find that item.",
      identifier,
      "Codex semantic recall",
    )).toThrow(
      `Codex semantic recall did not return validation identifier ${identifier}; ` +
      'response="I cannot find that item."',
    );
  });

  it("reports an empty agent response explicitly", () => {
    expect(() => assertAgentResponseContainsIdentifier("\n", identifier, "Claude Code capture turn"))
      .toThrow(/response=<empty>/);
  });

  it("routes every live response through the shared assertion without stale variable names", () => {
    const source = readFileSync(new URL("../../scripts/runtime-validate.mjs", import.meta.url), "utf8");
    expect(source).not.toContain("lexicalToken");
    expect(source).not.toMatch(/(?:claudeResponse|semanticRecall|codexResponse|lexicalRecall)\.includes\(/);
    expect(source.match(/assertAgentResponseContainsIdentifier\(/g)).toHaveLength(7);
    expect(source).toContain("createValidationWorkspace");
    expect(source).toContain("codexSemanticRecallPrompt");
    expect(source).not.toContain("Do not read files. Do not use tools.");
    expect(source).toContain("removeValidationWorkspace");
    expect(source).toContain("runStructuredFilesystemViaHooks");
    expect(source).toContain("skipLiveCodex");
    expect(source).toContain("skipLiveAntigravity");
    expect(source).toContain("pre-invocation.js");
    expect(source).toContain("must not register PreToolUse");
    expect(source).toContain("mcp-server.js");
    expect(source).toContain("callMemoreeMcpTool");
    expect(source).toContain("encodeMcpStdio");
    expect(source).toContain("ndjson");
    expect(source).toContain("call_mcp_tool");
    expect(source).toContain("do not have access to the `memoree_read`");
    expect(source).toContain("assertAntigravityLiveUsedMcp");
    expect(source).toContain("waitForCapture(databasePath, agyIdentifier");
    expect(source).toContain("antigravityLivePrompt");
    expect(source).toContain("memoree_head");
    expect(source).toContain("memoree_tail");
    expect(source).toContain("memoree_wc");
    expect(source).toContain("memoree_jq");
    expect(source).toContain("memoree_mv");
    expect(source).toContain("memoree_rm");
    expect(source).toContain("ls must not dump identity.json body");
    expect(source).toContain("head must be a prefix, not the whole identity.json");
    expect(source).toContain("tail must differ from head on identity.json");
    expect(source).toContain("wc must be a count, not the file body");
    expect(source).toContain("jq .userName must not dump the rest of identity.json");
    expect(source).toContain("graph/query/store");
    expect(source).toMatch(/retryHookUntilContains\([\s\S]*?Codex graph query\/store/);
    expect(source).toContain("graph/show/persistGraph");
    expect(source).toContain("graph/impact/writeSnapshot");
    expect(source).toContain("session-start.js");
    expect(source).toContain("session-start-setup.js");
    expect(source).toContain("plugin-cache-gc.js");
    expect(source).toContain("recall.js");
    expect(source).toContain("graph-on-stop.js");
    expect(source).toContain("PostToolUse");
    expect(source).toContain("SubagentStop");
    expect(source).toContain("Codex SessionEnd");
    expect(source).toContain("checking Codex proactive recall hook");
    expect(source).toContain("assertInstalledCodexShimHealth");
    expect(source).toContain("seedUnlinkedClaudeCacheVersion");
    expect(source).toContain("assertNoCompletedSummaryStubs");
    expect(source).toContain("seedRecallIncidentRows");
    expect(source).toContain("assertRecallSkippedIncidentRows");
    expect(source).toContain("assertCheckoutHarnessPackageJsonUnnamed");
    expect(source).toContain("Claude lexical Grep");
    expect(source).toContain("docs/src/snapshot.ts.md");
    expect(source).toContain("docs/find/persistGraph");
    expect(source).toContain("sessions");
    expect(source).toContain("skillify");
    expect(source).toContain("embeddings");
    expect(source).toContain("\"graph\", \"history\"");
    expect(source).not.toContain("private test fact");
    expect(source).not.toMatch(/mkdtempSync\(join\(tmpdir\(\)/);
  });
});

describe("runtime validation skip-live-codex", () => {
  it("honors the CLI flag and the environment override", () => {
    expect(skipLiveCodexRequested(["node", "runtime-validate.mjs"], {})).toBe(false);
    expect(skipLiveCodexRequested(["node", "runtime-validate.mjs", "--skip-live-codex"], {})).toBe(true);
    expect(skipLiveCodexRequested(["node", "runtime-validate.mjs"], { MEMOREE_VALIDATION_SKIP_LIVE_CODEX: "1" })).toBe(true);
  });
});

describe("runtime validation skip-live-antigravity", () => {
  it("honors the CLI flag and the environment override", () => {
    expect(skipLiveAntigravityRequested(["node", "runtime-validate.mjs"], {})).toBe(false);
    expect(skipLiveAntigravityRequested(["node", "runtime-validate.mjs", "--skip-live-antigravity"], {})).toBe(true);
    expect(skipLiveAntigravityRequested(["node", "runtime-validate.mjs"], { MEMOREE_VALIDATION_SKIP_LIVE_ANTIGRAVITY: "1" })).toBe(true);
  });

  it("writes modelProvider only under the isolated home", () => {
    root = mkdtempSync(join(tmpdir(), "runtime-validate-agy-"));
    writeIsolatedAntigravityGeminiSettings(root);
    const settings = JSON.parse(readFileSync(join(root, ".gemini", "antigravity-cli", "settings.json"), "utf8"));
    expect(settings).toEqual({ modelProvider: "gemini" });
  });

  it("parses Content-Length MCP frames and builds the live MCP prompt", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } });
    const framed = `noise\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    expect(parseMcpFramedMessages(framed)).toEqual([{ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } }]);
    expect(antigravityLivePrompt("abc")).toContain("memoree_read");
    expect(antigravityLivePrompt("abc")).toContain("memoree_write");
    expect(antigravityLivePrompt("abc")).toContain("memoree_grep");
    expect(antigravityLivePrompt("abc")).toContain("abc");
  });

  it("encodes and parses NDJSON MCP frames for Antigravity stdio", () => {
    const msg = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } };
    expect(encodeMcpStdio(msg, "ndjson")).toBe(`${JSON.stringify(msg)}\n`);
    expect(parseMcpFramedMessages(`${JSON.stringify(msg)}\n`)).toEqual([msg]);
  });

  it("requires call_mcp_tool read/write/grep in the isolated Antigravity profile", () => {
    root = mkdtempSync(join(tmpdir(), "runtime-validate-agy-mcp-"));
    const home = root;
    const brain = join(home, ".gemini", "antigravity-cli", "brain");
    mkdirSync(brain, { recursive: true });
    writeFileSync(join(brain, "turn.jsonl"), [
      '{"tool_calls":[{"name":"call_mcp_tool","args":{"ToolName":"memoree_read"}}]}',
      "memoree_write memoree_grep",
      "",
    ].join("\n"));
    expect(() => assertAntigravityLiveUsedMcp(home, "used tools")).not.toThrow();
    expect(() => assertAntigravityLiveUsedMcp(home, "I do not have access to the `memoree_read` tools")).toThrow(/did not receive Memoree MCP tools/);
  });
});

describe("runtime validation live models", () => {
  it("defaults Claude to haiku and Codex to gpt-5.6-luna with low effort", () => {
    expect(DEFAULT_LIVE_CLAUDE_MODEL).toBe("haiku");
    expect(DEFAULT_LIVE_CODEX_MODEL).toBe("gpt-5.6-luna");
    expect(DEFAULT_LIVE_CODEX_REASONING_EFFORT).toBe("low");
    expect(liveClaudeModel({})).toBe("haiku");
    expect(liveCodexModel({})).toBe("gpt-5.6-luna");
    expect(liveCodexReasoningEffort({})).toBe("low");
  });

  it("honors MEMOREE_LIVE_* overrides and ignores blank values", () => {
    expect(liveClaudeModel({ MEMOREE_LIVE_CLAUDE_MODEL: "opus" })).toBe("opus");
    expect(liveCodexModel({ MEMOREE_LIVE_CODEX_MODEL: "gpt-5.5" })).toBe("gpt-5.5");
    expect(liveCodexReasoningEffort({ MEMOREE_LIVE_CODEX_REASONING_EFFORT: "medium" })).toBe("medium");
    expect(liveClaudeModel({ MEMOREE_LIVE_CLAUDE_MODEL: "  " })).toBe("haiku");
    expect(liveCodexModel({ MEMOREE_LIVE_CODEX_MODEL: "" })).toBe("gpt-5.6-luna");
  });

  it("builds claude -p --model and codex exec -m flags", () => {
    expect(claudeLiveCliArgs("PROMPT", ["--bare"], {})).toEqual([
      "-p", "PROMPT", "--model", "haiku", "--bare",
    ]);
    expect(claudeLiveCliArgs("PROMPT", ["--bare"], { MEMOREE_LIVE_CLAUDE_MODEL: "sonnet" })).toEqual([
      "-p", "PROMPT", "--model", "sonnet", "--bare",
    ]);
    expect(codexExecLiveArgs(["--ephemeral", "hi"], {})).toEqual([
      "exec",
      "-m",
      "gpt-5.6-luna",
      "-c",
      'model_reasoning_effort="low"',
      "--ephemeral",
      "hi",
    ]);
  });

  it("pins every live Claude and Codex CLI invocation to those helpers", () => {
    const source = readFileSync(new URL("../../scripts/runtime-validate.mjs", import.meta.url), "utf8");
    const claudeCalls = source.match(/run\("claude"/g) ?? [];
    const pinnedClaude = source.match(/run\("claude",\s*claudeLiveCliArgs\(/g) ?? [];
    expect(claudeCalls.length).toBeGreaterThan(0);
    expect(pinnedClaude).toHaveLength(claudeCalls.length);
    expect(source.match(/runCodex\(\[/)).toBeNull();
    expect(source).toContain("codexExecLiveArgs(");
    expect(source).toContain("live models:");
  });
});

describe("runtime validation hook output", () => {
  it("reads persistGraph from a Codex replacement command or a Claude Read cache file", () => {
    const command = JSON.stringify({
      hookSpecificOutput: { updatedInput: { command: "printf '%s' 'src/snapshot.ts:persistGraph:function'" } },
    });
    expect(hookUpdatedInput(command)).toEqual({ command: "printf '%s' 'src/snapshot.ts:persistGraph:function'" });
    expect(hookBodyContains(command, "persistGraph")).toBe(true);
    expect(hookBodyContains(command, "missing")).toBe(false);
  });
});

describe("runtime validation embedding runtime sharing", () => {
  it("symlinks the real embed-deps and model cache into the isolated home", () => {
    root = mkdtempSync(join(tmpdir(), "runtime-validate-embed-"));
    const realHome = join(root, "real");
    const isolated = join(root, "isolated");
    mkdirSync(join(realHome, ".memoree", "embed-deps"), { recursive: true });
    mkdirSync(join(realHome, ".memoree", "models"), { recursive: true });
    writeFileSync(join(realHome, ".memoree", "embed-deps", "embed-daemon.js"), "daemon\n");
    linkSharedEmbeddingRuntime(realHome, isolated);
    expect(readFileSync(join(isolated, ".memoree", "embed-deps", "embed-daemon.js"), "utf8")).toBe("daemon\n");
    expect(existsSync(join(isolated, ".memoree", "models"))).toBe(true);
  });
});

describe("runtime validation external agent failures", () => {
  it("classifies Codex credit exhaustion as an external dependency", () => {
    expect(classifyAgentCommandError(new Error("stream disconnected: You have no credits remaining.")))
      .toMatch(/External dependency \(Codex API credits\)/);
  });

  it("classifies Gemini quota exhaustion as an external dependency", () => {
    expect(classifyAgentCommandError(new Error("RESOURCE_EXHAUSTED: gemini quota exceeded")))
      .toMatch(/External dependency \(Gemini API quota\)/);
  });

  it("leaves unrelated Codex failures unclassified", () => {
    expect(classifyAgentCommandError(new Error("Command failed: sandbox"))).toBeNull();
  });
});
