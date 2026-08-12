/**
 * Hermes on_session_start hook.
 *
 * Hermes hook spec (from agent/shell_hooks.py):
 *   stdin  JSON: { hook_event_name, tool_name?, tool_input?, session_id, cwd, extra? }
 *   stdout JSON: { context: "..." } injects context into pre_llm_call;
 *                for on_session_start, the recommended shape is also { context }
 *                — the docstring describes pre_llm_call but the same wire is
 *                used for session start.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "../../config.js";
import { resolveDirConfig } from "../../dir-config.js";
import { createStorageBackend } from "../../storage/factory.js";
import type { StorageBackend } from "../../storage/backend.js";
import { renderContextBlock } from "../shared/context-renderer.js";
import { createPlaceholderSummary } from "../shared/placeholder-summary.js";
import { renderSkillifyCommands } from "../../cli/skillify-spec.js";
import { countLocalManifestEntries } from "../../skillify/local-manifest.js";
import { maybeAutoMineLocal } from "../../skillify/spawn-mine-local-worker.js";
import { readStdin } from "../../utils/stdin.js";
import { log as _log } from "../../utils/debug.js";
import { getInstalledVersion } from "../../utils/version-check.js";
import { autoPullSkills } from "../../skillify/auto-pull.js";
import { GOALS_INSTRUCTIONS_CLI } from "../shared/goals-instructions.js";
import { spawnGraphPullWorker } from "../../graph/spawn-pull-worker.js";
import { graphContextLine } from "../../graph/session-context.js";
const log = (msg: string) => _log("hermes-session-start", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
// Memoree requires its npm bin (`memoree` from memoree) on PATH.
// Inject text uses bare `memoree <sub>` form — no per-agent path resolution needed.

const context = `MEMOREE MEMORY: Persistent memory at ~/.memoree/memory/ shared across sessions, users, and agents.

Structure: index.md (start here) → summaries/*.md → sessions/*.jsonl (last resort). Do NOT jump straight to JSONL.
Search: use \`grep\` (NOT \`rg\`/ripgrep). Example: grep -ri "keyword" ~/.memoree/memory/
You also have memoree MCP tools registered: memoree_search, memoree_read, memoree_index. Prefer these — one tool call returns ranked hits across all summaries and sessions in a single SQL query.
IMPORTANT: Only use these bash builtins to interact with ~/.memoree/memory/: cat, ls, grep, echo, jq, head, tail, sed, awk, wc, sort, find. Do NOT use rg/ripgrep, python, python3, node, curl, or other interpreters.
Do NOT spawn subagents to read Memoree memory.

Diagnostics:
- memoree doctor                             — verify local storage and embeddings
- memoree backend status                     — show the active storage backend

SKILLS (skillify) — mine + share reusable skills across the org:
${renderSkillifyCommands()}

Embeddings (semantic memory search) — enabled by default, persisted in ~/.memoree/config.json:
- memoree embeddings install               — download deps (~600MB), symlink agents, set enabled:true
- memoree embeddings enable                — flip enabled:true (run install first if deps missing)
- memoree embeddings disable               — flip enabled:false + SIGTERM daemon (deps stay on disk)
- memoree embeddings uninstall [--prune]   — remove agent symlinks + disable; --prune wipes deps too
- memoree embeddings status                — show config + deps + per-agent link state`;

interface HermesSessionStartInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  extra?: Record<string, unknown>;
}

/** Create a placeholder summary via the shared race-safe writer (see placeholder-summary.ts). */
async function createPlaceholder(
  api: StorageBackend,
  table: string,
  sessionId: string,
  cwd: string,
  userName: string,
  orgName: string,
  workspaceId: string,
  pluginVersion: string,
): Promise<void> {
  await createPlaceholderSummary(
    (sql) => api.query(sql),
    { table, sessionId, cwd, userName, orgName, workspaceId, agent: "hermes", pluginVersion, dialect: api.dialect },
  );
}

