# Memoree

Memoree gives Claude Code and Codex persistent, local-first memory. SQLite,
configuration, graphs, model files, and captured sessions stay under
`~/.memoree`; local embeddings are enabled by default and require no Memoree
account or hosted service.

## Install from source

Requirements: Git, Node.js 22.13 or newer, and an authenticated Claude Code or
Codex CLI.

```sh
git clone https://github.com/sskarz/memoree.git
cd memoree
npm ci
npm run build
npm link
memoree install
memoree codex install  # when using Codex
memoree doctor
```

`memoree install` initializes SQLite and local embeddings, then installs the
Claude Code plugin. `memoree codex install` adds the Codex hooks and skill. Both
installers are idempotent and preserve unrelated user configuration. Restart
the affected agent after installation.

For lexical-only retrieval, use `memoree install --no-embeddings`.

## Development and stable runtime

Memoree uses three deliberately separate locations:

| Location | Purpose |
|---|---|
| development checkout | edit code and run source tests |
| `~/.local/share/memoree-runtime` | detached, committed revision loaded globally by Claude Code and Codex |
| `~/.memoree` | durable user database, configuration, graphs, models, and logs |

Never globally link or register the development checkout. Initialize the
stable runtime only after closing every Claude Code and Codex session:

```sh
npm run verify
npm run runtime:init -- HEAD
npm run runtime:validate
```

The runtime command resolves `HEAD` (or another supplied Git ref) to an
immutable commit, creates the detached worktree, installs dependencies and
builds inside it, globally links Memoree from it, points the Claude marketplace
at it, installs the Codex hooks from it, and runs `memoree doctor`. Existing
`~/.memoree` state is not moved or replaced.

Claude Code and Codex load Memoree globally. The runtime checkout chooses which
Memoree revision is installed; it does not limit Memoree to projects inside
that checkout.

## Promote, validate, and roll back

Promote only a committed revision and only with explicit user authorization
after all agent sessions are closed:

```sh
git status --short
npm run verify
npm run runtime:promote -- <commit-sha>
npm run runtime:validate
```

Promotion refuses a dirty runtime checkout or active Claude/Codex processes.
It records the prior SHA under `~/.local/state/memoree/runtime.json` and
automatically restores that revision if checkout, build, installation, or
doctor fails. It never terminates an agent process.

Validation creates a disposable Git repository and isolated SQLite/config/
memory paths, checks Claude-to-Codex semantic recall, lexical fallback with
embeddings disabled, SQLite integrity and WAL mode, captured events and
summaries, and 768-element embeddings. It removes the disposable state even on
failure; synthetic records never use the real database.

Promotion is not completion. A major or runtime-affecting change is complete
only after `npm run runtime:validate` exits successfully for the exact promoted
commit. If any phase fails, fix the defect in the development checkout,
commit and push it, promote the new SHA, and validate again. If authentication
or another external dependency blocks validation, record the exact failing
phase and evidence; do not report a successful rollout.

Validation requires authenticated Claude Code and Codex CLIs and closed
interactive sessions. It exercises the globally installed integrations against
disposable state. Run it manually with explicit authorization, not in
unattended PR automation.

Restore the previously recorded revision with:

```sh
npm run runtime:rollback
```

Rollback applies the same clean-worktree, closed-session, build, installation,
and doctor checks as promotion.

## Update

Update the development checkout, verify it, commit any local work, and promote
the desired commit:

```sh
git pull --ff-only
npm ci
npm run verify
npm run runtime:promote -- origin/main
npm run runtime:validate
```

## Everyday commands

```sh
memoree doctor
memoree status
memoree context
cat ~/.memoree/memory/identity.json
cat ~/.memoree/memory/rules.md
cat ~/.memoree/memory/goals.md
ls ~/.memoree/memory/
memoree docs list
memoree graph build
memoree embeddings status
```

History backfill, documentation ingestion, graph construction, and skill mining
are explicit operations; installation does not scan or import old agent
history.

## PostgreSQL (advanced)

SQLite is the credential-free default. PostgreSQL remains an opt-in backend for
shared deployments; its URL is read only from the environment and is never
persisted or printed.

```sh
export MEMOREE_POSTGRES_URL='postgresql://user:password@host/database'
memoree backend use postgres --schema memoree
memoree backend check
```

Return to local SQLite with `memoree backend use sqlite`.

## Remove integrations

```sh
memoree uninstall
memoree codex uninstall
```

Uninstalling integrations does not delete `~/.memoree`. Remove that specific
directory yourself only after making any desired backup.

## Development checks

`npm run verify` is the routine local gate: strict TypeScript, a static check of
the JavaScript runtime validator, and source-level Vitest, without rebuilding
runtime bundles.

Every PR must report `npm run verify`. Major or runtime-affecting PRs must also
run:

```sh
npm run build
npm test
git diff --check
```

For a major or runtime-affecting PR, record the exact committed SHA and its
successful `npm run runtime:validate` result before declaring the rollout
complete. When validation cannot run before merge because authenticated agent
sessions must be closed, mark that gate pending and complete it manually after
merge. Documentation-only and other non-runtime PRs do not require promotion.

## License

See [LICENSE](LICENSE).
