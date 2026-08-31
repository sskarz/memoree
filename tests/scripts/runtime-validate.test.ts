import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAgentResponseContainsIdentifier,
  authenticatedClaudeEnvironment,
  authenticatedCodexEnvironment,
  classifyAgentCommandError,
  copyCodexAuthentication,
  createValidationWorkspace,
  hookBodyContains,
  hookUpdatedInput,
  linkSharedEmbeddingRuntime,
  isolatedCounts,
  lexicalValidationPrompt,
  prepareCodexAuthentication,
  codexSemanticRecallPrompt,
  skipLiveCodexRequested,
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

  it("maps OPENAI_API_KEY onto CODEX_API_KEY without overwriting an explicit Codex key", () => {
    expect(authenticatedCodexEnvironment({ OPENAI_API_KEY: "sk-openai" }).CODEX_API_KEY).toBe("sk-openai");
    expect(authenticatedCodexEnvironment({
      OPENAI_API_KEY: "sk-openai",
      CODEX_API_KEY: "sk-codex",
    }).CODEX_API_KEY).toBe("sk-codex");
    expect(authenticatedCodexEnvironment({}).CODEX_API_KEY).toBeUndefined();
  });

  it("accepts CODEX_API_KEY when auth.json is absent", () => {
    root = mkdtempSync(join(tmpdir(), "runtime-validate-codex-env-"));
    const realHome = join(root, "real");
    const isolated = join(root, "isolated", ".codex");
    mkdirSync(join(realHome, ".codex"), { recursive: true });
    expect(prepareCodexAuthentication(realHome, isolated, { CODEX_API_KEY: "sk-codex" })).toBe("env");
    expect(existsSync(join(isolated, "auth.json"))).toBe(false);
  });

  it("prefers copying auth.json when it exists even if an API key is also set", () => {
    root = mkdtempSync(join(tmpdir(), "runtime-validate-codex-copy-"));
    const realHome = join(root, "real");
    const isolated = join(root, "isolated", ".codex");
    mkdirSync(join(realHome, ".codex"), { recursive: true });
    writeFileSync(join(realHome, ".codex", "auth.json"), "{\"OPENAI_API_KEY\":\"copied\"}\n");
    expect(prepareCodexAuthentication(realHome, isolated, { OPENAI_API_KEY: "sk-env" })).toBe("auth.json");
    expect(readFileSync(join(isolated, "auth.json"), "utf8")).toContain("copied");
  });

  it("fails closed when neither auth.json nor an API key is present", () => {
    root = mkdtempSync(join(tmpdir(), "runtime-validate-codex-none-"));
    const realHome = join(root, "real");
    const isolated = join(root, "isolated", ".codex");
    mkdirSync(join(realHome, ".codex"), { recursive: true });
    expect(() => prepareCodexAuthentication(realHome, isolated, {})).toThrow(/CODEX_API_KEY/);
  });
});

describe("runtime validation lexical marker", () => {
  it("survives capture redaction as an exact searchable identifier", () => {
    const identifier = "3b4aa504-2da6-4ad1-995b-293f1254d6c3";
    const prompt = lexicalValidationPrompt(identifier);
    expect(redactSecrets(prompt)).toBe(prompt);
    expect(prompt).toContain(identifier);
  });

  it("guards against the secret-like token label used by the failed validator", () => {
    const identifier = "3b4aa504-2da6-4ad1-995b-293f1254d6c3";
    expect(redactSecrets(`Repeat this exact lexical fallback token: memoree-lexical-${identifier}`))
      .not.toContain(identifier);
  });
});

describe("runtime validation Codex semantic recall prompt", () => {
  it("tells Codex to grep Memoree summaries instead of answering from the user message", () => {
    const prompt = codexSemanticRecallPrompt();
    expect(prompt).toContain("grep -ri");
    expect(prompt).toContain("~/.memoree/memory/summaries/");
    expect(prompt).toContain("observatory lantern");
    expect(prompt).not.toMatch(/do not (read files|use tools)/i);
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
    expect(source.match(/assertAgentResponseContainsIdentifier\(/g)).toHaveLength(6);
    expect(source).toContain("createValidationWorkspace");
    expect(source).toContain("codexSemanticRecallPrompt");
    expect(source).not.toContain("Do not read files. Do not use tools.");
    expect(source).toContain("removeValidationWorkspace");
    expect(source).toContain("runStructuredFilesystemViaHooks");
    expect(source).toContain("skipLiveCodex");
    expect(source).toContain("graph/query/store");
    expect(source).toContain("graph/show/persistGraph");
    expect(source).toContain("graph/impact/writeSnapshot");
    expect(source).toContain("session-start.js");
    expect(source).toContain("session-start-setup.js");
    expect(source).toContain("plugin-cache-gc.js");
    expect(source).toContain("recall.js");
    expect(source).toContain("graph-on-stop.js");
    expect(source).toContain("PostToolUse");
    expect(source).toContain("SubagentStop");
    expect(source).toContain("Claude lexical Grep");
    expect(source).toContain("docs/src/snapshot.ts.md");
    expect(source).toContain("docs/find/persistGraph");
    expect(source).toContain("sessions");
    expect(source).toContain("skillify");
    expect(source).toContain("embeddings");
    expect(source).toContain("\"graph\", \"history\"");
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

  it("leaves unrelated Codex failures unclassified", () => {
    expect(classifyAgentCommandError(new Error("Command failed: sandbox"))).toBeNull();
  });
});
