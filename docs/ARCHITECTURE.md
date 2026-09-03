# Architecture

Memoree is a local-first memory layer for coding agents. The product is a
SQLite database plus a virtual filesystem at `~/.memoree/memory/`, hooks that
capture and recall during Claude Code / Codex / Antigravity sessions, and a
`memoree` CLI. SQLite is the source of truth. The VFS is a view of that data,
not a second store.

## Local-first storage

Memoree uses a provider-neutral SQL contract for parameterized queries,
transactions, schema discovery, additive schema healing, and cleanup. There are
two implementations:

- SQLite is the default. It uses Node's built-in `node:sqlite`, WAL mode,
  foreign keys, a busy timeout, and JSON-text vectors in
  `~/.memoree/memoree.sqlite3`.
- PostgreSQL is an advanced opt-in backend. It uses a bounded `pg` pool and a
  validated schema. Its connection string is read only from
  `MEMOREE_POSTGRES_URL`.

Both providers implement the same schemas for memory, sessions, skills, shared
rules, goals, KPIs, documents, and codebase snapshots. Application-side cosine
scoring supplies semantic retrieval, with lexical fallback whenever embeddings
are disabled, unavailable, or malformed.

Configuration under `~/.memoree/config.json` contains non-secret backend,
capture, embedding, and local identity settings. Detached workers receive only
provider kind and table metadata, then reload backend configuration in their
own process. PostgreSQL URLs are never serialized into worker handoffs.

## Capture and synthesis

Agent hooks append events directly to the selected SQL backend. Summary workers
read those events and invoke the agent's installed CLI; Claude Code synthesis
uses the local `claude` executable; Antigravity synthesis uses `agy -p` with
the user's Google login. The embedding daemon runs locally from
`~/.memoree/embed-deps`, caches its model under `~/.memoree/models`, and writes
vectors back through the same storage contract.

The virtual memory filesystem under `~/.memoree/memory` exposes indexes,
summaries, session records, and structured rule/goal state without introducing
another source of truth. SQLite remains authoritative; physical database and
configuration files are outside the virtual mount.

```text
~/.memoree/memory/
├── identity.json
├── rules.md
├── goals.md
├── rules/{active,done}/<rule-id>.md
├── goal/<owner>/{opened,in_progress,closed}/<goal-id>.md
└── kpi/<goal-id>/<kpi-id>.md
```

The inventory and identity files are read-only. Rule and goal files support
their narrow lifecycle operations through ordinary filesystem commands; KPI
files support creation and overwrite but not moves or removal. The hooks route
these commands through the VFS so the host shell never receives a virtual
filesystem operation.

## Integration model

| Agent | Installation | Main lifecycle |
|---|---|---|
| Claude Code | Local marketplace plugin | Session start, capture, recall, stop, session end |
| Codex | Explicit `memoree codex install` | Session start, capture, recall, stop, subagent stop, session end |
| Antigravity | Explicit `memoree antigravity install` | PreInvocation inject/recall, MCP memory, capture, stop |

Claude Code and Codex intercept `~/.memoree/memory` through host-command rewrite.
Antigravity cannot rewrite tool input, so memory is an MCP server wrapping the
same VFS and there is no PreToolUse gate (a deny hook is the only option and
makes every native tool look blocked). Default onboarding installs every detected harness. Graph setup,
documentation ingestion, history backfill, and skill mining remain explicit.

## What happens in a session

1. **SessionStart / PreInvocation** injects identity, active rules, open goals,
   and a short recall brief. It may spawn setup, auto-mine, memory backfill, or
   skill hygiene when those jobs are due.
2. **UserPromptSubmit** captures the prompt and runs recall (hybrid search over
   summaries and session events).
3. **PreToolUse** (Claude Code and Codex only) rewrites `cat` / `ls` / `grep` /
   `head` / `tail` / `wc` / `find` / `jq` / writes / `mv` / `rm` aimed at
   `~/.memoree/memory` into VFS queries. Interpreters and `rm -rf` are denied.
4. **PostToolUse / Stop / SubagentStop** append tool and assistant events.
5. **SessionEnd / Stop** detaches a wiki worker. That worker reads session
   rows, calls the host CLI (`claude -p`, `codex exec`, or `agy -p`), writes a
   structured summary, embeds it (768 dimensions), and stores it under
   `/summaries/…`. Graph auto-build also runs on stop when the cwd is a git repo.

Detached workers (wiki, skillify, hygiene, graph pull) are fire-and-forget Node
processes. They must never crash the hook that spawned them.

## Repository layout

```text
src/                    TypeScript core, CLI, hooks, storage, retrieval
harnesses/              Claude Code, Codex, and Antigravity manifests, skills, and bundles
embeddings/             Standalone local embedding daemon entry
docs/                   User, architecture, and testing documentation
scripts/                Build, runtime-management, and verification utilities
tests/                  Runtime-specific and shared Vitest coverage
library/                Archived QA and requirements records
experimental/pi/        Frozen, unsupported pi snapshot — do not reactivate
bundle/                 Generated `memoree` executable bundle
```

Generated `dist/` and `bundle/` files are produced by `npm run build` and are
not edited manually.

## `src/` module tour

Read this as the runtime map. Every directory below is loaded by the CLI,
a hook bundle, or both.

### `src/cli/` — installer and `memoree` entry

`index.ts` is the CLI router (`install`, `doctor`, `status`, `backend`,
`embeddings`, `rules`, `goal`, `kpi`, `docs`, `context`, `graph`, `skillify`,
`memory`, `sessions`). `run-install.ts` / `run-uninstall.ts` orchestrate
staging plus per-harness wiring. `install-claude.ts`, `install-codex.ts`, and
`install-antigravity.ts` write hook JSON, skills, and AGENTS.md / MCP config.
`embeddings.ts` manages the local model runtime. `util.ts` is shared FS and
platform detection.

