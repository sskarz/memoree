# Memoree

Memoree gives coding agents persistent, local-first memory. The default setup uses SQLite at `~/.memoree/memoree.sqlite3`, runs embeddings on your machine, and installs the Claude Code plugin. It requires no Memoree account, browser flow, PostgreSQL server, or hosted memory service.

## Quick start with Claude Code

Requirements:

- Node.js 22.13 or newer
- Claude Code installed, authenticated, and available as `claude` on `PATH`

The recommended installation is three commands:

```sh
npm install --global memoree
memoree install
memoree doctor
```

The first `memoree install` downloads the local embedding runtime and model, so it can take a few minutes. It then creates `~/.memoree/config.json`, initializes the SQLite database, registers the packaged Claude Code marketplace, and enables `memoree@memoree` for the current user. The command is safe to rerun after an update.

Restart Claude Code after installation. Start it inside a Git repository and work normally: Memoree's hooks capture the session locally, synthesize a summary when the session ends normally, and make relevant context available to later sessions. Installation does not scan or import old Claude history.

If npm reports that `memoree` is not found, its first public release is not live yet. Install this checkout from source instead:

```sh
git clone https://github.com/sskarz/memoree.git
cd memoree
npm ci
npm run build
npm link
memoree install
memoree doctor
```

To avoid the model download and use lexical retrieval only:

```sh
memoree install --no-embeddings
```

## What stays local

Memoree captures agent session events, summaries, memories, goals and KPIs, shared rules, generated skills, documents, and codebase graph snapshots. SQLite state, embedding dependencies, model cache, daemon state, and logs live under `~/.memoree`.

Embeddings use the bundled local runtime; no memory content is sent to an embedding service. Session synthesis continues to invoke the installed Claude Code CLI, so its normal provider and privacy settings still apply. Memoree itself does not authenticate to or contact a hosted Memoree service.

Existing data in older product directories is ignored. Installation is a fresh start: it does not scan, import, modify, or migrate prior configuration or databases.

## Everyday commands

```sh
memoree doctor
memoree status
memoree context
memoree rules list
memoree goal list
memoree docs list
memoree graph build
memoree embeddings status
```

History backfill, documentation ingestion, graph initialization, and skill mining are explicit operations; onboarding does not run them automatically. Run `memoree --help` and the relevant subcommand help for details.

You do not need these commands for automatic session memory. They expose Memoree's optional, explicit workflows:

```sh
memoree rules add "Always run tests before committing"
memoree goal add "Finish the authentication refactor"
memoree docs index ./docs
memoree graph build
memoree context
```

## Update

For an npm installation:

```sh
npm install --global memoree@latest
memoree install
memoree doctor
```

For a source installation, pull the checkout, run `npm ci`, `npm run build`, and `npm link`, then rerun `memoree install`. Restart Claude Code after either update path.

## Other agents

Claude Code is the focused default. Target another integration explicitly:

```sh
memoree codex install
memoree cursor install
memoree hermes install
memoree pi install
memoree claw install
memoree install --all
```

`--all` installs every detected integration. It is never implied by the default install.

## PostgreSQL (advanced)

PostgreSQL is an opt-in backend for shared or managed databases. The connection string is read only from the environment and is never written to config, printed, or included in worker handoffs.

```sh
export MEMOREE_POSTGRES_URL='postgresql://user:password@host/database'
memoree backend use postgres --schema memoree
memoree backend check
```

Return to the default local database with:

```sh
memoree backend use sqlite
```

Repository-specific non-secret routing can be placed in `.memoree` or `.memoree.local` using `repositoryKey` and `collect`. `.memoree.local` should remain untracked.

## Troubleshooting

Run `memoree doctor` first. It checks the selected database, required schema, embedding installation, Claude Code executable, plugin registration, and hook bundles.

- Database failure: verify permissions under `~/.memoree`, or check `MEMOREE_POSTGRES_URL` when PostgreSQL is selected.
- Embedding failure: run `memoree embeddings install`; use `--no-embeddings` if lexical-only retrieval is acceptable.
- Plugin failure: confirm `claude --version` and authentication, then rerun `memoree install`. For a source checkout, rebuild first with `npm run build`.
- Hook changes not visible: restart Claude Code.

## Remove

```sh
memoree uninstall
memoree embeddings uninstall --prune
```

Uninstalling the plugin does not delete memory. If you also want to remove local state, delete the specific `~/.memoree` directory yourself after making any desired backup. Older product directories remain untouched.

## Development

```sh
npm ci
npm run build
npm test
npm run ci
npm run pack:check
```

SQLite tests run without credentials. PostgreSQL contract tests use `MEMOREE_TEST_POSTGRES_URL` in CI against PostgreSQL 16.

Before an npm release, `npm run pack:check` verifies that the tarball contains the CLI, local embedding daemon, and Claude Code plugin without including repository credentials or CI metadata. Publishing is intentionally a separate maintainer action; preparing this repository does not publish a package.

## License

See [LICENSE](LICENSE).

## Acknowledgments

Memoree began as a fork of [Hivemind](https://github.com/activeloopai/hivemind). It is now maintained as an independent project, with gratitude to the original project and its contributors.
