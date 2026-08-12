#!/usr/bin/env node

/**
 * Cursor sessionStart hook.
 *
 * Cursor 1.7+ docs: https://cursor.com/docs/agent/hooks
 *
 * Input (from common payload + sessionStart-specific):
 *   { session_id, is_background_agent, composer_mode,
 *     conversation_id, generation_id, model, hook_event_name,
 *     cursor_version, workspace_roots, user_email, transcript_path }
 *
 * Output (JSON to stdout):
 *   { additional_context: "string injected into agent context",
 *     env: { ... env vars exposed to subsequent hooks ... } }
 *
 * Cursor exit codes: 0 = success (use stdout JSON), 2 = block,
 * other = fail-open (proceed with action).
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
const log = (msg: string) => _log("cursor-session-start", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
// Memoree requires its npm bin (`memoree` from memoree) on PATH.
// Inject text uses bare `memoree <sub>` form — no per-agent path resolution needed.

const context = `MEMOREE MEMORY: Persistent memory at ~/.memoree/memory/ shared across sessions, users, and agents.

Structure: index.md (start here) → summaries/*.md → sessions/*.jsonl (last resort). Do NOT jump straight to JSONL.
Search: use \`grep\` (NOT \`rg\`/ripgrep). Example: grep -ri "keyword" ~/.memoree/memory/
IMPORTANT: Only use these bash builtins to interact with ~/.memoree/memory/: cat, ls, grep, echo, jq, head, tail, sed, awk, wc, sort, find. Do NOT use rg/ripgrep, python, python3, node, curl, or other interpreters — they may not be installed and the memory filesystem only supports the listed builtins.
Do NOT spawn subagents to read Memoree memory.

Diagnostics:
- memoree doctor                             — verify local storage and embeddings
- memoree backend status                     — show the active storage backend

SKILLS (skillify) — mine + share reusable skills across the org:
${renderSkillifyCommands()}

Embeddings (semantic memory search) — opt-in, persisted in ~/.memoree/config.json:
- memoree embeddings install               — download deps (~600MB), symlink agents, set enabled:true
- memoree embeddings enable                — flip enabled:true (run install first if deps missing)
- memoree embeddings disable               — flip enabled:false + SIGTERM daemon (deps stay on disk)
- memoree embeddings uninstall [--prune]   — remove agent symlinks + disable; --prune wipes deps too
- memoree embeddings status                — show config + deps + per-agent link state`;

interface CursorSessionStartInput {
  session_id?: string;
  conversation_id?: string;
  hook_event_name?: string;
  workspace_roots?: string[];
  cursor_version?: string;
  user_email?: string | null;
  transcript_path?: string | null;
  is_background_agent?: boolean;
  composer_mode?: string;
}

/** Resolve the session id Cursor uses (sessionStart provides session_id; reuse conversation_id otherwise). */
function resolveSessionId(input: CursorSessionStartInput): string {
  return input.session_id ?? input.conversation_id ?? `cursor-${Date.now()}`;
}

function resolveCwd(input: CursorSessionStartInput): string {
  const roots = input.workspace_roots;
  if (Array.isArray(roots) && roots.length > 0 && typeof roots[0] === "string") {
    return roots[0];
  }
  return process.cwd();
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
    { table, sessionId, cwd, userName, orgName, workspaceId, agent: "cursor", pluginVersion, dialect: api.dialect },
  );
}

