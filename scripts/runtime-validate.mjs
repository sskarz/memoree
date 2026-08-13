#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertNoActiveAgentSessions, runtimePaths } from "./runtime-manager.mjs";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 240_000,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function isolatedCounts(databasePath, text) {
  if (!existsSync(databasePath)) return { matchingEvents: 0, summaries: 0 };
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
    return { matchingEvents, summaries };
  } finally {
    db.close();
  }
}

async function waitForCapture(databasePath, text, requireSummary = false) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const counts = isolatedCounts(databasePath, text);
      if (counts.matchingEvents > 0 && (!requireSummary || counts.summaries > 0)) return;
    } catch {
      // Capture and summary workers may still be creating or writing the DB.
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for isolated capture state containing ${text}`);
}

function inspectDatabase(databasePath, semanticFact, lexicalToken) {
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
    const text = [...events.map(row => row.message), ...summaries.map(row => row.summary)].join("\n");
    assert(text.includes(semanticFact), "Semantic validation fact is missing from isolated SQLite state");
    assert(text.includes(lexicalToken), "Lexical validation token is missing from isolated SQLite state");
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

async function main() {
  assertNoActiveAgentSessions();
  const { runtimeDir } = runtimePaths();
  const cli = join(runtimeDir, "bundle", "cli.js");
  const root = mkdtempSync(join(tmpdir(), "memoree-runtime-validate-"));
  const repository = join(root, "repo");
  const state = join(root, "state");
  const databasePath = join(state, "memoree.sqlite3");
  const semanticFact = `the observatory lantern is ${crypto.randomUUID()}`;
  const lexicalToken = `memoree-lexical-${crypto.randomUUID()}`;
  const env = {
    ...process.env,
    MEMOREE_BACKEND: "sqlite",
    MEMOREE_SQLITE_PATH: databasePath,
    MEMOREE_CONFIG_PATH: join(state, "config.json"),
    MEMOREE_MEMORY_PATH: join(state, "memory"),
    MEMOREE_REPOSITORY_KEY: "runtime-validation",
    MEMOREE_USER_NAME: "runtime-validation",
    MEMOREE_CAPTURE: "true",
    MEMOREE_EMBEDDINGS: "true",
  };

  try {
    run("git", ["init", repository], { env, capture: false });
    run("git", ["config", "user.email", "runtime-validation@memoree.local"], { cwd: repository, env });
    run("git", ["config", "user.name", "Memoree Runtime Validation"], { cwd: repository, env });
    run(process.execPath, [cli, "backend", "check"], { cwd: repository, env });
    run("claude", [
      "-p",
      `Remember this exact private test fact for the next coding agent: ${semanticFact}. Reply with the fact.`,
      "--output-format", "text",
      "--no-session-persistence",
    ], { cwd: repository, env });
    await waitForCapture(databasePath, semanticFact);

    const semanticRecall = run("codex", [
      "exec", "--skip-git-repo-check", "-s", "read-only",
      "Recall the unusual observatory object and its exact identifier from Memoree. Answer with only that fact.",
    ], { cwd: repository, env });
    assert(semanticRecall.includes(semanticFact), "Codex did not semantically recall the Claude Code fact");

    const lexicalEnv = { ...env, MEMOREE_EMBEDDINGS: "false" };
    run("codex", [
      "exec", "--skip-git-repo-check", "-s", "read-only",
      `Remember this exact lexical fallback token: ${lexicalToken}. Reply with the token.`,
    ], { cwd: repository, env: lexicalEnv });
    await waitForCapture(databasePath, lexicalToken);
    const lexicalRecall = run("claude", [
      "-p",
      `Search Memoree lexically for ${lexicalToken} and answer with only the matching token.`,
      "--output-format", "text",
      "--no-session-persistence",
    ], { cwd: repository, env: lexicalEnv });
    assert(lexicalRecall.includes(lexicalToken), "Claude Code lexical fallback recall failed with embeddings disabled");
    await waitForCapture(databasePath, semanticFact, true);

    const counts = inspectDatabase(databasePath, semanticFact, lexicalToken);
    process.stdout.write(
      `Runtime validation passed: ${counts.events} events, ${counts.summaries} summaries, SQLite integrity/WAL, 768-d embeddings, semantic and lexical cross-agent recall.\n`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`memoree runtime validation: ${error.message}\n`);
  process.exitCode = 1;
});
