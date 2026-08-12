# Memoree for Claude Code

Memoree is a local-first memory layer for Claude Code. A default installation
stores captured events, session summaries, rules, goals, skills, documents, and
graph snapshots in `~/.memoree/memoree.sqlite3`. No account or credentials are
required.

## Install from a checkout

```sh
git clone https://github.com/sskarz/memoree.git
cd memoree
npm ci
npm run build
npm link
memoree install
memoree doctor
```

`memoree install` initializes SQLite, installs the local embedding runtime and
default model, registers this checkout as a Claude Code marketplace, and enables
`memoree@memoree` at user scope. Restart Claude Code after installation.

Use `memoree install --no-embeddings` for lexical-only retrieval. That opt-out
does not affect capture or summaries. Use `memoree install --all` only when you
want every detected agent integration; the default installs Claude Code alone.

## Verify and troubleshoot

Run `memoree doctor` to check database integrity, all required schema tables,
the embedding runtime and model cache, the Claude executable, plugin
registration, and hook bundles. A failing database or embedding setup makes
installation exit nonzero and prints a command to retry or opt out.

Useful paths:

- `~/.memoree/config.json` — non-secret local settings
- `~/.memoree/memoree.sqlite3` — default database
- `~/.memoree/models/` — embedding model cache
- `~/.memoree/embed-deps/` — shared embedding runtime
- `~/.memoree/memory/` — virtual memory filesystem

Existing data in other product directories is ignored. Memoree neither imports
nor modifies it.

## Advanced PostgreSQL backend

PostgreSQL is an explicit shared/managed option. Keep the connection string in
the environment; Memoree never writes it to configuration or worker handoffs.

```sh
export MEMOREE_BACKEND=postgres
export MEMOREE_POSTGRES_URL='postgresql://user:password@host/database'
export MEMOREE_POSTGRES_SCHEMA=memoree
memoree install
memoree doctor
```

See [README.md](README.md) for privacy, captured data, removal, testing, and
advanced integration commands.
