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
  const result = spawnSync(process.execPath, [bundlePath, ...(options.hookArgs ?? [])], {
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

export { run, assert, status, runCodex, removeValidationWorkspace };

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

export const CLAUDE_LEXICAL_RECALL_ATTEMPTS = 3;

export function claudeLexicalRecallPrompt(identifier) {
  return [
    `Search Memoree lexically for the exact validation identifier ${identifier}.`,
    `Use grep against ~/.memoree/memory/ for that exact UUID.`,
    "Reply with only that UUID. Do not invent a UUID. Do not return any other UUID from this session.",
  ].join(" ");
}

export function codexSemanticRecallPrompt() {
  return [
    "Search Memoree memory for the unusual observatory lantern and its exact identifier.",
    "Use the shell: grep -ri \"observatory lantern\" ~/.memoree/memory/summaries/",
    "Answer with only the matching UUID. Do not invent an identifier. Do not say none was provided.",
  ].join("\n");
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

function removeValidationWorkspace(root) {
  /** @type {unknown} */
  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "ENOTEMPTY" && code !== "EBUSY" && code !== "EPERM") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  throw lastError;
}

export function classifyAgentCommandError(error) {
  const text = [
    error instanceof Error ? error.message : String(error ?? ""),
    typeof error === "object" && error && "cause" in error && error.cause instanceof Error ? error.cause.message : "",
  ].join("\n");
  if (/no credits remaining/i.test(text) || /insufficient.?quota/i.test(text)) {
    return "External dependency (Codex API credits): add credits at https://platform.openai.com/settings/organization/billing/ and retry runtime:validate.";
  }
  if (/RESOURCE_EXHAUSTED|quota exceeded|gemini.+quota/i.test(text)) {
    return "External dependency (Gemini API quota): retry later or skip with --skip-live-antigravity.";
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

export function skipLiveAntigravityRequested(argv = process.argv, env = process.env) {
  return argv.includes("--skip-live-antigravity") || env.MEMOREE_VALIDATION_SKIP_LIVE_ANTIGRAVITY === "1";
}

export function antigravityCliAvailable() {
  try {
    execFileSync("agy", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Isolated-HOME only. Never writes the operator ~/.gemini settings. */
export function writeIsolatedAntigravityGeminiSettings(isolatedHome) {
  const dir = join(isolatedHome, ".gemini", "antigravity-cli");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ modelProvider: "gemini" }, null, 2)}\n`);
}

export function antigravityLivePrompt(identifier) {
  return [
    "You have Memoree MCP tools.",
    "You MUST call memoree_read with path identity.json.",
    "Then call memoree_ls with path \"\" (the memory root).",
    `Then call memoree_write with path rules/active/${identifier}.md and content exactly ${identifier}.`,
    `Then call memoree_grep with pattern ${identifier} and path rules.`,
    `Repeat this exact lexical fallback marker identifier: ${identifier}`,
    "Include that UUID in your final answer. Do not invent a different UUID.",
  ].join(" ");
}

export function assertAntigravityLiveUsedMcp(isolatedHome, agyResponse) {
  assert(!/do not have access to the `memoree_read`/i.test(agyResponse),
    `Live Antigravity did not receive Memoree MCP tools; response=${String(agyResponse).slice(0, 400)}`);
  const roots = [
    join(isolatedHome, ".gemini", "antigravity-cli", "brain"),
    join(isolatedHome, ".gemini", "antigravity-cli", "log"),
    join(isolatedHome, ".gemini", "antigravity-cli", "conversations"),
    join(isolatedHome, ".gemini", "antigravity-cli", "mcp"),
  ].filter(existsSync);
  let text = "";
  if (roots.length > 0) {
    try {
      text = execFileSync("grep", ["-R", "--include=*.jsonl", "--include=*.log", "--include=*.txt", "--include=*.json", "call_mcp_tool\\|memoree_read\\|memoree_write\\|memoree_grep", ...roots], {
        encoding: "utf8",
        timeout: 10_000,
      });
    } catch {
      text = "";
    }
  }
  assert(/call_mcp_tool/.test(text) && /memoree_read/.test(text),
    "Live Antigravity did not call memoree_read via MCP; tools were not used");
  assert(/memoree_write/.test(text) && /memoree_grep/.test(text),
    "Live Antigravity did not call memoree_write and memoree_grep; lifecycle tools were not used");
}

export function encodeMcpStdio(msg, framing = "ndjson") {
  const body = JSON.stringify(msg);
  if (framing === "content-length") {
    return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  }
  return `${body}\n`;
}

export function parseMcpFramedMessages(stdout) {
  const text = String(stdout ?? "");
  if (/Content-Length:\s*\d+/i.test(text)) {
    const messages = [];
    let rest = text;
    while (true) {
      const idx = rest.search(/Content-Length:\s*\d+/i);
      if (idx < 0) break;
      rest = rest.slice(idx);
      const header = /^(Content-Length:\s*(\d+)\r\n\r\n)/i.exec(rest)
        ?? /^(Content-Length:\s*(\d+)\n\n)/i.exec(rest);
      if (!header) break;
      const length = Number(header[2]);
      const start = header[1].length;
      const json = rest.slice(start, start + length);
      rest = rest.slice(start + length);
      try {
        messages.push(JSON.parse(json));
      } catch {
        /* ignore a truncated frame */
      }
    }
    return messages;
  }
  const messages = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      messages.push(JSON.parse(trimmed));
    } catch {
      /* ignore a truncated line */
    }
  }
  return messages;
}

export function callMemoreeMcpTool(serverPath, name, args, options) {
  const framing = options.framing ?? "ndjson";
  const frames = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
  ].map(msg => encodeMcpStdio(msg, framing)).join("");
  const result = spawnSync(process.execPath, [serverPath], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: frames,
    timeout: options.timeout ?? 20_000,
  });
  const messages = parseMcpFramedMessages(result.stdout ?? "");
  const reply = [...messages].reverse().find(msg => msg && msg.id === 2);
  const text = String(reply?.result?.content?.[0]?.text ?? "");
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ok: result.status === 0 && reply?.result?.isError !== true,
    text,
    isError: reply?.result?.isError === true,
  };
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
  return inspectCaptureDatabase(databasePath, {
    requireInEvents: lexicalIdentifier ? [semanticFact, lexicalIdentifier] : [semanticFact],
    requireInSummaries: lexicalIdentifier ? [semanticIdentifier, lexicalIdentifier] : [semanticIdentifier],
    emptyEventsMessage: "No runtime validation events were captured",
    emptySummariesMessage: "No runtime validation summaries were generated",
  });
}

export function inspectCaptureDatabase(databasePath, options = {}) {
  const requireInEvents = options.requireInEvents ?? [];
  const requireInSummaries = options.requireInSummaries ?? [];
  const requireInEventsOrSummaries = options.requireInEventsOrSummaries ?? [];
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
    const journal = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
    const events = db.prepare("SELECT message, message_embedding FROM sessions ORDER BY creation_date").all();
    const summaries = db.prepare("SELECT summary, summary_embedding FROM memory WHERE path LIKE '/summaries/%'").all();
    assert(String(integrity).toLowerCase() === "ok", "SQLite integrity_check failed");
    assert(String(journal).toLowerCase() === "wal", "SQLite is not in WAL mode");
    assert(events.length > 0, options.emptyEventsMessage ?? "No session events were captured");
    assert(summaries.length > 0, options.emptySummariesMessage ?? "No summaries were generated");
    const eventText = events.map(row => String(row.message ?? "")).join("\n");
    const summaryText = summaries.map(row => String(row.summary ?? "")).join("\n");
    const combined = `${eventText}\n${summaryText}`;
    for (const needle of requireInEvents) {
      assert(eventText.includes(needle), `Missing from isolated session events: ${needle}`);
    }
    for (const needle of requireInSummaries) {
      assert(summaryText.includes(needle), `Missing from isolated summaries: ${needle}`);
    }
    for (const needle of requireInEventsOrSummaries) {
      assert(
        combined.includes(needle),
        `Missing from isolated sessions/summaries: ${needle}`,
      );
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
  const skipLiveAntigravity = options.skipLiveAntigravity === true;
  assertNoActiveAgentSessions();
  const { runtimeDir } = runtimePaths();
  const cli = join(runtimeDir, "bundle", "cli.js");
  const claudeBundle = join(runtimeDir, "harnesses", "claude-code", "bundle");
  const codexBundle = join(runtimeDir, "harnesses", "codex", "bundle");
  const antigravityBundle = join(runtimeDir, "harnesses", "antigravity", "bundle");
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
    join(codexBundle, "session-end.js"),
    join(codexBundle, "recall.js"),
    join(codexBundle, "graph-on-stop.js"),
    join(codexBundle, "pre-tool-use.js"),
    join(codexBundle, "command", "memoree.js"),
    join(antigravityBundle, "pre-invocation.js"),
    join(antigravityBundle, "pre-tool-use.js"),
    join(antigravityBundle, "capture.js"),
    join(antigravityBundle, "stop.js"),
    join(antigravityBundle, "mcp-server.js"),
    join(antigravityBundle, "graph-on-stop.js"),
    join(antigravityBundle, "session-start-setup.js"),
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
    MEMOREE_RECALL_THRESHOLD: "0.4",
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
      "When the current user message already contains a test identifier UUID, repeat that exact UUID. Do not invent identifiers.",
      "When asked to recall a fact from Memoree, search ~/.memoree/memory with grep or cat and answer with the matching identifier.",
      "",
    ].join("\n"));

    status("checking the isolated SQLite backend");
    run(process.execPath, [cli, "backend", "check"], { cwd: repository, env });
    const embeddingsStatus = run(process.execPath, [cli, "embeddings", "status"], { cwd: repository, env });
    assert(
      /embeddings\.enabled|Shared deps/i.test(embeddingsStatus),
      `memoree embeddings status did not report config; stdout=${JSON.stringify(embeddingsStatus).slice(0, 800)}`,
    );

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
    status("checking rules/goal/kpi CLI");
    const rulesList = run(process.execPath, [cli, "rules", "list", "--status", "all"], { cwd: repository, env });
    assert(rulesList.includes(ruleId), `memoree rules list missed ${ruleId}; stdout=${JSON.stringify(rulesList).slice(0, 800)}`);
    const goalsList = run(process.execPath, [cli, "goal", "list", "--all"], { cwd: repository, env });
    assert(goalsList.includes(goalId), `memoree goal list missed ${goalId}; stdout=${JSON.stringify(goalsList).slice(0, 800)}`);
    const kpisList = run(process.execPath, [cli, "kpi", "list", goalId], { cwd: repository, env });
    assert(kpisList.includes(kpiId), `memoree kpi list missed ${kpiId}; stdout=${JSON.stringify(kpisList).slice(0, 800)}`);
    const skillifyStatus = run(process.execPath, [cli, "skillify"], { cwd: repository, env });
    assert(/scope:/i.test(skillifyStatus), `memoree skillify did not print scope; stdout=${JSON.stringify(skillifyStatus).slice(0, 800)}`);
    status("checking memoree context diagnostic");
    run(process.execPath, [cli, "context"], { cwd: repository, env });

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
    const graphHistory = run(process.execPath, [cli, "graph", "history", "--cwd", repository], { cwd: repository, env });
    assert(
      /history\.jsonl|snapshot/i.test(graphHistory),
      `memoree graph history did not record the fixture build; stdout=${JSON.stringify(graphHistory).slice(0, 800)}`,
    );
    status("checking docs CLI and docs VFS leaf");
    const docsSet = run(process.execPath, [
      cli, "docs", "set", "src/snapshot.ts",
      "persistGraph writes snapshot bytes for the runtime validation fixture.",
    ], { cwd: repository, env });
    assert(/Set doc/i.test(docsSet), `memoree docs set failed; stdout=${JSON.stringify(docsSet).slice(0, 800)}`);
    const docsShow = run(process.execPath, [cli, "docs", "show", "src/snapshot.ts"], { cwd: repository, env });
    assert(docsShow.includes("persistGraph"), `memoree docs show missed persistGraph; stdout=${JSON.stringify(docsShow).slice(0, 800)}`);

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
    const writeDeny = runHookResult(claudePreTool, {
      session_id: crypto.randomUUID(),
      cwd: repository,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_use_id: "runtime-validation-write-deny",
      tool_input: { file_path: "~/.memoree/memory/identity.json", content: "{}" },
    }, vfsHookOptions);
    assertHookExitZero(writeDeny, "Claude Write deny");
    assert(
      writeDeny.stdout.includes("permissionDecision") && writeDeny.stdout.includes("deny"),
      `Claude Write on identity.json was not denied; stdout=${JSON.stringify(writeDeny.stdout).slice(0, 800)}`,
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
    status("checking Antigravity PreToolUse steer, Stop, and PreInvocation");
    const agySteer = runHookResult(join(antigravityBundle, "pre-tool-use.js"), {
      toolCall: { name: "run_command", args: { CommandLine: "cat ~/.memoree/memory/identity.json" } },
    }, { cwd: repository, env, hookArgs: ["PreToolUse"] });
    assertHookExitZero(agySteer, "Antigravity PreToolUse steer");
    const agySteerBody = JSON.parse(agySteer.stdout.trim() || "{}");
    assert(agySteerBody.decision === "deny" && typeof agySteerBody.reason === "string",
      `Antigravity PreToolUse must deny the mount; stdout=${agySteer.stdout.slice(0, 400)}`);
    assert(agySteerBody.decision !== "allow", "Antigravity PreToolUse must never return allow");
    const agyPass = runHookResult(join(antigravityBundle, "pre-tool-use.js"), {
      toolCall: { name: "run_command", args: { CommandLine: "ls /tmp" } },
    }, { cwd: repository, env, hookArgs: ["PreToolUse"] });
    assertHookExitZero(agyPass, "Antigravity PreToolUse unrelated");
    assert(JSON.parse(agyPass.stdout.trim() || "{}").decision === undefined,
      `Antigravity PreToolUse must leave unrelated tools alone; stdout=${agyPass.stdout.slice(0, 400)}`);
    const agyStop = runHookResult(join(antigravityBundle, "stop.js"), {}, {
      cwd: repository, env, hookArgs: ["Stop"],
    });
    assertHookExitZero(agyStop, "Antigravity Stop");
    assert(JSON.parse(agyStop.stdout.trim() || "{}").decision === "stop",
      `Antigravity Stop must not continue; stdout=${agyStop.stdout.slice(0, 400)}`);
    const agyPre = runHookResult(join(antigravityBundle, "pre-invocation.js"), {
      conversationId: crypto.randomUUID(),
      invocationNum: 0,
      workspacePaths: [repository],
    }, { cwd: repository, env: { ...env, MEMOREE_WIKI_WORKER: "1" }, hookArgs: ["PreInvocation"] });
    assertHookExitZero(agyPre, "Antigravity PreInvocation wiki-worker short-circuit");
    const mcpServer = join(antigravityBundle, "mcp-server.js");
    const mcpNdjsonInit = spawnSync(process.execPath, [mcpServer], {
      cwd: repository,
      env,
      encoding: "utf8",
      input: encodeMcpStdio({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "agy", version: "0" } },
      }, "ndjson"),
      timeout: 10_000,
    });
    assert((mcpNdjsonInit.stdout ?? "").includes('"name":"memoree"'),
      `Antigravity MCP NDJSON initialize failed: status=${mcpNdjsonInit.status} stdout=${(mcpNdjsonInit.stdout ?? "").slice(0, 400)} stderr=${(mcpNdjsonInit.stderr ?? "").slice(0, 400)}`);
    assert(!(mcpNdjsonInit.stdout ?? "").includes("Content-Length"),
      "Antigravity MCP must reply to NDJSON (agy stdio) with NDJSON, not Content-Length");
    const mcpClInit = spawnSync(process.execPath, [mcpServer], {
      cwd: repository,
      env,
      encoding: "utf8",
      input: encodeMcpStdio({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "content-length"),
      timeout: 10_000,
    });
    assert((mcpClInit.stdout ?? "").includes("memoree"),
      `Antigravity MCP Content-Length initialize failed: status=${mcpClInit.status} stdout=${(mcpClInit.stdout ?? "").slice(0, 400)}`);
    status("checking Antigravity MCP VFS (same commands as Claude/Codex intercept)");
    const mcpOpts = { cwd: repository, env };
    const mcpIdentity = callMemoreeMcpTool(mcpServer, "memoree_read", { path: "identity.json" }, mcpOpts);
    assert(mcpIdentity.ok && mcpIdentity.text.includes("runtime-validation"),
      `Antigravity MCP memoree_read identity failed: ${mcpIdentity.text.slice(0, 400)}`);
    const mcpGraph = callMemoreeMcpTool(mcpServer, "memoree_read", { path: "graph/query/store" }, mcpOpts);
    assert(mcpGraph.ok && mcpGraph.text.includes("persistGraph"),
      `Antigravity MCP graph/query/store missed persistGraph: ${mcpGraph.text.slice(0, 400)}`);
    const mcpLs = callMemoreeMcpTool(mcpServer, "memoree_ls", { path: "" }, mcpOpts);
    assert(mcpLs.ok && /identity\.json|rules\.md/.test(mcpLs.text),
      `Antigravity MCP ls missed inventory: ${mcpLs.text.slice(0, 400)}`);
    assert(!/"userName"/.test(mcpLs.text),
      `Antigravity MCP ls must not dump identity.json body: ${mcpLs.text.slice(0, 400)}`);
    const mcpHead = callMemoreeMcpTool(mcpServer, "memoree_head", { path: "identity.json", lines: 2 }, mcpOpts);
    assert(mcpHead.ok && mcpHead.text.includes("userName"),
      `Antigravity MCP head missed the start of identity.json: ${mcpHead.text.slice(0, 400)}`);
    assert(mcpHead.text !== mcpIdentity.text,
      "Antigravity MCP head must be a prefix, not the whole identity.json");
    const mcpFind = callMemoreeMcpTool(mcpServer, "memoree_find", { path: "", name: "identity.json" }, mcpOpts);
    assert(mcpFind.ok && mcpFind.text.includes("identity.json"),
      `Antigravity MCP find missed identity.json: ${mcpFind.text.slice(0, 400)}`);
    const mcpRuleId = crypto.randomUUID();
    const mcpRuleText = `antigravity mcp rule ${crypto.randomUUID()}`;
    const mcpWrite = callMemoreeMcpTool(mcpServer, "memoree_write", {
      path: `rules/active/${mcpRuleId}.md`,
      content: mcpRuleText,
    }, mcpOpts);
    assert(mcpWrite.ok, `Antigravity MCP write failed: ${mcpWrite.text.slice(0, 400)}`);
    const mcpReadRule = callMemoreeMcpTool(mcpServer, "memoree_read", { path: `rules/active/${mcpRuleId}.md` }, mcpOpts);
    assert(mcpReadRule.ok && mcpReadRule.text.includes(mcpRuleText),
      `Antigravity MCP read-after-write missed rule: ${mcpReadRule.text.slice(0, 400)}`);
    const mcpGrep = callMemoreeMcpTool(mcpServer, "memoree_grep", { pattern: "antigravity mcp rule", path: "rules" }, mcpOpts);
    assert(mcpGrep.ok && mcpGrep.text.includes(mcpRuleText),
      `Antigravity MCP grep missed rule: ${mcpGrep.text.slice(0, 400)}`);
    const mcpTail = callMemoreeMcpTool(mcpServer, "memoree_tail", { path: "identity.json", lines: 2 }, mcpOpts);
    assert(mcpTail.ok && mcpTail.text.includes("backend"),
      `Antigravity MCP tail missed the end of identity.json: ${mcpTail.text.slice(0, 400)}`);
    assert(mcpTail.text !== mcpHead.text,
      "Antigravity MCP tail must differ from head on identity.json");
    assert(!mcpTail.text.includes("userName"),
      `Antigravity MCP tail must not include the start of identity.json: ${mcpTail.text.slice(0, 400)}`);
    const mcpWc = callMemoreeMcpTool(mcpServer, "memoree_wc", { path: "identity.json" }, mcpOpts);
    assert(mcpWc.ok && /^\s*\d+\b/.test(mcpWc.text) && !mcpWc.text.includes("runtime-validation"),
      `Antigravity MCP wc must be a count, not the file body: ${mcpWc.text.slice(0, 400)}`);
    const mcpJq = callMemoreeMcpTool(mcpServer, "memoree_jq", { path: "identity.json", filter: ".userName" }, mcpOpts);
    assert(mcpJq.ok && mcpJq.text.includes("runtime-validation"),
      `Antigravity MCP jq missed userName: ${mcpJq.text.slice(0, 400)}`);
    assert(!/organization|workspace/.test(mcpJq.text),
      `Antigravity MCP jq .userName must not dump the rest of identity.json: ${mcpJq.text.slice(0, 400)}`);
    const mcpMv = callMemoreeMcpTool(mcpServer, "memoree_mv", {
      from: `rules/active/${mcpRuleId}.md`,
      to: `rules/done/${mcpRuleId}.md`,
    }, mcpOpts);
    assert(mcpMv.ok, `Antigravity MCP mv failed: ${mcpMv.text.slice(0, 400)}`);
    const mcpReadDone = callMemoreeMcpTool(mcpServer, "memoree_read", { path: `rules/done/${mcpRuleId}.md` }, mcpOpts);
    assert(mcpReadDone.ok && mcpReadDone.text.includes(mcpRuleText),
      `Antigravity MCP read after mv missed rule: ${mcpReadDone.text.slice(0, 400)}`);
    const mcpRm = callMemoreeMcpTool(mcpServer, "memoree_rm", { path: `rules/done/${mcpRuleId}.md` }, mcpOpts);
    assert(mcpRm.ok, `Antigravity MCP rm failed: ${mcpRm.text.slice(0, 400)}`);

    status("checking Antigravity PreInvocation capture + inject");
    const agyCaptureId = crypto.randomUUID();
    const agyTranscript = join(state, "agy-transcript.jsonl");
    writeFileSync(agyTranscript, `${JSON.stringify({ role: "user", text: `remember marker ${agyCaptureId}` })}\n`);
    const agyPreLive = runHookResult(join(antigravityBundle, "pre-invocation.js"), {
      conversationId: agyCaptureId,
      invocationNum: 0,
      workspacePaths: [repository],
      transcriptPath: agyTranscript,
    }, { cwd: repository, env, hookArgs: ["PreInvocation"] });
    assertHookExitZero(agyPreLive, "Antigravity PreInvocation capture");
    const agyPreBody = JSON.parse(agyPreLive.stdout.trim() || "{}");
    assert(Array.isArray(agyPreBody.injectSteps) && agyPreBody.injectSteps.length > 0,
      `Antigravity PreInvocation must inject memory context; stdout=${agyPreLive.stdout.slice(0, 400)}`);
    assertHookExitZero(runHookResult(join(antigravityBundle, "capture.js"), {
      conversationId: agyCaptureId,
      workspacePaths: [repository],
      toolCall: { name: "run_command", args: { CommandLine: "echo hi" } },
    }, { cwd: repository, env, hookArgs: ["PostToolUse"] }), "Antigravity PostToolUse capture");
    {
      const captured = isolatedCounts(databasePath, agyCaptureId);
      assert(captured.matchingEvents > 0,
        `Antigravity PreInvocation did not persist the user marker; events=${captured.matchingEvents}`);
    }
    const docsIndex = runHookResult(codexPreTool, {
      ...hookBase,
      tool_input: { command: "cat ~/.memoree/memory/docs/index.md" },
    }, vfsHookOptions);
    assertHookContains(docsIndex, "Docs Index", "docs VFS index");
    assertHookContains(
      runHookResult(codexPreTool, {
        ...hookBase,
        tool_input: { command: "cat ~/.memoree/memory/docs/src/snapshot.ts.md" },
      }, vfsHookOptions),
      "persistGraph",
      "docs VFS leaf src/snapshot.ts.md",
    );
    retryHookUntilContains(
      () => runHookResult(codexPreTool, {
        ...hookBase,
        tool_input: { command: "cat ~/.memoree/memory/docs/find/persistGraph" },
      }, vfsHookOptions),
      "persistGraph",
      "docs VFS find/persistGraph",
    );
    assertHookExitZero(runHookResult(join(claudeBundle, "graph-on-stop.js"), {
      cwd: repository,
      hook_event_name: "Stop",
    }, { cwd: repository, env: { ...env, MEMOREE_GRAPH_TICK_INTERVAL_MS: "0" } }), "Claude graph-on-stop");
    assertHookExitZero(runHookResult(join(codexBundle, "graph-on-stop.js"), {
      cwd: repository,
      hook_event_name: "Stop",
    }, { cwd: repository, env: { ...env, MEMOREE_GRAPH_TICK_INTERVAL_MS: "0" } }), "Codex graph-on-stop");
    assertHookExitZero(runHookResult(join(antigravityBundle, "graph-on-stop.js"), {
      cwd: repository,
      hook_event_name: "Stop",
    }, { cwd: repository, env: { ...env, MEMOREE_GRAPH_TICK_INTERVAL_MS: "0" } }), "Antigravity graph-on-stop");

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

    status("checking memory index.md and summary VFS");
    retryHookUntilContains(
      () => runHookResult(codexPreTool, {
        ...hookBase,
        tool_input: { command: "cat ~/.memoree/memory/index.md" },
      }, vfsHookOptions),
      "Session Index",
      "memory index.md",
    );
    retryHookUntilContains(
      () => runHookResult(codexPreTool, {
        ...hookBase,
        tool_input: { command: `cat ~/.memoree/memory/summaries/runtime-validation/${claudeSession}.md` },
      }, vfsHookOptions),
      semanticIdentifier,
      "memory summary leaf",
    );
    retryHookUntilContains(
      () => runHookResult(codexPreTool, {
        ...hookBase,
        tool_input: { command: "ls ~/.memoree/memory/sessions" },
      }, vfsHookOptions),
      "runtime-validation",
      "memory sessions listing",
    );

    status("checking sessions prune dry-run and memory backfill dry-run");
    const pruneList = run(process.execPath, [cli, "sessions", "prune"], { cwd: repository, env });
    assert(
      /Sessions for|No sessions found/i.test(pruneList),
      `memoree sessions prune did not list sessions; stdout=${JSON.stringify(pruneList).slice(0, 800)}`,
    );
    const backfillPlan = run(process.execPath, [cli, "memory", "backfill", "--dry-run"], { cwd: repository, env });
    assert(
      backfillPlan.trim().length > 0,
      `memoree memory backfill --dry-run produced no output`,
    );

    status("checking Claude proactive recall hook");
    /** @type {{ status: number | null, stdout: string, stderr: string }} */
    let recallResult = { status: 1, stdout: "", stderr: "" };
    for (let attempt = 0; attempt < 20; attempt++) {
      // Use a fresh session id so recall does not exclude the captured summary
      // (`excludePath` is `/summaries/<user>/<session_id>.md`).
      recallResult = runHookResult(join(claudeBundle, "recall.js"), {
        session_id: crypto.randomUUID(),
        cwd: repository,
        hook_event_name: "UserPromptSubmit",
        prompt: "Remember the unusual observatory lantern from prior Memoree work. What exact identifier did we record?",
      }, { cwd: repository, env });
      if (recallResult.status === 0 && recallResult.stdout.includes(semanticIdentifier)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    }
    assertHookExitZero(recallResult, "Claude recall");
    assert(
      recallResult.stdout.includes(semanticIdentifier),
      `Claude recall did not inject the captured identifier; stdout=${JSON.stringify(recallResult.stdout).slice(0, 1200)}`,
    );

    status("checking Codex proactive recall hook");
    /** @type {{ status: number | null, stdout: string, stderr: string }} */
    let codexRecallResult = { status: 1, stdout: "", stderr: "" };
    for (let attempt = 0; attempt < 20; attempt++) {
      codexRecallResult = runHookResult(join(codexBundle, "recall.js"), {
        session_id: crypto.randomUUID(),
        cwd: repository,
        hook_event_name: "UserPromptSubmit",
        prompt: "Remember the unusual observatory lantern from prior Memoree work. What exact identifier did we record?",
      }, { cwd: repository, env });
      if (codexRecallResult.status === 0 && codexRecallResult.stdout.includes(semanticIdentifier)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    }
    assertHookExitZero(codexRecallResult, "Codex recall");
    assert(
      codexRecallResult.stdout.includes(semanticIdentifier),
      `Codex recall did not inject the captured identifier; stdout=${JSON.stringify(codexRecallResult.stdout).slice(0, 1200)}`,
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

    status("checking Codex capture, PostToolUse, SubagentStop, Stop, and SessionEnd hooks");
    const hookCodexSession = crypto.randomUUID();
    const hookCodexPrompt = lexicalValidationPrompt(lexicalIdentifier);
    const codexHookOptions = { cwd: repository, env };
    runHook(join(codexBundle, "capture.js"), {
      session_id: hookCodexSession,
      transcript_path: null,
      cwd: repository,
      hook_event_name: "UserPromptSubmit",
      model: "runtime-validation",
      prompt: hookCodexPrompt,
    }, codexHookOptions);
    runHook(join(codexBundle, "capture.js"), {
      session_id: hookCodexSession,
      transcript_path: null,
      cwd: repository,
      hook_event_name: "PostToolUse",
      model: "runtime-validation",
      tool_name: "Bash",
      tool_use_id: "runtime-validation-codex-post",
      tool_input: { command: `echo ${lexicalIdentifier}` },
      tool_response: { stdout: lexicalIdentifier },
    }, codexHookOptions);
    const codexSubagentMarker = crypto.randomUUID();
    runHook(join(codexBundle, "capture.js"), {
      session_id: hookCodexSession,
      transcript_path: null,
      cwd: repository,
      hook_event_name: "SubagentStop",
      model: "runtime-validation",
      last_assistant_message: `subagent recorded ${codexSubagentMarker}`,
    }, codexHookOptions);
    assertHookExitZero(runHookResult(join(codexBundle, "stop.js"), {
      session_id: hookCodexSession,
      transcript_path: null,
      cwd: repository,
      hook_event_name: "Stop",
      model: "runtime-validation",
    }, codexHookOptions), "Codex Stop");
    assertHookExitZero(runHookResult(join(codexBundle, "session-end.js"), {
      session_id: hookCodexSession,
      transcript_path: null,
      cwd: repository,
      hook_event_name: "SessionEnd",
      reason: "other",
    }, codexHookOptions), "Codex SessionEnd");
    {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const captured = db.prepare("SELECT message FROM sessions").all()
          .map(row => String(row.message ?? "")).join("\n");
        assert(captured.includes(lexicalIdentifier), "Codex capture/PostToolUse did not persist");
        assert(captured.includes(codexSubagentMarker), "Codex SubagentStop capture did not persist");
      } finally {
        db.close();
      }
    }

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
      let semanticRecall = "";
      /** @type {unknown} */
      let semanticRecallError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        semanticRecall = runCodex([
          "exec",
          "--skip-git-repo-check",
          "--ephemeral",
          "-s", "read-only",
          codexSemanticRecallPrompt(),
        ], { cwd: repository, env: recallEnv });
        try {
          assertAgentResponseContainsIdentifier(
            semanticRecall,
            semanticIdentifier,
            "Codex semantic recall",
          );
          semanticRecallError = null;
          break;
        } catch (error) {
          semanticRecallError = error;
        }
      }
      if (semanticRecallError) throw semanticRecallError;

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

    const geminiKey = typeof process.env.GEMINI_API_KEY === "string" ? process.env.GEMINI_API_KEY.trim() : "";
    const runLiveAntigravity = !skipLiveAntigravity
      && antigravityCliAvailable()
      && geminiKey.length > 0;
    if (runLiveAntigravity) {
      status("installing Antigravity hooks into the isolated profile");
      run(process.execPath, [cli, "antigravity", "install"], { cwd: repository, env });
      status("running an authenticated Antigravity capture turn (isolated HOME + GEMINI_API_KEY)");
      writeIsolatedAntigravityGeminiSettings(isolatedHome);
      const agyIdentifier = crypto.randomUUID();
      const agyPath = `${join(realHome, ".local", "bin")}:/tmp/agy-bin:${process.env.PATH ?? ""}`;
      const agyResponse = run("agy", [
        "-p",
        antigravityLivePrompt(agyIdentifier),
        "--dangerously-skip-permissions",
      ], { cwd: repository, env: { ...env, PATH: agyPath }, timeout: 180_000 });
      assertAgentResponseContainsIdentifier(
        agyResponse,
        agyIdentifier,
        "Antigravity capture turn",
      );
      assertAntigravityLiveUsedMcp(isolatedHome, agyResponse);
      status("waiting for the Antigravity unaided capture");
      await waitForCapture(databasePath, agyIdentifier, { requireSummary: false, timeoutMs: 60_000 });
    } else {
      status("skipping live Antigravity (agy missing, unsigned, or --skip-live-antigravity)");
    }

    if (skipLiveCodex) {
      // `--bare` skips hooks, so a live `claude -p` cannot search Memoree.
      // Prove the lexical path the product actually uses: Grep with embeddings off.
      status("checking lexical memory search through Claude Grep (embeddings off)");
      retryHookUntilContains(
        () => runHookResult(claudePreTool, {
          session_id: crypto.randomUUID(),
          cwd: repository,
          hook_event_name: "PreToolUse",
          tool_name: "Grep",
          tool_use_id: "runtime-validation-lexical-grep",
          tool_input: { path: "~/.memoree/memory", pattern: semanticIdentifier },
        }, { cwd: repository, env: { ...lexicalEnv, MEMOREE_CAPTURE: "false" } }),
        semanticIdentifier,
        "Claude lexical Grep",
      );
    } else {
      status("checking lexical fallback recall through Claude Code");
      let lexicalRecall = "";
      /** @type {unknown} */
      let lexicalRecallError = null;
      for (let attempt = 0; attempt < CLAUDE_LEXICAL_RECALL_ATTEMPTS; attempt++) {
        lexicalRecall = run("claude", [
          "-p",
          claudeLexicalRecallPrompt(lexicalIdentifier),
          "--append-system-prompt",
          "Reply with only the matching UUID. Do not read AGENTS.md or run unrelated tools.",
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
        try {
          assertAgentResponseContainsIdentifier(
            lexicalRecall,
            lexicalIdentifier,
            "Claude Code lexical fallback recall",
          );
          lexicalRecallError = null;
          break;
        } catch (error) {
          lexicalRecallError = error;
        }
      }
      if (lexicalRecallError) throw lexicalRecallError;
    }

    const counts = inspectDatabase(
      databasePath,
      semanticFact,
      semanticIdentifier,
      skipLiveCodex ? null : lexicalIdentifier,
    );
    process.stdout.write(
      skipLiveCodex
        ? `Runtime validation passed without live Codex exec: ${counts.events} events, ${counts.summaries} summaries, SQLite integrity/WAL, 768-d embeddings, graph query/find/show/impact/neighborhood/layers/tour/path, KPI VFS, memory index/summaries/sessions, docs set/show/find, rules/goal/kpi/skillify CLI, Claude capture/summary/recall/Grep/Glob/Write-deny, Codex capture/Stop, lexical Grep.\n`
        : `Runtime validation passed: ${counts.events} events, ${counts.summaries} summaries, SQLite integrity/WAL, 768-d embeddings, semantic and lexical cross-agent recall.\n`,
    );
  } finally {
    removeValidationWorkspace(root);
  }
}

async function main() {
  await validateRuntime({
    skipLiveCodex: skipLiveCodexRequested(),
    skipLiveAntigravity: skipLiveAntigravityRequested(),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`memoree runtime validation: ${error.message}\n`);
    process.exitCode = 1;
  });
}
