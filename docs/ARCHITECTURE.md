# Architecture

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
| Codex | Explicit `memoree codex install` | Session start, capture, recall, stop |
| Antigravity | Explicit `memoree antigravity install` | PreInvocation inject/recall, MCP memory, capture, stop |

Claude Code and Codex intercept `~/.memoree/memory` through host-command rewrite.
Antigravity cannot rewrite tool input, so memory is an MCP server wrapping the
same VFS. Default onboarding installs every detected harness. Graph setup,
documentation ingestion, history backfill, and skill mining remain explicit.

## Repository layout

```text
src/                    TypeScript core, CLI, hooks, storage, retrieval
harnesses/              Claude Code, Codex, and Antigravity manifests, skills, and bundles
embeddings/             Standalone local embedding daemon entry
docs/                   User, architecture, and testing documentation
scripts/                Build, runtime-management, and verification utilities
tests/                   Runtime-specific and shared Vitest coverage
library/                 Archived QA and requirements records
bundle/                  Generated `memoree` executable bundle
```

Generated `dist/` and `bundle/` files are produced by `npm run build` and are
not edited manually.
