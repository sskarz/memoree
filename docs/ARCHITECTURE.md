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
uses the local `claude` executable. The embedding daemon runs locally from
`~/.memoree/embed-deps`, caches its model under `~/.memoree/models`, and writes
vectors back through the same storage contract.

The virtual memory filesystem under `~/.memoree/memory` exposes indexes,
summaries, and session records without introducing another source of truth.

## Integration model

| Agent | Installation | Main lifecycle |
|---|---|---|
| Claude Code | Local marketplace plugin | Session start, capture, recall, stop, session end |
| Codex | Explicit `memoree codex install` | Session start, capture, recall, stop |
| Cursor | Explicit `memoree cursor install` | Session start, prompt/tool capture, stop, session end |
| Hermes | Explicit `memoree hermes install` | Hooks, skill, and MCP |
| OpenClaw | Explicit `memoree claw install` | Native extension and contracted tools |
| pi | Explicit `memoree pi install` | Extension, recall, capture, summary worker |

Default onboarding installs Claude Code only. Other integrations, graph setup,
documentation ingestion, history backfill, and skill mining remain explicit.

## Repository layout

```text
src/                    TypeScript core, CLI, hooks, storage, retrieval
harnesses/              Per-agent manifests, skills, and packaged bundles
embeddings/             Standalone local embedding daemon entry
docs/                   User and architecture documentation
scripts/                Build, packaging, audit, and verification utilities
tests/                   Runtime-specific and shared Vitest coverage
library/                 Archived QA and requirements records
bundle/                  Generated `memoree` executable bundle
```

Generated `dist/` and `bundle/` files are produced by `npm run build` and are
not edited manually.
