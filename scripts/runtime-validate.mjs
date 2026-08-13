#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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
    const stdout = typeof cause?.stdout === "string" ? cause.stdout.trim() : "";
    const stderr = typeof cause?.stderr === "string" ? cause.stderr.trim() : "";
    const details = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join("\n");
    throw new Error(details ? `${cause.message}\n${details}` : cause.message, { cause });
  }
}

function runHook(bundlePath, input, options) {
  run(process.execPath, [bundlePath], {
    ...options,
    input: `${JSON.stringify(input)}\n`,
  });
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
    ).get();
    const memoryExists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory'",
    ).get();
    const matchingEvents = sessionsExists
      ? Number(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE CAST(message AS TEXT) LIKE ?").get(`%${text}%`).count)
      : 0;
    const summaries = memoryExists
      ? Number(db.prepare("SELECT COUNT(*) AS count FROM memory WHERE path LIKE '/summaries/%'").get().count)
      : 0;
    const matchingSummaries = memoryExists
      ? Number(db.prepare(
        "SELECT COUNT(*) AS count FROM memory WHERE path LIKE '/summaries/%' AND CAST(summary AS TEXT) LIKE ?",
      ).get(`%${text}%`).count)
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

function inspectDatabase(databasePath, semanticFact, semanticIdentifier, lexicalToken) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get();
    const journal = db.prepare("PRAGMA journal_mode").get();
    const events = db.prepare("SELECT message, message_embedding FROM sessions ORDER BY creation_date").all();
    const summaries = db.prepare("SELECT summary, summary_embedding FROM memory WHERE path LIKE '/summaries/%'").all();
    assert(String(integrity.integrity_check).toLowerCase() === "ok", "SQLite integrity_check failed");
    assert(String(journal.journal_mode).toLowerCase() === "wal", "SQLite is not in WAL mode");
    assert(events.length > 0, "No runtime validation events were captured");
    assert(summaries.length > 0, "No runtime validation summaries were generated");
    const eventText = events.map(row => row.message).join("\n");
    const summaryText = summaries.map(row => row.summary).join("\n");
    assert(eventText.includes(semanticFact), "Semantic validation fact is missing from isolated SQLite events");
    assert(eventText.includes(lexicalToken), "Lexical validation token is missing from isolated SQLite events");
    assert(
      summaryText.includes(semanticIdentifier),
      "Semantic validation identifier is missing from isolated summaries",
    );
    assert(summaryText.includes(lexicalToken), "Lexical validation token is missing from isolated summaries");
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
  ];
  for (const bundle of requiredBundles) {
    assert(existsSync(bundle), `Installed runtime bundle is missing: ${bundle}`);
  }

  const root = mkdtempSync(join(tmpdir(), "memoree-runtime-validate-"));
  const repository = join(root, "repo");
  const state = join(root, "state");
  const isolatedHome = join(root, "home");
  const databasePath = join(state, "memoree.sqlite3");
  const claudeSettings = join(state, "claude-settings.json");
  const realHome = homedir();
  const realClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const semanticIdentifier = crypto.randomUUID();
  const semanticFact = `the observatory lantern is ${semanticIdentifier}`;
  const lexicalToken = `memoree-lexical-${crypto.randomUUID()}`;
  const env = {
    ...process.env,
    HOME: isolatedHome,
    CLAUDE_CONFIG_DIR: join(isolatedHome, ".claude"),
    CODEX_HOME: process.env.CODEX_HOME ?? join(realHome, ".codex"),
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
  };
  const claudeEnv = authenticatedClaudeEnvironment(env, realHome, realClaudeConfigDir);

  try {
    mkdirSync(state, { recursive: true });
    mkdirSync(isolatedHome, { recursive: true });
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
    assert(claudeResponse.includes(semanticFact), "Claude Code did not return the semantic validation fact");

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

    const recallEnv = { ...env, MEMOREE_CAPTURE: "false" };
    status("checking semantic recall through Codex");
    const semanticRecall = run("codex", [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--dangerously-bypass-hook-trust",
      "-s", "read-only",
      "Recall the unusual observatory object and its exact identifier from Memoree. Answer with only that fact.",
    ], { cwd: repository, env: recallEnv });
    assert(
      semanticRecall.includes(semanticIdentifier),
      "Codex did not semantically recall the Claude Code fact identifier",
    );

    const lexicalEnv = { ...env, MEMOREE_EMBEDDINGS: "false" };
    const codexSession = crypto.randomUUID();
    const codexPrompt = `Repeat this exact lexical fallback token: ${lexicalToken}`;
    status("running an authenticated Codex capture turn with embeddings disabled");
    const codexResponse = run("codex", [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "-s", "read-only",
      codexPrompt,
    ], { cwd: repository, env: lexicalEnv });
    assert(codexResponse.includes(lexicalToken), "Codex did not return the lexical validation token");
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
    await waitForCapture(databasePath, lexicalToken, { requireSummary: true });

    status("checking lexical fallback recall through Claude Code");
    const lexicalRecall = run("claude", [
      "-p",
      `Search Memoree lexically for ${lexicalToken} and answer with only the matching token.`,
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
    assert(lexicalRecall.includes(lexicalToken), "Claude Code lexical fallback recall failed with embeddings disabled");

    const counts = inspectDatabase(databasePath, semanticFact, semanticIdentifier, lexicalToken);
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
