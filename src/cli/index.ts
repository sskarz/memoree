import { uninstallClaude } from "./install-claude.js";
import { uninstallCodex } from "./install-codex.js";
import { uninstallAntigravity } from "./install-antigravity.js";
import { disableEmbeddings, enableEmbeddings, installEmbeddings, statusEmbeddings, uninstallEmbeddings } from "./embeddings.js";
import { detectPlatforms, log, warn, type PlatformId } from "./util.js";
import { getVersion } from "./version.js";
import { VERSION_PROBE_ENV, formatVersionReport } from "./install-versions.js";
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
import { installPlatform, runInstall } from "./run-install.js";
import { runUninstall } from "./run-uninstall.js";

const USAGE = `
memoree — local-first memory for coding agents

Usage:
  memoree install [--no-embeddings] [--all]
  memoree doctor
  memoree status
  memoree uninstall [--purge] [--yes]
  memoree <claude|codex|antigravity> install|uninstall
  memoree backend status|check|use <sqlite|postgres>
  memoree embeddings install|enable|disable|status|uninstall [--prune]
  memoree rules|goal|kpi|docs|context ...
  memoree graph build|diff|history|init|pull|uninstall ...
  memoree skillify ...
  memoree memory backfill|flush ...
  memoree sessions prune ...
  memoree --version

Default installation initializes SQLite and embeddings, stages a durable
plugin copy, then installs every detected Claude Code, Codex, and Antigravity integration.
\`--all\` is an alias for that default. PostgreSQL is opt-in through
MEMOREE_POSTGRES_URL.

Default uninstall unwires detected harnesses and keeps ~/.memoree.
\`--purge\` also deletes leftover plugin copies, the staged package, Memoree-managed
skills, and ~/.memoree. Non-interactive purge requires \`--yes\`.
`.trim();

function requireNode(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error("Memoree requires Node.js 22.13 or newer");
}

function uninstallOne(id: PlatformId): void {
  if (id === "claude") uninstallClaude();
  else if (id === "codex") uninstallCodex();
  else uninstallAntigravity();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || ["help", "--help", "-h"].includes(command)) { log(USAGE); return; }
  if (["version", "--version", "-v"].includes(command)) {
    if (process.env[VERSION_PROBE_ENV] === "1") { log(getVersion()); return; }
    log(formatVersionReport());
    return;
  }
  if (command === "install") { requireNode(); await runInstall(args.slice(1)); return; }
  if (command === "doctor") { process.exitCode = await runDoctor(); return; }
  if (command === "status") {
    if (process.env[VERSION_PROBE_ENV] === "1") { log(getVersion()); return; }
    log(`${formatVersionReport()}\n${detectPlatforms().map(p => `${p.id}: ${p.markerDir}`).join("\n") || "No integrations detected"}`);
    return;
  }
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

  const platforms: PlatformId[] = ["claude", "codex", "antigravity"];
  if (platforms.includes(command as PlatformId)) {
    if (args[1] === "install") { requireNode(); installPlatform(command as PlatformId); }
    else if (args[1] === "uninstall") uninstallOne(command as PlatformId);
    else throw new Error(`Usage: memoree ${command} install|uninstall`);
    return;
  }
  if (command === "uninstall") { await runUninstall(args.slice(1)); return; }
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => { warn(`memoree: ${(error as Error).message}`); process.exitCode = 1; });
