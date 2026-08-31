#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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

export function skipLiveCodexRequested(argv = process.argv, env = process.env) {
  return argv.includes("--skip-live-codex") || env.MEMOREE_VALIDATION_SKIP_LIVE_CODEX === "1";
}

export function hookUpdatedInput(stdout) {
  try {
    return JSON.parse(stdout)?.hookSpecificOutput?.updatedInput ?? {};
  } catch {
    return {};
  }
}

export function linkSharedEmbeddingRuntime(realHome, isolatedHome) {
  const isolatedMemoree = join(isolatedHome, ".memoree");
  mkdirSync(isolatedMemoree, { recursive: true, mode: 0o700 });
  for (const name of ["embed-deps", "models"]) {
    const source = join(realHome, ".memoree", name);
    const dest = join(isolatedMemoree, name);
    if (existsSync(source) && !existsSync(dest)) symlinkSync(source, dest);
  }
}

export function hookBodyContains(stdout, needle) {
  const updated = hookUpdatedInput(stdout);
  const command = typeof updated.command === "string" ? updated.command : "";
  const filePath = typeof updated.file_path === "string" ? updated.file_path : "";
  const fileBody = filePath && existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  return `${command}\n${fileBody}`.includes(needle);
}

function assertHookContains(result, needle, phase) {
  assert(result.status === 0, `${phase} hook exited ${result.status}: ${result.stderr}`);
  assert(
    hookBodyContains(result.stdout, needle),
    `${phase} did not include ${needle}; stdout=${JSON.stringify(result.stdout).slice(0, 1200)} stderr=${JSON.stringify(result.stderr).slice(0, 400)}`,
  );
}

function assertHookExitZero(result, phase) {
  assert(result.status === 0, `${phase} hook exited ${result.status}: ${result.stderr || result.stdout}`);
}

function retryHookUntilContains(run, needle, phase, attempts = 5) {
  let last = { status: 1, stdout: "", stderr: "" };
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = run();
    if (last.status === 0 && hookBodyContains(last.stdout, needle)) return last;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  assertHookContains(last, needle, phase);
  return last;
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
    assert(
      summaryText.includes(semanticIdentifier),
      "Semantic validation identifier is missing from isolated summaries",
    );
    if (lexicalIdentifier) {
      assert(eventText.includes(lexicalIdentifier), "Lexical validation identifier is missing from isolated SQLite events");
      assert(summaryText.includes(lexicalIdentifier), "Lexical validation identifier is missing from isolated summaries");
    }
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

function inspectStructuredDatabase(databasePath, ruleId, goalId, ruleV2, goalV2, kpiId, kpiText) {
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
    const kpi = db.prepare(
      "SELECT content FROM memoree_kpis WHERE goal_id = ? AND kpi_id = ?",
    ).get(goalId, kpiId);
    assert(kpi?.content === kpiText, "Runtime validation KPI edit did not persist");
  } finally {
    db.close();
  }
}