async function main(): Promise<void> {
  if (process.env.MEMOREE_WIKI_WORKER === "1") return;

  const input = await readStdin<CursorSessionStartInput>();
  const sessionId = resolveSessionId(input);
  const cwd = resolveCwd(input);
  // Resolve plugin version once — also stamped on the placeholder row.
  const current = getInstalledVersion(__bundleDir, ".claude-plugin");
  const pluginVersion = current ?? "";

  // MEMOREE_CAPTURE=false means full read-only mode — no INSERTs
  // AND no DDL. ensureTable + ensureSessionsTable create/heal tables
  // (DDL writes), so they're gated on captureEnabled too. The
  // renderer is read-only and runs regardless. Codex review pass 2
  // + pass 4 together surfaced this layering: only writes (placeholder
  // + ensure DDL) are gated; reads (renderer) always run.
  const captureEnabled = process.env.MEMOREE_CAPTURE !== "false";

  // Per-directory `.memoree`: route / opt out for this tree. Resolved once and
  // reused for the placeholder write and the disclosure banner below.
  const baseConfig = loadConfig();
  const storageAvailable = Boolean(baseConfig);
  const dirRes = baseConfig ? resolveDirConfig(baseConfig, cwd) : null;
  const collectHere = captureEnabled && (dirRes?.collect ?? true);
  let rulesBlock = "";
  if (storageAvailable) {
    try {
      const config = dirRes?.config;
      if (config) {
        const table = config.tableName;
        const sessionsTable = config.sessionsTableName;
        const api = createStorageBackend(config, table);
        if (collectHere) {
          await api.ensureTable();
          await api.ensureSessionsTable(sessionsTable);
          await createPlaceholder(api, table, sessionId, cwd, config.userName, config.orgName, config.workspaceId, pluginVersion);
          log("placeholder created");
        } else {
          log(dirRes && !dirRes.collect
            ? `placeholder + schema ensure skipped (.memoree collect:false ${dirRes.found?.path})`
            : "placeholder + schema ensure skipped (MEMOREE_CAPTURE=false)");
        }
        // Read-only renderer. Cursor's additional_context is invisible
        // to the user (model-only), so the full block is fine. Renderer
        // absorbs its own errors and returns "" on any failure (including
        // missing rules table — see context-renderer.ts).
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
  if (storageAvailable) spawnGraphPullWorker(resolveCwd(input), __bundleDir);

  // Disclose the EFFECTIVE identity (after any `.memoree` overlay).
  const effConfig = dirRes?.config ?? baseConfig;
  const routed = !!(dirRes?.found && dirRes.collect && baseConfig &&
    (dirRes.config.orgId !== baseConfig.orgId || dirRes.config.workspaceId !== baseConfig.workspaceId));
  const provider = effConfig?.storage.kind ?? "sqlite";
  const identityLine = `Memoree memory backend: ${provider}${dirRes && !dirRes.collect ? ` · capture disabled by ${dirRes.found?.path}` : ""}`;
  const baseContext = storageAvailable && effConfig
    ? `${context}\n${identityLine}${versionNotice}`
    : `${context}\nLocal Memoree storage is unavailable. Run: memoree doctor${localMinedNote}${versionNotice}`;
  // Cursor cannot route Write/Edit through memoree hooks (its
  // pre-tool-use only intercepts Shell). So the agent here uses
  // the CLI variant — `memoree goal add/list/...` invoked as
  // shell commands. Same end state (rows in memoree_goals /
  // memoree_kpis), different code path inside the agent.
  const baseWithGoals = storageAvailable && effConfig ? `${baseContext}\n\n${GOALS_INSTRUCTIONS_CLI}` : baseContext;
  const withRules = rulesBlock
    ? `${baseWithGoals}\n\n${rulesBlock}`
    : baseWithGoals;

  // Local code graph context (Phase 3 v1.1) — same inject Claude Code emits
  // (src/hooks/session-start.ts). Cheap: reads ~/.memoree/.../​.last-build.json,
  // never parses the ~1 MB snapshot. Returns null when no graph exists for
  // this repo, in which case we append nothing. Without this, Cursor never
  // told the agent the graph existed — the silent gap A3 closes.
  const graphLine = graphContextLine(resolveCwd(input));
  const additionalContext = graphLine
    ? `${withRules}\n${graphLine}`
    : withRules;

  console.log(JSON.stringify({ additional_context: additionalContext }));
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
