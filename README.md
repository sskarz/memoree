# Memoree

Memoree gives Claude Code and Codex persistent, local-first memory. SQLite,
configuration, graphs, model files, and captured sessions stay under
`~/.memoree`; local embeddings are enabled by default and require no Memoree
account or hosted service.

## Install

Requirements: Node.js 22.13 or newer, and Claude Code and/or Codex already
installed.

```sh
npx -y memoree install
```

That command initializes SQLite and local embeddings, copies the plugin to a
durable directory (`~/.local/share/memoree/pkg`, not the npx cache), and
wires every detected harness. Re-run it to upgrade. For lexical-only
retrieval: `npx -y memoree install --no-embeddings`.

Then:

- **Claude Code:** restart the session (or `/reload-plugins`).
- **Codex:** restart, then open `/hooks` and trust Memoree. Codex does not
  auto-trust plugin hooks; that step has to be a person.
- Check: `npx memoree doctor`

Later CLI commands also work through npx (`npx memoree status`,
`npx memoree uninstall`). Do not `npm link` a development clone — that
replaces the code Claude Code and Codex are already running.

### Ask an agent to install it

Paste this into Claude Code or Codex:

```
Install Memoree (local persistent memory for this agent). Requirements:
Node.js 22.13+. Do not clone the repository and do not npm link.

1. Check whether it is already installed: `npx -y memoree doctor`.
   If doctor reports the database and plugin as ok, stop and tell me.
2. Run `npx -y memoree install`.
3. Tell me to restart this session.
4. If this is Codex, tell me to open /hooks after restart and trust
   Memoree — you cannot complete that trust step for me.
```

## What Memoree does

Memoree is a SQLite-backed virtual filesystem at `~/.memoree/memory/`, plus
hooks on Claude Code and Codex, plus a CLI. Agents read team memory with
ordinary `cat` / `ls` / `grep` on that mount; the PreToolUse hook rewrites
those commands into queries. Supported sandboxed tools: `cat`, `ls`, `grep`,
`head`, `tail`, `wc`, `find`, `jq`, `echo`, `printf`, `tee`, and lifecycle
`mv`/`rm` for a single rule or goal file. Do not spawn subagents to read it.

### Memory files

| Path | Role |
|---|---|
| `identity.json` | userName, organization, workspace, backend |
| `rules.md` / `rules/{active,done}/` | shared rules |
| `goals.md` / `goal/<owner>/{opened,in_progress,closed}/` | goals |
| `kpi/<goal-id>/<kpi-id>.md` | KPIs on a goal |
| `index.md` | recent session inventory |
| `summaries/` | wiki/session reflections (search these first) |
| `sessions/` | rendered transcript fallback |
| `graph/query/<pattern>` | hybrid/semantic code-graph search |
| `graph/find/<pattern>` | substring search (not a synonym of `query`) |
| `graph/show`, `impact`, `neighborhood`, `layers`, `tour`, `path` | graph inspection |
| `docs/index.md`, `docs/find/<words>` | search generated docs |
| `docs/<file>.md` | doc for one source file |

### Hooks

**Claude Code:** SessionStart (inject + async setup, and auto-mine/backfill
when due), UserPromptSubmit (capture + recall), PreToolUse (Bash, Read,
Grep, Glob), PostToolUse / Stop / SubagentStop capture, SessionEnd (wiki
worker, plugin cache GC, graph auto-build).

**Codex:** SessionStart (matcher `startup|resume`), UserPromptSubmit capture,
PreToolUse Bash only, PostToolUse capture, Stop (capture + wiki + graph).
Codex has no SessionEnd and no `recall.js`; instructions live in a managed
block in `~/.codex/AGENTS.md`.

Claude Code and Codex are the only supported harnesses.

### CLI

```
memoree install|doctor|status|uninstall
memoree claude|codex install|uninstall
memoree backend status|check|use <sqlite|postgres>
memoree embeddings install|enable|disable|status|uninstall
memoree rules|goal|kpi|docs|context …
memoree graph build|diff|history|init|pull|uninstall
memoree skillify …
memoree memory backfill|flush
memoree sessions prune
```

History backfill, documentation ingestion, graph construction, and skill
mining are explicit operations; installation does not scan old agent history.
`memoree docs wiki` / `docs generate` / skillify `mine-local` call a host
LLM when you run them; they are not part of `install`.

## Development and stable runtime

Clone the repository only to change Memoree itself. Everyday use is
`npx -y memoree install` above.

```sh
git clone https://github.com/sskarz/memoree.git
cd memoree
npm ci
npm run build
```

Memoree uses three deliberately separate locations:

| Location | Purpose |
|---|---|
| development checkout | edit code and run source tests |
| `~/.local/share/memoree/pkg` | durable plugin copy staged by `npx memoree install` |
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
disposable state. Unattended GitHub Actions must not promote. A PR agent on a
disposable VM may run `runtime:validate` / `live:e2e` against isolated DBs;
it may promote only when that VM does not host daily operator sessions. See
[docs/TESTING.md](docs/TESTING.md).

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
npx memoree doctor
npx memoree status
npx memoree context
cat ~/.memoree/memory/identity.json
cat ~/.memoree/memory/rules.md
cat ~/.memoree/memory/goals.md
ls ~/.memoree/memory/
memoree docs list
memoree graph build
memoree embeddings status
```

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
npx memoree uninstall
npx memoree codex uninstall
```

Uninstalling integrations does not delete `~/.memoree`. Remove that specific
directory yourself only after making any desired backup.

## Testing (every PR, and live)

See [AGENTS.md](AGENTS.md) for the agent loop and [docs/TESTING.md](docs/TESTING.md)
for commands, isolation env, coverage map, and pass/fail measurement.

`npm run verify` is the everyday gate: strict TypeScript, a static check of
the JavaScript runtime validator, and source-level Vitest, without rebuilding
runtime bundles or installing hooks.

Every PR must report `npm run verify`. Runtime-affecting PRs must also run:

```sh
npm run build
npm test
git diff --check
```

When Claude and Codex are authenticated, add live gates against **isolated**
SQLite/config/memory paths (never the operator `~/.memoree`):

```sh
npm run runtime:validate    # promoted (or MEMOREE_RUNTIME_DIR) bundles, driven as Node
npm run live:e2e            # unaided claude -p / codex exec; no --bare, no --ephemeral
```

Those two are not duplicates. `runtime:validate` is the promote-completion
check (VFS writes, hook security, embeddings, `--bare` capture). `live:e2e`
proves plugin hooks actually fire. Measure a live pass by SQLite
`integrity_check=ok`, WAL mode, event and summary counts &gt; 0, 768-d
vectors, and the test UUID present in both agents’ answers **and**
`/summaries/%`. Missing keys or `--skip-live-codex` is a skip, not a pass.

For a major or runtime-affecting rollout, record the exact committed SHA and
its successful `npm run runtime:validate` (and, when hooks matter,
`npm run live:e2e`) before calling the runtime change complete. If that must
wait until sessions are closed, mark it pending in the PR.

### What is proven vs still source-only

Live harnesses on this repo have proven capture, wiki summaries, 768-d
embeddings, Claude↔Codex recall, structured rules/goals/KPIs, graph
`query`/`find` and related VFS paths, docs set/show, and skillify **status**.
Still source-tested rather than live-LLM’d: `docs wiki` generation (live
uses `--dry-run`), skillify mine/pull/push, graph `init`/`diff`/`pull`/
`uninstall`, `memory flush`, and the interactive TUI.

## License

See [LICENSE](LICENSE).
