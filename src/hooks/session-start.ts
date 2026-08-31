#!/usr/bin/env node

/**
 * SessionStart hook:
 * Inject local Memoree memory instructions into Claude's context.
 */

import { fileURLToPath } from "node:url";
import { maybeSpawnDocsRefresh } from "../docs/auto-refresh-trigger.js";
import { docsWikiContextNote } from "../docs/docs-context.js";
import { deriveProjectKey } from "../utils/repo-identity.js";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../config.js";
import { resolveDirConfig } from "../dir-config.js";
import { createStorageBackend } from "../storage/factory.js";
import type { StorageBackend } from "../storage/backend.js";
import { readStdin } from "../utils/stdin.js";
import { log as _log } from "../utils/debug.js";
import { getInstalledVersion } from "../utils/version-check.js";
import { makeWikiLogger } from "../utils/wiki-log.js";
import { autoPullSkills } from "../skillify/auto-pull.js";
import { maybeSpawnHygieneWorker } from "../skillify/spawn-hygiene-worker.js";
import { renderSkillifyCommands } from "../cli/skillify-spec.js";
import { renderContextBlock } from "./shared/context-renderer.js";
import { countLocalManifestEntries } from "../skillify/local-manifest.js";
import { renderLocalMinedNote } from "../skillify/local-mined-banner.js";
import { maybeAutoMineLocal } from "../skillify/spawn-mine-local-worker.js";
import { maybeAutoBackfillMemory } from "../skillify/spawn-backfill-memory-worker.js";
import { graphContextLine } from "../graph/session-context.js";
import { MEMORY_COMMAND_GUIDANCE } from "./shared/memory-command-contract.js";
import { spawnGraphPullWorker } from "../graph/spawn-pull-worker.js";
import { entrypointPassesOnlyCliGate } from "./shared/capture-gate.js";
import { clearSessionEnded, recordSessionOwner, touchSessionActivity } from "./summary-state.js";
import { createPlaceholderSummary } from "./shared/placeholder-summary.js";
const log = (msg: string) => _log("session-start", msg);

const __bundleDir = dirname(fileURLToPath(import.meta.url));
// Memoree requires its npm bin (`memoree` from memoree, declared in
// package.json `bin`) to be on PATH. Inject text uses the bare `memoree <sub>` form
// — no per-agent path resolution needed. Marketplace-only installs without
// `npm i -g memoree` are unsupported (documented in README + RELEASE_CHECKLIST).

export const CLAUDE_MEMORY_CONTEXT = `MEMOREE MEMORY: You have TWO memory sources. ALWAYS check BOTH when the user asks you to recall, remember, or look up ANY information:

1. Your built-in memory (~/.claude/) — personal per-project notes
2. Memoree memory (~/.memoree/memory/) — persistent memory for the selected repository and backend

Memoree is a virtual filesystem backed by SQLite. Start with the read-only routed views:
- ~/.memoree/memory/identity.json — current userName, organization, workspace, and backend
- ~/.memoree/memory/rules.md — active shared rules
- ~/.memoree/memory/goals.md — the current user's opened and in-progress goals

For past-session recall, pick the right tier:
1. ~/.memoree/memory/index.md — recent session inventory.
2. ~/.memoree/memory/summaries/ — condensed wiki summaries per session.
3. ~/.memoree/memory/sessions/ — rendered transcript fallback; .jsonl does not guarantee JSON.

Search workflow:
  - Time-based ("last week", "today", "since X"): \`cat ~/.memoree/memory/index.md\` and read the most-recent rows.
  - Keyword/topic recall: use the **Bash tool** with \`grep -r "keyword" ~/.memoree/memory/summaries/\`. The Bash hook routes this through hybrid lexical+semantic search — synonyms / paraphrases match too. Then \`cat\` the top-matching summary to pull the answer.
  - Rendered transcript fallback only: \`grep -r "keyword" ~/.memoree/memory/sessions/\` (use sparingly — transcript views are verbose).

Tool choice on this mount:
  ✅ Bash tool with \`grep -r\` / \`cat\` / \`ls\` / \`head\` / \`tail\` — supported, fast.
  ✅ Root-wide \`ls\`, \`find\`, and \`grep\` include identity, rules, goals, KPIs, summaries, and sessions through one authoritative view.

Resuming work (user says "pick up where I left off" / "load that from memoree" / "continue where we stopped"):
  The resume target is the most recent session summary for the CURRENT project. Find and load it from the VFS — do not wait for or expect it to be pre-loaded:
  1. \`cat ~/.memoree/memory/index.md\` and take the newest rows whose \`Project\` matches this repo (or \`ls -t ~/.memoree/memory/summaries/<your-username>/\` for the latest files).
  2. \`cat\` the newest matching summary. If its \`## Next Steps\` (or older \`## Open Questions / TODO\`) is empty or says "none", move to the next-newest until you find one with real open work.
  3. Load THAT summary as context, then RECONCILE with the current git state (branch, uncommitted changes) before acting — the summary can be stale. Tell the user where they left off and confirm before continuing; don't silently execute the next step.
  4. Don't bulk-read \`sessions/\` — drill into a rendered transcript view only for a specific detail the summary is missing.

Diagnostics:
- memoree doctor                             — verify local storage, embeddings, plugin, and hooks
- memoree backend status                     — show the active storage backend

Skill management (mine + share reusable Claude skills through the selected backend):
${renderSkillifyCommands()}

Embeddings (semantic memory search) — enabled by default, persisted in ~/.memoree/config.json:
- memoree embeddings install                        — download deps (~600MB), symlink agents, set enabled:true
- memoree embeddings enable                         — flip enabled:true (run install first if deps missing)
- memoree embeddings disable                        — flip enabled:false + SIGTERM daemon (deps stay on disk)
- memoree embeddings uninstall [--prune]            — remove agent symlinks + disable; --prune wipes deps too
- memoree embeddings status                         — show config + deps + per-agent link state

IMPORTANT: ${MEMORY_COMMAND_GUIDANCE} Avoid bash brace expansions like \`{1..10}\` (not fully supported); spell out paths explicitly. Bash output is capped at 10MB total — avoid loops over the whole sessions directory.

LIMITS: Do NOT spawn subagents to read Memoree memory. If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

Debugging: Set MEMOREE_DEBUG=1 to enable verbose logging to ~/.memoree/hook-debug.log`;