export async function validateRuntime(options = {}) {
  const skipLiveCodex = options.skipLiveCodex === true;
  assertNoActiveAgentSessions();
  const { runtimeDir } = runtimePaths();
  const cli = join(runtimeDir, "bundle", "cli.js");
  const claudeBundle = join(runtimeDir, "harnesses", "claude-code", "bundle");
  const codexBundle = join(runtimeDir, "harnesses", "codex", "bundle");
  const requiredBundles = [
    cli,
    join(claudeBundle, "capture.js"),
    join(claudeBundle, "session-start.js"),
    join(claudeBundle, "session-end.js"),
    join(claudeBundle, "pre-tool-use.js"),
    join(claudeBundle, "recall.js"),
    join(claudeBundle, "graph-on-stop.js"),
    join(claudeBundle, "session-start-setup.js"),
    join(claudeBundle, "plugin-cache-gc.js"),
    join(codexBundle, "capture.js"),
    join(codexBundle, "session-start.js"),
    join(codexBundle, "session-start-setup.js"),
    join(codexBundle, "stop.js"),
    join(codexBundle, "graph-on-stop.js"),
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
    MEMOREE_GRAPHS_HOME: join(state, "graphs"),
    MEMOREE_REPOSITORY_KEY: "runtime-validation",
    MEMOREE_USER_NAME: "runtime-validation",
    MEMOREE_CAPTURE: "true",
    MEMOREE_CAPTURE_ONLY_CLI: "false",
    MEMOREE_EMBEDDINGS: "true",
    MEMOREE_SESSION_EVENT_CACHE: "false",
    MEMOREE_SKILLIFY_WORKER: "1",
    MEMOREE_SKILLOPT_DISABLED: "1",
    MEMOREE_SUMMARY_EVERY_N_MSGS: "1000",
    MEMOREE_RECALL_TIMEOUT_MS: "8000",
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
  const kpiId = crypto.randomUUID();
  const kpiV1 = `runtime kpi ${crypto.randomUUID()}`;
  const kpiV2 = `${kpiV1} verified`;

  try {
    mkdirSync(state, { recursive: true });
    mkdirSync(isolatedHome, { recursive: true });
    mkdirSync(isolatedTmp, { recursive: true, mode: 0o700 });
    linkSharedEmbeddingRuntime(realHome, isolatedHome);
    if (skipLiveCodex) mkdirSync(isolatedCodexHome, { recursive: true, mode: 0o700 });
    else copyCodexAuthentication(realHome, isolatedCodexHome);
    writeFileSync(claudeSettings, `${JSON.stringify({
      autoMemoryDirectory: join(state, "claude-auto-memory"),
    }, null, 2)}\n`, { mode: 0o600 });
    run("git", ["init", repository], { env, capture: false });
    run("git", ["config", "user.email", "runtime-validation@memoree.local"], { cwd: repository, env });
    run("git", ["config", "user.name", "Memoree Runtime Validation"], { cwd: repository, env });
    writeFileSync(join(repository, "AGENTS.md"), [
      "# Runtime validation",
      "",
      "When the user asks you to repeat a private test fact or identifier, reply with that exact UUID from the user message.",
      "Do not invent identifiers. Do not read files. Do not use tools.",
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
      `printf '%s' '${kpiV1}' > ~/.memoree/memory/kpi/${goalId}/${kpiId}.md`,
      `printf '%s' '${kpiV2}' > ~/.memoree/memory/kpi/${goalId}/${kpiId}.md`,
      `cat ~/.memoree/memory/kpi/${goalId}/${kpiId}.md`,
    ];
    const vfsResults = runStructuredFilesystemViaHooks(codexPreTool, vfsCommands, vfsHookOptions);
    const failedVfs = vfsResults.find(result => result.status !== 0);
    assert(
      !failedVfs,
      `Structured VFS command failed (${failedVfs?.status}): ${failedVfs?.command}\n${failedVfs?.stderr || failedVfs?.stdout || ""}`,
    );
    inspectStructuredDatabase(databasePath, ruleId, goalId, ruleV2, goalV2, kpiId, kpiV2);
    const kpiCat = vfsResults[vfsResults.length - 1];
    assert(kpiCat, "KPI cat result missing");
    assertHookContains(kpiCat, kpiV2, "Codex KPI cat");

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

    mkdirSync(join(repository, "src"), { recursive: true });
    writeFileSync(join(repository, "src", "snapshot.ts"), [
      "export function writeSnapshot(): string {",
      "  return 'snapshot-bytes';",
      "}",
      "",
      "/** flush the snapshot bytes to disk */",
      "export function persistGraph(): string {",
      "  return writeSnapshot();",
      "}",
      "",
    ].join("\n"));
    run("git", ["add", "src/snapshot.ts"], { cwd: repository, env });
    run("git", ["commit", "-m", "runtime validation graph fixture"], { cwd: repository, env });
    status("building the isolated codebase graph");
    run(process.execPath, [cli, "graph", "build", "--cwd", repository], { cwd: repository, env });

    status("checking graph query/ through Codex and Claude hooks");
    const claudePreTool = join(claudeBundle, "pre-tool-use.js");
    const queryStoreCodex = runHookResult(codexPreTool, {
      ...hookBase,
      tool_input: { command: "cat ~/.memoree/memory/graph/query/store" },
    }, vfsHookOptions);
    assertHookContains(queryStoreCodex, "persistGraph", "Codex graph query/store");
    const queryPersistCodex = runHookResult(codexPreTool, {
      ...hookBase,
      tool_input: { command: "cat ~/.memoree/memory/graph/query/persist" },
    }, vfsHookOptions);
    assertHookContains(queryPersistCodex, "persistGraph", "Codex graph query/persist");
    const lexicalFindStore = runHookResult(codexPreTool, {
      ...hookBase,
      tool_input: { command: "cat ~/.memoree/memory/graph/find/store" },
    }, vfsHookOptions);
    assert(lexicalFindStore.status === 0, `Codex graph find/store hook failed: ${lexicalFindStore.stderr}`);
    assert(
      !hookBodyContains(lexicalFindStore.stdout, "persistGraph"),
      "Codex graph find/store unexpectedly returned persistGraph",
    );
    retryHookUntilContains(
      () => runHookResult(claudePreTool, {
        session_id: crypto.randomUUID(),
        cwd: repository,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_use_id: "runtime-validation-graph",
        tool_input: { file_path: "~/.memoree/memory/graph/query/store" },
      }, vfsHookOptions),
      "persistGraph",
      "Claude Read graph query/store",
    );
    retryHookUntilContains(
      () => runHookResult(claudePreTool, {
        session_id: crypto.randomUUID(),
        cwd: repository,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "runtime-validation-graph-bash",
        tool_input: { command: "cat ~/.memoree/memory/graph/query/store" },
      }, vfsHookOptions),
      "persistGraph",
      "Claude Bash graph query/store",
    );
    retryHookUntilContains(
      () => runHookResult(claudePreTool, {
        session_id: crypto.randomUUID(),
        cwd: repository,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_use_id: "runtime-validation-identity",
        tool_input: { file_path: "~/.memoree/memory/identity.json" },
      }, vfsHookOptions),
      "runtime-validation",
      "Claude Read identity.json",
    );

    const graphIndex = runHookResult(codexPreTool, {
      ...hookBase,
      tool_input: { command: "cat ~/.memoree/memory/graph/index.md" },
    }, vfsHookOptions);
    assertHookContains(graphIndex, "How to query", "Codex graph index.md");
    const graphListing = runHookResult(codexPreTool, {
      ...hookBase,
      tool_input: { command: "ls ~/.memoree/memory/graph" },
    }, vfsHookOptions);
    assertHookContains(graphListing, "query/", "Codex ls graph");
    assertHookContains(
      runHookResult(codexPreTool, {
        ...hookBase,
        tool_input: { command: "cat ~/.memoree/memory/graph/show/persistGraph" },
      }, vfsHookOptions),
      "persistGraph",
      "Codex graph show/persistGraph",
    );
    assertHookContains(
      runHookResult(codexPreTool, {
        ...hookBase,
        tool_input: { command: "cat ~/.memoree/memory/graph/impact/writeSnapshot" },
      }, vfsHookOptions),
      "persistGraph",
      "Codex graph impact/writeSnapshot",
    );
    assertHookContains(
      runHookResult(codexPreTool, {
        ...hookBase,
        tool_input: { command: "cat ~/.memoree/memory/graph/neighborhood/src/snapshot.ts" },
      }, vfsHookOptions),
      "persistGraph",
      "Codex graph neighborhood/src/snapshot.ts",
    );
    assertHookContains(
      runHookResult(codexPreTool, {
        ...hookBase,
        tool_input: { command: "cat ~/.memoree/memory/graph/layers" },
      }, vfsHookOptions),
      "Core",
      "Codex graph layers",
    );
    assertHookContains(
      runHookResult(codexPreTool, {
        ...hookBase,
        tool_input: { command: "cat ~/.memoree/memory/graph/tour" },
      }, vfsHookOptions),
      "writeSnapshot",
      "Codex graph tour",
    );
    assertHookContains(
      runHookResult(codexPreTool, {
        ...hookBase,
        tool_input: { command: "cat ~/.memoree/memory/graph/path/writeSnapshot/persistGraph" },
      }, vfsHookOptions),
      "persistGraph",
      "Codex graph path/writeSnapshot/persistGraph",
    );

    status("checking SessionStart, docs VFS, and graph-on-stop hooks");
    const claudeSessionStart = runHookResult(join(claudeBundle, "session-start.js"), {
      session_id: crypto.randomUUID(),
      cwd: repository,
      hook_event_name: "SessionStart",
    }, { cwd: repository, env });
    assertHookExitZero(claudeSessionStart, "Claude SessionStart");
    assert(
      claudeSessionStart.stdout.includes("additionalContext") && /Memoree/i.test(claudeSessionStart.stdout),
      `Claude SessionStart missing Memoree additionalContext; stdout=${JSON.stringify(claudeSessionStart.stdout).slice(0, 800)}`,
    );
    assertHookExitZero(runHookResult(join(claudeBundle, "session-start-setup.js"), {
      session_id: crypto.randomUUID(),
      cwd: repository,
      hook_event_name: "SessionStart",
    }, { cwd: repository, env }), "Claude SessionStart setup");
    const codexSessionStart = runHookResult(join(codexBundle, "session-start.js"), {
      session_id: crypto.randomUUID(),
      cwd: repository,
      hook_event_name: "SessionStart",
      source: "startup",
      model: "runtime-validation",
    }, { cwd: repository, env });
    assertHookExitZero(codexSessionStart, "Codex SessionStart");
    assertHookExitZero(runHookResult(join(codexBundle, "session-start-setup.js"), {
      session_id: crypto.randomUUID(),
      cwd: repository,
      hook_event_name: "SessionStart",
      source: "startup",
      model: "runtime-validation",
    }, { cwd: repository, env }), "Codex SessionStart setup");
    const docsIndex = runHookResult(codexPreTool, {
      ...hookBase,
      tool_input: { command: "cat ~/.memoree/memory/docs/index.md" },
    }, vfsHookOptions);
    assertHookContains(docsIndex, "Docs Index", "docs VFS index");
    const docsFind = runHookResult(codexPreTool, {
      ...hookBase,
      tool_input: { command: "cat ~/.memoree/memory/docs/find/snapshot" },
    }, vfsHookOptions);
    assert(
      docsFind.status === 0 && (hookBodyContains(docsFind.stdout, "No docs match") || hookBodyContains(docsFind.stdout, "doc(s) match")),
      `docs VFS find/ failed: ${docsFind.stderr || docsFind.stdout}`,
    );
    assertHookExitZero(runHookResult(join(claudeBundle, "graph-on-stop.js"), {
      cwd: repository,
      hook_event_name: "Stop",
    }, { cwd: repository, env: { ...env, MEMOREE_GRAPH_TICK_INTERVAL_MS: "0" } }), "Claude graph-on-stop");
    assertHookExitZero(runHookResult(join(codexBundle, "graph-on-stop.js"), {
      cwd: repository,
      hook_event_name: "Stop",
    }, { cwd: repository, env: { ...env, MEMOREE_GRAPH_TICK_INTERVAL_MS: "0" } }), "Codex graph-on-stop");

    const claudeSession = crypto.randomUUID();
    const claudePrompt = `Repeat this exact private test fact: ${semanticFact}`;
    status("running an authenticated Claude Code capture turn");
    let claudeResponse = "";
    /** @type {unknown} */
    let captureTurnError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      claudeResponse = run("claude", [
        "-p", claudePrompt,
        "--bare",
        "--safe-mode",
        "--tools", "",
        "--settings", claudeSettings,
        "--output-format", "text",
        "--no-session-persistence",
        "--session-id", attempt === 0 ? claudeSession : crypto.randomUUID(),
      ], { cwd: repository, env: claudeEnv });
      try {
        assertAgentResponseContainsIdentifier(
          claudeResponse,
          semanticIdentifier,
          "Claude Code capture turn",
        );
        captureTurnError = null;
        break;
      } catch (error) {
        captureTurnError = error;
      }
    }
    if (captureTurnError) throw captureTurnError;

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
    const postToolMarker = crypto.randomUUID();
    runHook(join(claudeBundle, "capture.js"), {
      session_id: claudeSession,
      cwd: repository,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "runtime-validation-post",
      tool_input: { command: `echo ${postToolMarker}` },
      tool_response: { stdout: postToolMarker },
    }, claudeHookOptions);
    runHook(join(claudeBundle, "capture.js"), {
      session_id: claudeSession,
      cwd: repository,
      hook_event_name: "SubagentStop",
      last_assistant_message: `subagent recorded ${postToolMarker}`,
    }, claudeHookOptions);
    runHook(join(claudeBundle, "session-end.js"), {
      session_id: claudeSession,
      cwd: repository,
      hook_event_name: "SessionEnd",
    }, claudeHookOptions);
    assertHookExitZero(runHookResult(join(claudeBundle, "plugin-cache-gc.js"), {
      session_id: claudeSession,
      cwd: repository,
      hook_event_name: "SessionEnd",
    }, claudeHookOptions), "Claude plugin-cache-gc");

    status("waiting for the Claude Code summary");
    // Summaries are semantic by design and may paraphrase the sentence around
    // the value. The unique UUID is the durable, non-derivable proof that the
    // generated summary retained the captured fact.
    await waitForCapture(databasePath, semanticIdentifier, { requireSummary: true });
    {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const captured = db.prepare("SELECT message FROM sessions").all()
          .map(row => String(row.message ?? "")).join("\n");
        assert(captured.includes(postToolMarker), "PostToolUse/SubagentStop capture did not persist");
      } finally {
        db.close();
      }
    }

    status("checking Claude proactive recall hook");
    /** @type {{ status: number | null, stdout: string, stderr: string }} */
    let recallResult = { status: 1, stdout: "", stderr: "" };
    for (let attempt = 0; attempt < 8; attempt++) {
      // Use a fresh session id so recall does not exclude the captured summary
      // (`excludePath` is `/summaries/<user>/<session_id>.md`).
      recallResult = runHookResult(join(claudeBundle, "recall.js"), {
        session_id: crypto.randomUUID(),
        cwd: repository,
        hook_event_name: "UserPromptSubmit",
        prompt: "Remember the unusual observatory lantern from prior Memoree work. What exact identifier did we record?",
      }, { cwd: repository, env });
      if (recallResult.status === 0 && recallResult.stdout.includes(semanticIdentifier)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    assertHookExitZero(recallResult, "Claude recall");
    assert(
      recallResult.stdout.includes(semanticIdentifier),
      `Claude recall did not inject the captured identifier; stdout=${JSON.stringify(recallResult.stdout).slice(0, 1200)}`,
    );

    status("checking Claude Grep and Glob intercepts");
    retryHookUntilContains(
      () => runHookResult(claudePreTool, {
        session_id: crypto.randomUUID(),
        cwd: repository,
        hook_event_name: "PreToolUse",
        tool_name: "Grep",
        tool_use_id: "runtime-validation-grep",
        tool_input: { path: "~/.memoree/memory", pattern: semanticIdentifier },
      }, vfsHookOptions),
      semanticIdentifier,
      "Claude Grep memory",
    );
    retryHookUntilContains(
      () => runHookResult(claudePreTool, {
        session_id: crypto.randomUUID(),
        cwd: repository,
        hook_event_name: "PreToolUse",
        tool_name: "Glob",
        tool_use_id: "runtime-validation-glob",
        tool_input: { path: "~/.memoree/memory/" },
      }, vfsHookOptions),
      "identity.json",
      "Claude Glob memory",
    );

    const recallEnv = { ...env, MEMOREE_CAPTURE: "false" };
    const lexicalEnv = { ...env, MEMOREE_EMBEDDINGS: "false" };
    if (!skipLiveCodex) {
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
    } else {
      status("skipping live Codex exec (--skip-live-codex)");
    }

    const lexicalMarker = skipLiveCodex ? semanticIdentifier : lexicalIdentifier;
    status("checking lexical fallback recall through Claude Code");
    const lexicalRecall = run("claude", [
      "-p",
      skipLiveCodex
        ? `Search Memoree lexically for marker ${semanticIdentifier} and answer with only the matching identifier.`
        : `Search Memoree lexically for marker ${lexicalIdentifier} and answer with only the matching identifier.`,
      ...(skipLiveCodex ? ["--bare"] : []),
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
      lexicalMarker,
      "Claude Code lexical fallback recall",
    );

    const counts = inspectDatabase(
      databasePath,
      semanticFact,
      semanticIdentifier,
      skipLiveCodex ? null : lexicalIdentifier,
    );
    process.stdout.write(
      skipLiveCodex
        ? `Runtime validation passed without live Codex exec: ${counts.events} events, ${counts.summaries} summaries, SQLite integrity/WAL, 768-d embeddings, graph query/find/show/impact/neighborhood/layers/tour/path, KPI VFS, Claude capture/summary/recall/Grep/Glob/lexical recall.\n`
        : `Runtime validation passed: ${counts.events} events, ${counts.summaries} summaries, SQLite integrity/WAL, 768-d embeddings, semantic and lexical cross-agent recall.\n`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  await validateRuntime({ skipLiveCodex: skipLiveCodexRequested() });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`memoree runtime validation: ${error.message}\n`);
    process.exitCode = 1;
  });
}
