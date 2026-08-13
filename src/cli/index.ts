import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { installClaude, uninstallClaude } from "./install-claude.js";
import { installCodex, uninstallCodex } from "./install-codex.js";
import { disableEmbeddings, enableEmbeddings, installEmbeddings, preloadEmbeddingModel, statusEmbeddings, uninstallEmbeddings } from "./embeddings.js";
import { detectPlatforms, log, warn, type PlatformId } from "./util.js";
import { getVersion } from "./version.js";
import { loadStorageConfig } from "../config.js";
import { createStorageBackend } from "../storage/factory.js";
import { writeUserConfig } from "../user-config.js";
import { runBackendCommand } from "../commands/backend.js";
import { runDoctor } from "../commands/doctor.js";
import { runSkillifyCommand } from "../commands/skillify.js";
import { runRulesCommand } from "../commands/rules.js";
import { runGoalCommand, runKpiCommand } from "../commands/goal.js";
import { runDocsCommand } from "../commands/docs.js";
import { runContextCommand } from "../commands/context.js";
import { runBackfillMemory } from "../commands/backfill-memory.js";
import { runFlushMemory } from "../commands/flush-memory.js";
import { sessionPrune } from "../commands/session-prune.js";
import { ensureGraphDeps } from "./graph-deps.js";

const USAGE = `
memoree — local-first memory for coding agents

Usage:
  memoree install [--no-embeddings] [--all]
  memoree doctor
  memoree status
  memoree uninstall [--all]
  memoree <claude|codex> install|uninstall
  memoree backend status|check|use <sqlite|postgres>
  memoree embeddings install|enable|disable|status|uninstall [--prune]
  memoree rules|goal|kpi|docs|context ...
  memoree graph build|diff|history|init|pull|uninstall ...
  memoree skillify ...
  memoree memory backfill|flush ...
  memoree sessions prune ...
  memoree --version

Default installation initializes SQLite and embeddings, then installs the
local Claude Code plugin. Use --all to install detected Claude Code and Codex integrations.
PostgreSQL is opt-in through MEMOREE_POSTGRES_URL.
`.trim();

function requireNode(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error("Memoree requires Node.js 22.13 or newer");
}

function installOne(id: PlatformId): void {
  if (id === "claude") installClaude();
  else installCodex();
}

function uninstallOne(id: PlatformId): void {
  if (id === "claude") uninstallClaude();
  else uninstallCodex();
}

async function initializeStorage(): Promise<string> {
  const config = loadStorageConfig();
  if (!config) throw new Error("MEMOREE_POSTGRES_URL is required when PostgreSQL is selected");
  if (config.kind === "sqlite") mkdirSync(dirname(config.path), { recursive: true, mode: 0o700 });
  const backend = createStorageBackend(config);
  try { await backend.initializeSchema(); }
  finally { await backend.close(); }
  writeUserConfig({
    storage: config.kind === "sqlite"
      ? { provider: "sqlite", sqlitePath: config.path }
      : { provider: "postgres", postgresSchema: config.schema },
    userName: config.userName,
    capture: { enabled: true },
  });
  return config.kind === "sqlite" ? config.path : `PostgreSQL schema ${config.schema}`;
}

async function runInstall(args: string[]): Promise<void> {
  requireNode();
  const location = await initializeStorage();
  const noEmbeddings = args.includes("--no-embeddings");
  writeUserConfig({ embeddings: { enabled: !noEmbeddings } });
  if (!noEmbeddings) {
    installEmbeddings({ quietNoInstalls: true });
    try { await preloadEmbeddingModel(); }
    catch (error) { throw new Error(`Embedding initialization failed: ${(error as Error).message}. Retry with \`memoree embeddings install\` or use --no-embeddings.`); }
  }

  const targets: PlatformId[] = args.includes("--all")
    ? detectPlatforms().map(platform => platform.id)
    : ["claude"];
  for (const target of [...new Set(targets)]) installOne(target);

  log("");
  log(`Database: ${location}`);
  log(`Embeddings: ${noEmbeddings ? "disabled (lexical retrieval only)" : "enabled"}`);
  log("Restart Claude Code to activate Memoree, then run `memoree doctor`.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || ["help", "--help", "-h"].includes(command)) { log(USAGE); return; }
  if (["version", "--version", "-v"].includes(command)) { log(getVersion()); return; }
  if (command === "install") { await runInstall(args.slice(1)); return; }
  if (command === "doctor") { process.exitCode = await runDoctor(); return; }
  if (command === "status") { log(`memoree ${getVersion()}\n${detectPlatforms().map(p => `${p.id}: ${p.markerDir}`).join("\n") || "No integrations detected"}`); return; }
  if (command === "backend") { process.exitCode = await runBackendCommand(args.slice(1)); return; }
  if (command === "skillify") { runSkillifyCommand(args.slice(1)); return; }
  if (command === "rules") { await runRulesCommand(args.slice(1)); return; }
  if (command === "goal" || command === "goals") { await runGoalCommand(args.slice(1)); return; }
  if (command === "kpi" || command === "kpis") { await runKpiCommand(args.slice(1)); return; }
  if (command === "docs" || command === "doc") { await runDocsCommand(args.slice(1)); return; }
  if (command === "context") { await runContextCommand(args.slice(1)); return; }
  if (command === "sessions" && args[1] === "prune") { await sessionPrune(args.slice(2)); return; }
  if (command === "memory") {
    if (args[1] === "backfill") { process.exitCode = await runBackfillMemory(args.slice(2)); return; }
    if (args[1] === "flush") {
      const result = await runFlushMemory();
      if (result.reason) throw new Error(`memory flush: ${result.reason}`);
      log(`memory flush: stored ${result.uploaded}/${result.pending} staged summaries${result.failed ? `, ${result.failed} failed` : ""}.`);
      return;
    }
    throw new Error("Usage: memoree memory backfill|flush");
  }
  if (command === "graph") {
    if (args[1] === "init") {
      try { ensureGraphDeps(); } catch { /* graph command reports missing optional dependencies */ }
    }
    try {
      const { runGraphCommand } = await import("../commands/graph.js");
      await runGraphCommand(args.slice(1));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("tree-sitter") || (error as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("The graph command requires the optional tree-sitter native dependency. Reinstall dependencies with a supported build toolchain.");
      }
      throw error;
    }
    return;
  }
  if (command === "embeddings") {
    const sub = args[1];
    if (sub === "install") installEmbeddings();
    else if (sub === "enable") enableEmbeddings();
    else if (sub === "disable") disableEmbeddings();
    else if (sub === "status") statusEmbeddings();
    else if (sub === "uninstall") uninstallEmbeddings({ prune: args.includes("--prune") });
    else throw new Error("Usage: memoree embeddings install|enable|disable|status|uninstall [--prune]");
    return;
  }

  const platforms: PlatformId[] = ["claude", "codex"];
  if (platforms.includes(command as PlatformId)) {
    if (args[1] === "install") installOne(command as PlatformId);
    else if (args[1] === "uninstall") uninstallOne(command as PlatformId);
    else throw new Error(`Usage: memoree ${command} install|uninstall`);
    return;
  }
  if (command === "uninstall") {
    const targets: PlatformId[] = args.includes("--all") ? detectPlatforms().map(p => p.id) : ["claude"];
    for (const target of targets) uninstallOne(target);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => { warn(`memoree: ${(error as Error).message}`); process.exitCode = 1; });