async function main(): Promise<void> {
  if (process.env.MEMOREE_WIKI_WORKER === "1") return;
  const input = await readStdin<HermesSessionStartInput>();
  const sessionId = input.session_id ?? `hermes-${Date.now()}`;
  const cwd = input.cwd ?? process.cwd();
  const captureEnabled = process.env.MEMOREE_CAPTURE !== "false";

  // Per-directory `.memoree`: route / opt out for this tree. Resolved once and
  // reused for the placeholder write and the disclosure banner below.
  const baseConfig = loadConfig();
  const storageAvailable = Boolean(baseConfig);
  const dirRes = baseConfig ? resolveDirConfig(baseConfig, cwd) : null;
  const collectHere = captureEnabled && (dirRes?.collect ?? true);

  // Resolve plugin version once — also stamped on the placeholder row.
  const current = getInstalledVersion(__bundleDir, ".claude-plugin");
  const pluginVersion = current ?? "";

  // MEMOREE_CAPTURE=false means full read-only mode — no INSERTs
  // AND no DDL. ensureTable + ensureSessionsTable create/heal tables
  // (DDL writes), so they're gated on captureEnabled too. Renderer
  // is read-only and runs regardless. See cursor session-start for
  // the same layering rationale.
  let rulesBlock = "";
  if (storageAvailable) {
    try {
      const config = dirRes?.config;
      if (config) {
        const api = createStorageBackend(config, config.tableName);
        if (collectHere) {
          await api.ensureTable();
          await api.ensureSessionsTable(config.sessionsTableName);
          await createPlaceholder(api, config.tableName, sessionId, cwd, config.userName, config.orgName, config.workspaceId, pluginVersion);
          log("placeholder created");
        } else {
          log(dirRes && !dirRes.collect
            ? `placeholder + schema ensure skipped (.memoree collect:false ${dirRes.found?.path})`
            : "placeholder + schema ensure skipped (MEMOREE_CAPTURE=false)");
        }
        // Read-only renderer. Hermes's context field is invisible to
        // the user (model-only). Renderer absorbs its own errors.
        // Trusted table list (cached) so the renderer skips the rules/goals
        // SELECT when the table isn't there yet — avoids a 42P01 server-side.
        const known = await api.knownTablesOrNull();
        const tableExists = known ? (name: string) => known.includes(name) : undefined;
        rulesBlock = await renderContextBlock(
          (sql: string) => api.query(sql) as Promise<Array<Record<string, unknown>>>,
          {
            rulesTable: config.rulesTableName,
            goalsTable: config.goalsTableName,
            currentUser: config.userName,
          },
          { log, tableExists },
        );
      }
    } catch (e: any) {
      log(`placeholder failed: ${e.message}`);
    }
  }

  // Auto-pull shared skills on every SessionStart (5s timeout).
  // File writes inside runPull are idempotent (skipped when local version
  // is at-or-newer than remote), so re-running every session is cheap on
  // disk; the only per-call cost is the SQL round-trip. autoPullSkills
  // never rejects — all errors are swallowed inside. Hard opt-out:
  // MEMOREE_AUTOPULL_DISABLED=1.
  const pullResult = await autoPullSkills();
  log(`autopull: pulled=${pullResult.pulled} skipped=${pullResult.skipped}`);

  let versionNotice = "";
  if (current) versionNotice = `\nMemoree v${current}`;

  // No placeholder substitution — inject already uses bare `memoree <sub>` form.
  const localMined = countLocalManifestEntries();
  const localMinedNote = localMined > 0
    ? `\n${localMined} local skill${localMined === 1 ? "" : "s"} from past 'memoree skillify mine-local' run(s) live in ~/.claude/skills/. Run 'memoree doctor' to start sharing new mining results with your team.`
    : "";
  // Async auto-pull on SessionStart — detached, never blocks. Pulled
  // bytes land for the NEXT SessionStart. See src/graph/spawn-pull-worker.ts.
  // Skip the worker when the selected storage backend is unavailable.
  if (storageAvailable) spawnGraphPullWorker(cwd, __bundleDir);

  // Disclose the EFFECTIVE identity (after any `.memoree` overlay).
  const effConfig = dirRes?.config ?? baseConfig;
  const routed = !!(dirRes?.found && dirRes.collect && baseConfig &&
    (dirRes.config.orgId !== baseConfig.orgId || dirRes.config.workspaceId !== baseConfig.workspaceId));
  const provider = effConfig?.storage.kind ?? "sqlite";
  const identityLine = `Memoree memory backend: ${provider}${dirRes && !dirRes.collect ? ` · capture disabled by ${dirRes.found?.path}` : ""}`;
  const baseContext = storageAvailable && effConfig
    ? `${context}\n${identityLine}${versionNotice}`
    : `${context}\nLocal Memoree storage is unavailable. Run: memoree doctor${localMinedNote}${versionNotice}`;
  // Hermes' pre-tool-use intercepts only `terminal` — it cannot
  // route Write/Edit. Use the CLI variant: agent invokes
  // `memoree goal add/list/...` via terminal. End state in tables
  // is identical to the VFS-routed path.
  const baseWithGoals = storageAvailable && effConfig ? `${baseContext}\n\n${GOALS_INSTRUCTIONS_CLI}` : baseContext;
  // Code-graph inject. Unlike harnesses/claude-code/cursor this is user-visible in the
  // Hermes TUI (Hermes has no model-only SessionStart channel), but an
  // always-present structural index is worth the extra lines. graphContextLine
  // returns null — and appends nothing — when no graph exists for this repo yet.
  const graphNote = graphContextLine(cwd) ?? "";
  const additional = (rulesBlock
    ? `${baseWithGoals}\n\n${rulesBlock}`
    : baseWithGoals) + graphNote;

  // Hermes expects { context: "..." } on stdout
  console.log(JSON.stringify({ context: additional }));
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
