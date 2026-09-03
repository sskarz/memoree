# Memoree for Claude Code

Memoree is a local-first memory layer for Claude Code. A default installation
stores captured events, session summaries, rules, goals, skills, documents, and
graph snapshots in `~/.memoree/memoree.sqlite3`. No account or credentials are
required.

Everyday install (not from a development clone):

```sh
npm view @sskarz/memoree repository.url
npx -y @sskarz/memoree install
```

The repository URL must be `git+https://github.com/sskarz/memoree.git`. Then
restart Claude Code (or `/reload-plugins`) and run `npx @sskarz/memoree doctor`.

`memoree install` initializes SQLite, installs the local embedding runtime by
default, stages a durable plugin copy, and wires every detected harness
(Claude Code, Codex, Antigravity). Use `--no-embeddings` for lexical-only
retrieval. That opt-out does not affect capture or summaries.

## Install from a checkout (Memoree development only)

```sh
git clone https://github.com/sskarz/memoree.git
cd memoree
npm ci
npm run build
node bundle/cli.js install
node bundle/cli.js doctor
```

Never `npm link` a development checkout. Claude Code and Codex load Memoree
globally; linking this tree replaces the code those sessions are already
running. See [AGENTS.md](AGENTS.md) and [README.md](README.md).

## Verify and troubleshoot

Run `memoree doctor` to check database integrity, required schema tables,
the embedding runtime and model cache, the Claude executable, plugin
registration, and hook bundles.

Useful paths:

- `~/.memoree/config.json` — non-secret local settings
- `~/.memoree/memoree.sqlite3` — default database
- `~/.memoree/models/` — embedding model cache
- `~/.memoree/embed-deps/` — shared embedding runtime
- `~/.memoree/memory/` — virtual memory filesystem

## Advanced PostgreSQL backend

PostgreSQL is an explicit shared/managed option. Keep the connection string in
the environment; Memoree never writes it to configuration or worker handoffs.

```sh
export MEMOREE_BACKEND=postgres
export MEMOREE_POSTGRES_URL='postgresql://user:password@host/database'
export MEMOREE_POSTGRES_SCHEMA=memoree
npx -y @sskarz/memoree install
npx @sskarz/memoree doctor
```

See [README.md](README.md) for privacy, captured data, removal, testing, and
advanced integration commands. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for how hooks, storage, and the VFS fit together.