### `src/commands/` — CLI subcommand implementations

Doctor, backend switch, rules/goals/KPIs, docs, context, graph, skillify,
memory backfill/flush, session prune. These talk to storage and VFS helpers;
they do not install hooks.

### `src/hooks/` — session lifecycle

Shared capture, recall, PreToolUse, SessionEnd, wiki spawn, graph-on-stop,
plugin-cache GC. `hooks/shared/` holds gates, redact, recall formatting, the
memory-command contract, and the shared wiki spawn/prompt. `hooks/codex/` and
`hooks/antigravity/` are harness-specific entry points (different payload
shapes, Codex Bash-only PreToolUse, Antigravity PreInvocation + no PreToolUse).

Wiki spawn is one core (`hooks/shared/wiki-spawn.ts`) with thin wrappers that
supply hooks dir, plugin marker, and host binary. Prompt text lives in
`hooks/shared/wiki-prompt.ts`. The three `wiki-worker.ts` files stay separate
because each shells out to a different CLI.

### `src/shell/` — VFS implementation

`memoree-fs.ts` is the virtual filesystem. `grep-core.ts` is the SQL search
used by every path. `grep-direct.ts` (under hooks) is the PreToolUse fast path;
`grep-interceptor.ts` is the slow path inside `memoree-shell.ts` when a command
falls through to the sandbox shell.

### `src/storage/` — SQL backends

`backend.ts` is the interface. `sqlite.ts` and `postgres.ts` implement it.
`factory.ts` picks one from config/env. `schema.ts` defines tables and heals
missing columns. `sql-dialect.ts` and `vector-search.ts` keep queries portable.
Import `factory.js` or `backend.js` directly — there is no barrel file.

### `src/mcp/` — Antigravity memory server

`server.ts` plus `vfs-tools.ts` expose the same VFS jobs as MCP tools
(`memoree_ls`, `memoree_read`, `memoree_grep`, …). Session capture/summary
workers persist MCP tool calls when `agy` does not run named hooks.

### `src/docs/` — generated documentation wiki

Fingerprint, generate, refresh, pull, promote, embed, and VFS routing for
`docs/index.md`, `docs/find/<words>`, and `docs/<file>.md`. Wiki pages are a
separate LLM pipeline (`wiki-generate`, `wiki-update`, `wiki-refresh`).

### `src/graph/` — codebase graph

Tree-sitter extractors under `extract/`, snapshot push/pull, hybrid
`query` vs substring `find`, and VFS routes (`show`, `impact`, `neighborhood`,
`layers`, `tour`, `path`). Builds are git-only: `graph build` refuses a
non-git cwd.

### `src/skillify/` — skill mining and sharing

Mine reusable skills from session logs, pull/push an org table, hygiene,
skillopt (improve a skill after a failed invocation), and detached workers
spawned from SessionStart / Stop. Canonical writes stay under `.claude/skills`
and fan out to Codex / Gemini / project skill roots.

### `src/embeddings/` — local vectors

Daemon, nomic client, protocol, SQL helpers, disable/self-heal. Default on;
`install --no-embeddings` is lexical-only. Vectors are 768-dimensional.

### `src/rules/`, `src/notifications/`, `src/utils/`

Rules are a small CRUD + VFS barrel. Notifications parse Claude/Codex
transcripts for model-usage recap on session end. Utils cover spawn, atomic
writes, plugin cache GC, repo identity, project names, SQL helpers, and
`bundleDirFromImportMeta`.

### Top-level config

`config.ts` loads storage + table names. `dir-config.ts` routes per-directory
overrides. `user-config.ts` holds embeddings/docs LLM preferences.

## Other top-level directories

| Path | Role |
|---|---|
| `harnesses/` | Plugin manifests, skills, and esbuild output for the three agents |
| `embeddings/` | Built `embed-daemon.js` (do not edit) |
| `scripts/` | `verify`, pack check, runtime promote/validate, live e2e, version sync |
| `tests/shared/` | Agent-independent product tests (preferred location for new tests) |
| `tests/claude-code/` | Claude hook tests plus older shared tests not yet moved |
| `tests/codex/`, `tests/cli/`, `tests/scripts/` | Harness, installer, and script tests |
| `library/` | Archived PRDs and QA notes — not runtime |
| `experimental/pi/` | Frozen snapshot. Excluded from builds, tests, and support |

## Build and runtime

`npm run build` type-checks, then `esbuild.config.mjs` emits:

- `bundle/cli.js` — the `memoree` binary
- `harnesses/*/bundle/` — hook + worker + shell + embed daemon per agent
- `embeddings/embed-daemon.js` — standalone daemon

Development checkouts are for editing and tests. Everyday agents load the
promoted/installed copy (`npx -y @sskarz/memoree install` or
`~/.local/share/memoree-runtime`). Never `npm link` this tree on a machine
that already runs daily Claude Code or Codex.

## Recent product direction

The current tree is the result of collapsing a multi-agent, cloud-tinged
product into a local-first three-harness system:

- Branding and cloud commands (`login`, hosted API tokens) were removed.
- Cursor / pi harnesses were dropped; pi remains only as `experimental/pi/`.
- Memory is project-scoped (`project_key` from git remote or absolute path).
- Graph builds are git-only. Antigravity memory is MCP, not PreToolUse.
- Skills fan out from a Claude-canonical directory to other agent roots.

When something looks duplicated (three wiki workers, three installers, two
grep paths), it is usually a harness or layer boundary, not leftover code.