const HOME = homedir();
const { log: wikiLog } = makeWikiLogger(join(HOME, ".claude", "hooks"));

/**
 * Create a placeholder summary via the shared race-safe writer. The atomic
 * `INSERT ... WHERE NOT EXISTS` inside createPlaceholderSummary guarantees a
 * finalized+embedded row is never reverted to an 'in progress' stub by a
 * resumed/concurrent SessionStart (the production clobber).
 */
async function createPlaceholder(api: StorageBackend, table: string, sessionId: string, cwd: string, userName: string, orgName: string, workspaceId: string, pluginVersion: string): Promise<void> {
  await createPlaceholderSummary(
    (sql) => api.query(sql),
    { table, sessionId, cwd, userName, orgName, workspaceId, agent: "claude_code", pluginVersion, dialect: api.dialect },
    wikiLog,
  );
}

interface SessionStartInput {
  session_id: string;
  cwd?: string;
}

async function main(): Promise<void> {
  // Skip if this is a sub-session spawned by the wiki worker
  if (process.env.MEMOREE_WIKI_WORKER === "1") return;

  const __hookT0 = Date.now();
  log(`hook entered (pid=${process.pid})`);

  const input = await readStdin<SessionStartInput>();

  // A fresh start or --resume of this session re-activates it: drop any stale
  // ended marker and record the owning `claude` process so other sessions can
  // tell this one is live even while it sits idle waiting on the user.
  if (input.session_id) {
    clearSessionEnded(input.session_id);
    recordSessionOwner(input.session_id);
    // Re-arm the heartbeat so the non-Linux mtime fallback in isSessionLive()
    // marks this resumed session live right away, not only after its first
    // captured event (on Linux the owner record above already does this).
    touchSessionActivity(input.session_id);
  }
  // Resolve the installed plugin version once up front — it's stamped on
  // every row this session writes (placeholder + capture) and is also used
  // for the user-visible update notice below.
  // getInstalledVersion swallows its own fs errors and returns null.
  const current = getInstalledVersion(__bundleDir, ".claude-plugin");
  const pluginVersion = current ?? "";

  // Ensure tables exist and (when capture is enabled) create the placeholder
  // summary via direct SQL. Tables must always be synced so queries return
  // fresh data — only the placeholder INSERT is skipped when MEMOREE_CAPTURE=false
  // (benchmark runs, explicit opt-out). Mirrors the guard already in
  // session-start-setup.ts / session-end.ts / codex hooks.
  // MEMOREE_CAPTURE=false means full read-only mode — no INSERTs and
  // no DDL. ensureTable + ensureSessionsTable both create/heal tables
  // (DDL writes), so they MUST be gated on captureEnabled. Codex
  // review pass 4 surfaced this — the prior code ran ensure* even
  // under capture=false. The renderer is read-only and runs
  // regardless; the rules table it queries is lazy-created by the
  // CLI write path (`memoree rules add`).
  const captureEnabled = process.env.MEMOREE_CAPTURE !== "false" && entrypointPassesOnlyCliGate();

  // Per-directory `.memoree`: route this tree's traces to a configured
  // repository key, or opt out entirely (`collect: false`). Resolved once and
  // reused for the placeholder write below and the disclosure banner.
  const sessionCwd = input.cwd ?? process.cwd();
  const baseConfig = loadConfig();
  const storageAvailable = Boolean(baseConfig);
  const dirRes = baseConfig ? resolveDirConfig(baseConfig, sessionCwd) : null;
  const collectHere = captureEnabled && (dirRes?.collect ?? true);

  // Auto-pull shared skills into ~/.claude/skills/ on every
  // SessionStart. File writes inside runPull are idempotent (skipped
  // when local version is at-or-newer than remote), so re-running each
  // session is cheap on disk; the only per-call cost is the SQL
  // round-trip. Bounded by a 5s timeout so a slow Memoree never
  // freezes SessionStart. Hard opt-out via MEMOREE_AUTOPULL_DISABLED=1.
  // All failures swallowed inside autoPullSkills (documented as
  // never-rejecting), so no try/catch needed here.
  const pullResult = await autoPullSkills();
  log(`autopull: pulled=${pullResult.pulled} skipped=${pullResult.skipped}`);
  try {
    const spawned = maybeSpawnHygieneWorker({
      cwd: sessionCwd,
      bundleDir: __bundleDir,
      agent: "claude_code",
    });
    if (spawned.triggered) log("hygiene worker spawned");
  } catch {
    // administrative; must never block SessionStart
  }
  try {
    const mined = maybeAutoMineLocal();
    if (mined.triggered) log("auto mine-local spawned");
  } catch {
    // administrative; must never block SessionStart
  }
  try {
    const backfill = maybeAutoBackfillMemory();
    if (backfill.triggered) log("auto memory backfill spawned");
  } catch {
    // administrative; must never block SessionStart
  }

  let rulesBlock = "";
  if (input.session_id && storageAvailable) {
    try {
      const config = dirRes?.config;
      if (config) {
        const table = config.tableName;
        const sessionsTable = config.sessionsTableName;
        const api = createStorageBackend(config, table);
        if (collectHere) {
          await api.ensureTable();
          await api.ensureSessionsTable(sessionsTable);
          await createPlaceholder(api, table, input.session_id, sessionCwd, config.userName, config.orgName, config.workspaceId, pluginVersion);
          log("placeholder created");
        } else {
          const reason = dirRes && !dirRes.collect
            ? `.memoree collect:false (${dirRes.found?.path})`
            : process.env.MEMOREE_CAPTURE === "false"
              ? "MEMOREE_CAPTURE=false"
              : "MEMOREE_CAPTURE_ONLY_CLI gate";
          log(`placeholder + schema ensure skipped (${reason})`);
        }
        // Docs auto sync check — the "every so often" the summary worker has.
        // Post-commit alone misses pulled commits and long-idle repos; a
        // session start is the natural cheap tick. `full` widens the per-file
        // scan past the one-commit git window, exactly to cover those gaps.
        // Independent of captureEnabled: docs consent lives in its own
        // registry (explicit per-(org, repo) opt-in), and the cycle's guards
        // (sha match, 6h quiet period, lease) make most spawns a no-op.
        try {
          const cwd = input.cwd ?? process.cwd();
          if (maybeSpawnDocsRefresh(cwd, { orgId: config.orgId, project: deriveProjectKey(cwd).key, full: true })) {
            log("docs auto sync spawned (session-start tick)");
          }
        } catch {
          // best-effort: a docs tick must never break SessionStart
        }
        // Renderer is read-only and runs regardless of captureEnabled.
        // It absorbs its own errors (missing table, network, etc.)
        // and returns "" on any failure — SessionStart MUST NOT fail
        // because of a bad rules read.
        // Trusted table list (cached — ensureTable above already warmed it)
        // so the renderer can skip the rules/goals SELECT when the table
        // isn't there yet, avoiding a 42P01 server-side on every SessionStart.
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
      wikiLog(`SessionStart: placeholder failed for ${input.session_id}: ${e.message}`);
    }
  }

  // SkillOpt is no longer fired from SessionStart — it's event-driven now (a skill
  // invocation arms the session via PreToolUse, then UserPromptSubmit/SessionEnd tick
  // the per-skill counter and fire only on accumulated pushback). See skillopt-trigger.

  // Version notice in additionalContext is informational only.
  const updateNotice = current ? `\n\n✅ Memoree v${current}` : "";

  // No placeholder substitution needed — inject uses bare `memoree <sub>` form.
  const resolvedContext = CLAUDE_MEMORY_CONTEXT;
  // When the user has mined skills locally with
  // `memoree skillify mine-local`, surface a count in
  // the model-visible context. The rich concrete-insight banner is
  // delivered on the user-visible systemMessage channel by the
  // notifications rule (src/notifications/rules/local-mined.ts) — it
  // is intentionally NOT rendered here because `insight` originates
  // from haiku's gate output and feeding LLM-derived prose back into
  // `additionalContext` is a prompt-injection vector (codex P1).
  // Take the refactored helper from main (renderLocalMinedNote) AND the
  // graph-bridge wiring from this branch. The helper supersedes the
  // inline string construction; the graph spawn + inject append remain.
  const localMined = countLocalManifestEntries();
  // Use the shared renderer (extracted on main for testability / codex
  // review on PR #197) — keep `baseContext` here as the intermediate
  // because the rules block append below depends on a separate name
  // from the final `additionalContext` emitted to stdout.
  const localMinedNote = renderLocalMinedNote({ totalCount: localMined });

  // Local code graph context (Phase 3 v1.1). Cheap: reads ~/.memoree/...
  // /.last-build.json (small file populated by writeSnapshot) — never opens
  // the ~1 MB snapshot. Returns null when no graph exists for this repo, in
  // which case we add nothing (avoids a misleading "graph: 0 nodes" line
  // for users who've never run a build).
  //
  // Fire the async graph-pull worker BEFORE composing the inject. The
  // worker runs detached and will not affect THIS session's inject (the
  // pulled bytes land for the NEXT SessionStart to pick up). Putting the
  // spawn here is purely organizational — order doesn't matter because
  // the worker is fully detached.
  // Pull the latest snapshot from the selected SQL backend when available.
  if (storageAvailable) spawnGraphPullWorker(input.cwd ?? process.cwd(), __bundleDir);
  const graphLine = graphContextLine(input.cwd ?? process.cwd());
  const graphNote = graphLine ?? "";

  // Effective provider/identity after any Memoree-only directory routing.
  const effConfig = dirRes?.config ?? baseConfig;

  // Docs wiki note — the agent has no other way to learn the wiki exists.
  // Gated on the same local consent registry as auto sync (no network),
  // and worded on-demand, never wiki-first (see docs-context.ts).
  const docsNote = storageAvailable && effConfig
    ? docsWikiContextNote(effConfig.orgId ?? "", deriveProjectKey(input.cwd ?? process.cwd()).key)
    : "";

  // Disclose the EFFECTIVE identity (after any `.memoree` overlay), so a
  // directory that routes elsewhere (or opts out) is never silent.
  // NOT gated on `dirRes.collect`: the identity overlay now applies to reads
  // whether or not capture is on, so a `collect:false` directory can still be
  // routed — and must say so.
  const routed = !!(dirRes?.found && baseConfig &&
    (dirRes.config.orgId !== baseConfig.orgId || dirRes.config.workspaceId !== baseConfig.workspaceId));
  // `routed` covers reads AND capture — both resolve through the same overlay —
  // so the disclosure must never imply one moved without the other.
  const routedNote = routed ? ` · routed by ${dirRes?.found?.path}` : "";
  const provider = effConfig?.storage.kind ?? "sqlite";
  const identityLine = `Memoree memory backend: ${provider}${dirRes && !dirRes.collect ? ` · capture disabled by ${dirRes.found?.path}` : ""}`;
  const baseContext = storageAvailable && effConfig
    ? `${resolvedContext}\n\n${identityLine}${updateNotice}`
    : `${resolvedContext}\n\nLocal Memoree storage is unavailable; memory search is unavailable this session.${localMinedNote}${updateNotice}`;
  // Append the rules block when there's something to show, then
  // append the graph note (single line, may be empty). The renderer
  // returns "" on empty state OR failure, so the ternary stays terse.
  const withRules = rulesBlock
    ? `${baseContext}\n\n${rulesBlock}`
    : baseContext;
  const additionalContext = `${withRules}${graphNote}${docsNote}`;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  }));
  log(`hook done (${Date.now() - __hookT0}ms total)`);
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
