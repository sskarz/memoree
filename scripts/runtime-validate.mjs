#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { assertNoActiveAgentSessions, runtimePaths } from "./runtime-manager.mjs";

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      input: options.input,
      maxBuffer: 64 * 1024 * 1024,
      stdio: options.capture === false ? "inherit" : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      timeout: options.timeout ?? 240_000,
    });
  } catch (cause) {
    const error = /** @type {Error & { stdout?: unknown; stderr?: unknown }} */ (cause);
    const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    const details = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join("\n");
    throw new Error(details ? `${error.message}\n${details}` : error.message, { cause: error });
  }
}

function runHook(bundlePath, input, options) {
  run(process.execPath, [bundlePath], {
    ...options,
    input: `${JSON.stringify(input)}\n`,
  });
}

function runHookResult(bundlePath, input, options) {
  const result = spawnSync(process.execPath, [bundlePath], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: `${JSON.stringify(input)}\n`,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function status(message) {
  process.stdout.write(`  ${message}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function authenticatedClaudeEnvironment(baseEnv, home, configDir) {
  const env = {
    ...baseEnv,
    HOME: home,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  const configured = configDir?.trim();
  if (configured) env.CLAUDE_CONFIG_DIR = configured;
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

export function lexicalValidationPrompt(identifier) {
  return `Repeat this exact lexical fallback marker identifier: ${identifier}`;
}

export function copyCodexAuthentication(realHome, isolatedCodexHome) {
  const source = join(realHome, ".codex", "auth.json");
  assert(existsSync(source), `Codex authentication material is missing: ${source}`);
  mkdirSync(isolatedCodexHome, { recursive: true, mode: 0o700 });
  copyFileSync(source, join(isolatedCodexHome, "auth.json"));
}

export function createValidationWorkspace(home = homedir()) {
  const cacheDir = join(home, ".cache");
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(cacheDir, "memoree-runtime-validate-"));
}

export function classifyAgentCommandError(error) {
  const text = [
    error instanceof Error ? error.message : String(error ?? ""),
    typeof error === "object" && error && "cause" in error && error.cause instanceof Error ? error.cause.message : "",
  ].join("\n");
  if (/no credits remaining/i.test(text) || /insufficient.?quota/i.test(text)) {
    return "External dependency (Codex API credits): add credits at https://platform.openai.com/settings/organization/billing/ and retry runtime:validate.";
  }
  return null;
}

function runCodex(args, options) {
  try {
    return run("codex", args, options);
  } catch (error) {
    const classified = classifyAgentCommandError(error);
    throw classified ? new Error(classified, { cause: error }) : error;
  }
}

export function runStructuredFilesystemViaHooks(preToolPath, commands, options) {
  return commands.map(command => {
    const result = runHookResult(preToolPath, {
      session_id: options.sessionId ?? crypto.randomUUID(),
      tool_name: "shell",
      tool_use_id: "runtime-validation",
      cwd: options.cwd,
      hook_event_name: "pre_tool_use",
      model: "runtime-validation",
      tool_input: { command },
    }, options);
    return { command, status: result.status, stdout: result.stdout, stderr: result.stderr };
  });
}

export function assertAgentResponseContainsIdentifier(response, identifier, phase) {
  if (response.includes(identifier)) return;
  const trimmed = response.trim();
  const excerpt = trimmed ? JSON.stringify(trimmed.slice(0, 800)) : "<empty>";
  throw new Error(
    `${phase} did not return validation identifier ${identifier}; response=${excerpt}`,
  );
}

function vectorLength(value) {
  if (Array.isArray(value)) return value.length;
  if (typeof value !== "string") return 0;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export function isolatedCounts(databasePath, text) {
  if (!existsSync(databasePath)) {
    return { matchingEvents: 0, summaries: 0, matchingSummaries: 0 };
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const sessionsExists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
    ).get() !== undefined;
    const memoryExists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory'",
    ).get() !== undefined;
    const matchingEvents = sessionsExists
      ? Number(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE CAST(message AS TEXT) LIKE ?").get(`%${text}%`)?.count ?? 0)
      : 0;
    const summaries = memoryExists
      ? Number(db.prepare("SELECT COUNT(*) AS count FROM memory WHERE path LIKE '/summaries/%'").get()?.count ?? 0)
      : 0;
    const matchingSummaries = memoryExists
      ? Number(db.prepare(
        "SELECT COUNT(*) AS count FROM memory WHERE path LIKE '/summaries/%' AND CAST(summary AS TEXT) LIKE ?",
      ).get(`%${text}%`)?.count ?? 0)
      : 0;
    return { matchingEvents, summaries, matchingSummaries };
  } finally {
    db.close();
  }
}

export async function waitForCapture(databasePath, text, options = {}) {
  const requireSummary = options.requireSummary ?? false;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const pollMs = options.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let lastCounts = { matchingEvents: 0, summaries: 0, matchingSummaries: 0 };
  while (Date.now() < deadline) {
    try {
      lastCounts = isolatedCounts(databasePath, text);
      if (
        lastCounts.matchingEvents > 0 &&
        (!requireSummary || lastCounts.matchingSummaries > 0)
      ) return lastCounts;
    } catch {
      // Capture and summary workers may still be creating or writing the DB.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, pollMs));
  }
  const requirement = requireSummary ? "event and matching summary" : "event";
  throw new Error(
    `Timed out waiting for isolated ${requirement} containing ${text} ` +
    `(events=${lastCounts.matchingEvents}, summaries=${lastCounts.summaries}, matchingSummaries=${lastCounts.matchingSummaries})`,
  );
}

function databaseHasEmbedding(databasePath) {
  if (!existsSync(databasePath)) return false;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = db.prepare(
      "SELECT message_embedding AS embedding FROM sessions WHERE message_embedding IS NOT NULL",
    ).all();
    return rows.some(row => vectorLength(row.embedding) === 768);
  } catch {
    return false;
  } finally {
    db.close();
  }
}

async function captureUntilEmbedded(bundlePath, input, options, databasePath) {
  const deadline = Date.now() + 60_000;
  do {
    runHook(bundlePath, input, options);
    if (databaseHasEmbedding(databasePath)) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000));
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for a 768-element embedding from the installed capture hook");
}

function inspectDatabase(databasePath, semanticFact, semanticIdentifier, lexicalIdentifier) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
    const journal = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
    const events = db.prepare("SELECT message, message_embedding FROM sessions ORDER BY creation_date").all();
    const summaries = db.prepare("SELECT summary, summary_embedding FROM memory WHERE path LIKE '/summaries/%'").all();
    assert(String(integrity).toLowerCase() === "ok", "SQLite integrity_check failed");
    assert(String(journal).toLowerCase() === "wal", "SQLite is not in WAL mode");
    assert(events.length > 0, "No runtime validation events were captured");
    assert(summaries.length > 0, "No runtime validation summaries were generated");
    const eventText = events.map(row => row.message).join("\n");
    const summaryText = summaries.map(row => row.summary).join("\n");
    assert(eventText.includes(semanticFact), "Semantic validation fact is missing from isolated SQLite events");
    assert(eventText.includes(lexicalIdentifier), "Lexical validation identifier is missing from isolated SQLite events");
    assert(
      summaryText.includes(semanticIdentifier),
      "Semantic validation identifier is missing from isolated summaries",
    );
    assert(summaryText.includes(lexicalIdentifier), "Lexical validation identifier is missing from isolated summaries");
    assert(
      [...events.map(row => row.message_embedding), ...summaries.map(row => row.summary_embedding)]
        .some(value => vectorLength(value) === 768),
      "No 768-element embedding was captured",
    );
    return { events: events.length, summaries: summaries.length };
  } finally {
    db.close();
  }
}

function inspectStructuredDatabase(databasePath, ruleId, goalId, ruleV2, goalV2) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rules = db.prepare(
      "SELECT version, status, text FROM memoree_rules WHERE rule_id = ? ORDER BY version",
    ).all(ruleId);
    assert(rules.length === 5, `Expected five persisted rule versions, got ${rules.length}`);
    assert(rules.at(-1)?.status === "done", "Runtime validation rule was not soft-completed");
    assert(rules.at(-1)?.text === ruleV2, "Runtime validation rule edit did not persist");
    const goal = db.prepare(
      "SELECT owner, status, content FROM memoree_goals WHERE goal_id = ?",
    ).get(goalId);
    assert(goal?.owner === "runtime-validation-bob", "Runtime validation goal owner move did not persist");
    assert(goal?.status === "closed", "Runtime validation goal soft-close did not persist");
    assert(goal?.content === goalV2, "Runtime validation goal edit did not persist");
  } finally {
    db.close();
  }
}

export async function validateRuntime() {
  assertNoActiveAgentSessions();
  const { runtimeDir } = runtimePaths();
  const cli = join(runtimeDir, "bundle", "cli.js");
  const claudeBundle = join(runtimeDir, "harnesses", "claude-code", "bundle");
  const codexBundle = join(runtimeDir, "harnesses", "codex", "bundle");
  const requiredBundles = [
    cli,
    join(claudeBundle, "capture.js"),
    join(claudeBundle, "session-end.js"),
    join(codexBundle, "capture.js"),
    join(codexBundle, "stop.js"),
    join(codexBundle, "pre-tool-use.js"),
    join(codexBundle, "command", "memoree.js"),
  ];
  for (const bundle of requiredBundles) {
    assert(existsSync(bundle), `Installed runtime bundle is missing: ${bundle}`);
  }

  const root = createValidationWorkspace();
  const repository = join(root, "repo");
  const state = join(root, "state");
  const isolatedHome = join(root, "home");
  const isolatedTmp = join(root, "tmp");
  const isolatedCodexHome = join(isolatedHome, ".codex");
  const databasePath = join(state, "memoree.sqlite3");
  const claudeSettings = join(state, "claude-settings.json");
  const realHome = homedir();
  const realClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const semanticIdentifier = crypto.randomUUID();
  const semanticFact = `the observatory lantern is ${semanticIdentifier}`;
  const lexicalIdentifier = crypto.randomUUID();
  const env = {
    ...process.env,
    HOME: isolatedHome,
    CLAUDE_CONFIG_DIR: join(isolatedHome, ".claude"),
    CODEX_HOME: isolatedCodexHome,
    MEMOREE_BACKEND: "sqlite",
    MEMOREE_SQLITE_PATH: databasePath,
    MEMOREE_CONFIG_PATH: join(state, "config.json"),
    MEMOREE_MEMORY_PATH: join(state, "memory"),
    MEMOREE_STATE_DIR: join(state, "agent-state"),
    MEMOREE_REPOSITORY_KEY: "runtime-validation",
    MEMOREE_USER_NAME: "runtime-validation",
    MEMOREE_CAPTURE: "true",
    MEMOREE_CAPTURE_ONLY_CLI: "false",
    MEMOREE_EMBEDDINGS: "true",
    MEMOREE_SESSION_EVENT_CACHE: "false",
    MEMOREE_SKILLIFY_WORKER: "1",
    MEMOREE_SKILLOPT_DISABLED: "1",
    MEMOREE_SUMMARY_EVERY_N_MSGS: "1000",
    MEMOREE_RUNTIME_VALIDATION: "1",
    MEMOREE_VALIDATION_CLAUDE_HOME: realHome,
    ...(realClaudeConfigDir ? { MEMOREE_VALIDATION_CLAUDE_CONFIG_DIR: realClaudeConfigDir } : {}),
    CLAUDE_CODE_ENTRYPOINT: "cli",
    TMPDIR: isolatedTmp,
    TMP: isolatedTmp,
    TEMP: isolatedTmp,
  };
  const claudeEnv = authenticatedClaudeEnvironment(env, realHome, realClaudeConfigDir);
  const ruleId = crypto.randomUUID();
  const goalId = crypto.randomUUID();
  const ruleV1 = `runtime rule ${crypto.randomUUID()}`;
  const ruleV2 = `${ruleV1} verified`;
  const goalV1 = `runtime goal ${crypto.randomUUID()}`;
  const goalV2 = `${goalV1} edited`;
  const structuredMarker = crypto.randomUUID();

  try {
    mkdirSync(state, { recursive: true });
    mkdirSync(isolatedHome, { recursive: true });
    mkdirSync(isolatedTmp, { recursive: true, mode: 0o700 });
    copyCodexAuthentication(realHome, isolatedCodexHome);
    writeFileSync(claudeSettings, `${JSON.stringify({
      autoMemoryDirectory: join(state, "claude-auto-memory"),
    }, null, 2)}\n`, { mode: 0o600 });
    run("git", ["init", repository], { env, capture: false });
    run("git", ["config", "user.email", "runtime-validation@memoree.local"], { cwd: repository, env });
    run("git", ["config", "user.name", "Memoree Runtime Validation"], { cwd: repository, env });
    writeFileSync(join(repository, "AGENTS.md"), [
      "# Runtime validation",
      "",
      `Use only Memoree memory rooted at ${env.MEMOREE_MEMORY_PATH}.`,
      "For memory questions, search that path with grep so the installed Memoree hook can provide the isolated results.",
      "Do not read or write any other memory location.",
      "",
    ].join("\n"));

    status("checking the isolated SQLite backend");
    run(process.execPath, [cli, "backend", "check"], { cwd: repository, env });

    status("installing the promoted Codex runtime into a clean profile");
    run(process.execPath, [cli, "codex", "install"], { cwd: repository, env });

    const codexPreTool = join(codexBundle, "pre-tool-use.js");
    const vfsHookOptions = { cwd: repository, env: { ...env, MEMOREE_CAPTURE: "false" } };
    status("checking structured Memoree VFS through Codex hooks");
    const vfsCommands = [
      "cat ~/.memoree/memory/identity.json",
      "cat ~/.memoree/memory/rules.md",
      "cat ~/.memoree/memory/goals.md",
      `printf '%s' '${ruleV1}' > ~/.memoree/memory/rules/active/${ruleId}.md`,
      `printf '%s' '${ruleV2}' > ~/.memoree/memory/rules/active/${ruleId}.md`,
      `mv ~/.memoree/memory/rules/active/${ruleId}.md ~/.memoree/memory/rules/done/${ruleId}.md`,
      `mv ~/.memoree/memory/rules/done/${ruleId}.md ~/.memoree/memory/rules/active/${ruleId}.md`,
      `rm ~/.memoree/memory/rules/active/${ruleId}.md`,
      `printf '%s' '${goalV1}' > ~/.memoree/memory/goal/runtime-validation/opened/${goalId}.md`,
      `printf '%s' '${goalV2}' > ~/.memoree/memory/goal/runtime-validation/opened/${goalId}.md`,
      `mv ~/.memoree/memory/goal/runtime-validation/opened/${goalId}.md ~/.memoree/memory/goal/runtime-validation-bob/in_progress/${goalId}.md`,
      `rm ~/.memoree/memory/goal/runtime-validation-bob/in_progress/${goalId}.md`,
    ];
    const vfsResults = runStructuredFilesystemViaHooks(codexPreTool, vfsCommands, vfsHookOptions);
    const failedVfs = vfsResults.find(result => result.status !== 0);
    assert(
      !failedVfs,
      `Structured VFS command failed (${failedVfs?.status}): ${failedVfs?.command}\n${failedVfs?.stderr || failedVfs?.stdout || ""}`,
    );
    inspectStructuredDatabase(databasePath, ruleId, goalId, ruleV2, goalV2);

    const hookBase = {
      session_id: crypto.randomUUID(), tool_name: "shell", tool_use_id: "runtime-validation",
      cwd: repository, hook_event_name: "pre_tool_use", model: "runtime-validation",
    };
    const missingResult = runHookResult(codexPreTool, {
      ...hookBase,
      tool_input: { command: "cat ~/.memoree/memory/rules/active/definitely-missing.md" },
    }, { cwd: repository, env });
    assert(missingResult.status === 0, "Missing VFS path was incorrectly treated as a hook denial");
    const missingWire = JSON.parse(missingResult.stdout);
    const missingReplacement = missingWire?.hookSpecificOutput?.updatedInput?.command ?? "";
    assert(missingReplacement.includes("exit 1"), "Missing VFS path did not preserve a normal nonzero command failure");
    assert(!missingReplacement.includes(".memoree/memory"), "Missing-path replacement exposed the original host path");

    const unsafeResult = runHookResult(codexPreTool, {
      ...hookBase,
      tool_input: { command: "rm -rf ~/.memoree/memory/rules" },
    }, { cwd: repository, env });
    assert(unsafeResult.status === 2, "Unsafe VFS command was not rejected by the hook security policy");

    const brokerResult = runHookResult(codexPreTool, {
      ...hookBase,
      tool_input: { command: "memoree rules list" },
    }, { cwd: repository, env });
    assert(brokerResult.status === 0, "Codex compatibility broker did not handle memoree rules list");
    const brokerWire = JSON.parse(brokerResult.stdout);
    const brokerReplacement = brokerWire?.hookSpecificOutput?.updatedInput?.command ?? "";
    assert(!brokerReplacement.includes("memoree rules list"), "Compatibility replacement exposed executable user input");

    const claudeSession = crypto.randomUUID();
    const claudePrompt = `Repeat this exact private test fact: ${semanticFact}`;
    status("running an authenticated Claude Code capture turn");
    const claudeResponse = run("claude", [
      "-p", claudePrompt,
      "--safe-mode",
      "--tools", "",
      "--settings", claudeSettings,
      "--output-format", "text",
      "--no-session-persistence",
      "--session-id", claudeSession,
    ], { cwd: repository, env: claudeEnv });
    assertAgentResponseContainsIdentifier(
      claudeResponse,
      semanticIdentifier,
      "Claude Code capture turn",
    );

    const claudeHookOptions = { cwd: repository, env };
    runHook(join(claudeBundle, "capture.js"), {
      session_id: claudeSession,
      cwd: repository,
      hook_event_name: "UserPromptSubmit",
      prompt: claudePrompt,
    }, claudeHookOptions);
    await captureUntilEmbedded(join(claudeBundle, "capture.js"), {
      session_id: claudeSession,
      cwd: repository,
      hook_event_name: "Stop",
      last_assistant_message: claudeResponse.trim(),
    }, claudeHookOptions, databasePath);
    runHook(join(claudeBundle, "session-end.js"), {
      session_id: claudeSession,
      cwd: repository,
      hook_event_name: "SessionEnd",
    }, claudeHookOptions);

    status("waiting for the Claude Code summary");
    // Summaries are semantic by design and may paraphrase the sentence around
    // the value. The unique UUID is the durable, non-derivable proof that the
    // generated summary retained the captured fact.
    await waitForCapture(databasePath, semanticIdentifier, { requireSummary: true });

    status("checking filesystem-native Memoree through authenticated Codex");
    const structuredPrompt = [
      "Use the shell to run: cat ~/.memoree/memory/identity.json",
      `After that command, respond with exactly STRUCTURED_OK ${structuredMarker}.`,
    ].join("\n");
    const structuredResponse = runCodex([
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "-s", "read-only",
      structuredPrompt,
    ], { cwd: repository, env: { ...env, MEMOREE_CAPTURE: "false" } });
    assertAgentResponseContainsIdentifier(
      structuredResponse,
      structuredMarker,
      "Codex structured filesystem workflow",
    );

    const recallEnv = { ...env, MEMOREE_CAPTURE: "false" };
    status("checking semantic recall through Codex");
    const semanticRecall = runCodex([
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "-s", "read-only",
      "Recall the unusual observatory object and its exact identifier from Memoree. Answer with only that fact.",
    ], { cwd: repository, env: recallEnv });
    assertAgentResponseContainsIdentifier(
      semanticRecall,
      semanticIdentifier,
      "Codex semantic recall",
    );

    const lexicalEnv = { ...env, MEMOREE_EMBEDDINGS: "false" };
    const codexSession = crypto.randomUUID();
    // Avoid secret-like labels such as `token:` and high-entropy prefixes.
    // Capture redaction intentionally masks those before persistence. A bare
    // UUID labeled as an identifier is unique while remaining non-secret.
    const codexPrompt = lexicalValidationPrompt(lexicalIdentifier);
    status("running an authenticated Codex capture turn with embeddings disabled");
    const codexResponse = runCodex([
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "-s", "read-only",
      codexPrompt,
    ], { cwd: repository, env: lexicalEnv });
    assertAgentResponseContainsIdentifier(
      codexResponse,
      lexicalIdentifier,
      "Codex capture turn",
    );
    const codexHookOptions = { cwd: repository, env: lexicalEnv };
    runHook(join(codexBundle, "capture.js"), {
      session_id: codexSession,
      transcript_path: null,
      cwd: repository,
      hook_event_name: "UserPromptSubmit",
      model: "runtime-validation",
      prompt: codexPrompt,
    }, codexHookOptions);
    runHook(join(codexBundle, "stop.js"), {
      session_id: codexSession,
      transcript_path: null,
      cwd: repository,
      hook_event_name: "Stop",
      model: "runtime-validation",
    }, codexHookOptions);

    status("waiting for the Codex lexical summary");
    await waitForCapture(databasePath, lexicalIdentifier, { requireSummary: true });

    status("checking lexical fallback recall through Claude Code");
    const lexicalRecall = run("claude", [
      "-p",
      `Search Memoree lexically for marker ${lexicalIdentifier} and answer with only the matching identifier.`,
      "--tools", "",
      "--settings", claudeSettings,
      "--output-format", "text",
      "--no-session-persistence",
    ], {
      cwd: repository,
      env: authenticatedClaudeEnvironment(
        { ...lexicalEnv, MEMOREE_CAPTURE: "false" },
        realHome,
        realClaudeConfigDir,
      ),
    });
    assertAgentResponseContainsIdentifier(
      lexicalRecall,
      lexicalIdentifier,
      "Claude Code lexical fallback recall",
    );

    const counts = inspectDatabase(databasePath, semanticFact, semanticIdentifier, lexicalIdentifier);
    process.stdout.write(
      `Runtime validation passed: ${counts.events} events, ${counts.summaries} summaries, SQLite integrity/WAL, 768-d embeddings, semantic and lexical cross-agent recall.\n`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  await validateRuntime();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`memoree runtime validation: ${error.message}\n`);
    process.exitCode = 1;
  });
}
