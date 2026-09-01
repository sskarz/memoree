# Repository Guidelines

## Isolated Development and Runtime

Use this development checkout only for editing, source tests, and commits.
Never run `npm link`, register a marketplace, or install global hooks from the
development checkout. Claude Code and Codex load Memoree globally, so those
actions can replace the code used by active sessions.

Use `npm run verify` for routine validation. Runtime promotion requires an
immutable committed revision, explicit user authorization, and all Claude Code
and Codex sessions closed. Use only `npm run runtime:init`,
`runtime:promote`, `runtime:validate`, and `runtime:rollback` to manage the
detached checkout at `~/.local/share/memoree-runtime`; never terminate sessions
to force a promotion.

Promotion is not completion. For every major or runtime-affecting change,
promote the exact committed SHA and require `npm run runtime:validate` to exit
successfully before reporting the runtime change complete. If validation
fails, diagnose the first failed phase, fix and commit the defect, push it,
promote the new SHA, and repeat validation. If an external dependency blocks
validation, report the exact failing phase and evidence instead of claiming
success.

Production state belongs under `~/.memoree`. Automated tests and validation
must use isolated temporary homes, config paths, and SQLite databases. Never
write synthetic records to the real database. Claude Code, Codex, and
Antigravity are the supported harnesses. The frozen pi snapshot under
`experimental/pi/` is excluded from builds, tests, CLI discovery, graph
extraction, and support.

`npm run runtime:promote` is never unattended GitHub Actions and never runs
on a laptop that already hosts daily Claude Code or Codex sessions unless the
operator explicitly asked to change that runtime. A disposable PR VM with no
daily operator sessions may promote a PR SHA in order to run unaided live
hooks. `runtime:validate` and `live:e2e` use isolated DBs; they are not a
promote. See [docs/TESTING.md](docs/TESTING.md).

## PR verification loop

The purpose of this section is a repeatable agent loop on every PR. Follow it
in order. Do not skip a failed gate by running a later one. Do not report a
live pass when keys were missing.

### 0. Classify the PR

- **Docs-only / non-runtime:** `AGENTS.md`, `README.md`, `docs/` (except live
  harness scripts), comments. Gate: `npm run verify` and `git diff --check`.
- **Runtime-affecting:** anything under `src/`, `harnesses/`,
  `scripts/runtime-*.mjs`, `scripts/live-session-e2e.mjs`, hook JSON, CLI
  bundle graph, or tests that lock those. Gates: source + build + `npm test`
  + live when keys exist.

### 1. Isolated source (every PR)

```sh
npm run verify
```

Pass: exit 0. This is TypeScript, a static check of `scripts/runtime-validate.mjs`,
and source-level Vitest. It does not rebuild bundles and does not install
hooks.

### 2. Built artifacts (runtime-affecting)

```sh
npm run build
npm test
git diff --check
```

Pass: exit 0, no whitespace errors. `npm test` includes built-artifact suites
that `verify` does not.

### 3. Authenticated live (when keys and CLIs exist)

Keys from a chmod-600 file, never from the repo. Isolated DBs only.

```sh
set -a; . "$HOME/.config/memoree-live.env"; set +a
export PATH="$HOME/.npm-global/bin:$PATH"
```

**Without promoting** (safe on a laptop; tests whatever
`~/.local/share/memoree-runtime` currently is, or `$PWD` if you override):

```sh
MEMOREE_RUNTIME_DIR="$PWD" npm run runtime:validate
```

That proves this checkout’s hook bundles via direct Node invocation plus
`claude --bare` / `codex exec` / Antigravity hook bundles. It does **not**
prove the installed Claude plugin. Live `agy -p` is skipped when `agy` is
missing or not signed in (`LIVE_SKIPPED`), not treated as a pass.

**Unaided hooks** need the promoted/installed plugin:

```sh
npm run live:e2e
```

`live:e2e` must use `claude -p` without `--bare` and `codex exec` without
`--ephemeral`. Codex sandbox must be `-s read-only` so `~/.memoree/memory`
is not a missing workspace path.

On a disposable VM whose job is this PR, the complete live proof is:

```sh
npm run runtime:promote -- "$(git rev-parse HEAD)"
npm run runtime:validate
npm run live:e2e
```

If Codex credits are absent: `npm run runtime:validate -- --skip-live-codex`
and record **Codex live skipped**, not passed. If `agy` is missing or not
signed in: `npm run runtime:validate -- --skip-live-antigravity` and record
**Antigravity live skipped**, not passed. Antigravity wiki workers spawn
`agy -p` and inherit the user's Google login; do not write
`modelProvider: "gemini"` into the operator `~/.gemini` settings.

### 4. How to measure

Live is green only when all of these hold:

- SQLite `integrity_check=ok` and `journal_mode=wal`
- session events &gt; 0 and summaries under `/summaries/%` &gt; 0
- at least one **768-element** embedding
- the Claude identifier appears in sessions **and** is recoverable later
  (Claude recall + Codex recall / `grep` of `~/.memoree/memory/summaries/`)
- `runtime:validate` structured VFS: rule/goal/KPI edits persist; unsafe
  `rm -rf` on the mount is denied
- `live:e2e` final line reports event and summary counts; on failure the
  workspace path is printed and kept

Fail closed:

- Missing `claude` / `codex` / `agy` / API key → `LIVE_SKIPPED`, not success
- Rate limit or credit error → failed phase + excerpt, not success
- 0 events after a live session → hooks did not persist; fail
- Identifier invented by the model instead of echoed → fail
- Any write to the operator `~/.memoree` SQLite file → fail the protocol

### 5. What not to do in the loop

- Do not `npm link` this development checkout.
- Do not `runtime:promote` on a machine with open or daily Claude/Codex
  sessions.
- Do not use `claude --bare` or `codex --ephemeral` as the unaided-hook proof.
- Do not treat `runtime:validate` and `live:e2e` as duplicates you can drop.
  The first drives bundles; the second needs the real plugin.
- Do not claim wiki generation, skillify mine/pull/push, graph
  init/diff/pull/uninstall, or `memory flush` were live-LLM’d unless you
  actually ran those commands against a model. They have source tests.

## Feature inventory for verification agents

Memoree is a SQLite-backed virtual filesystem at `~/.memoree/memory/` plus
hooks on Claude Code, Codex, and Antigravity and a `memoree` CLI.

### VFS (read through sandboxed `cat` / `ls` / `grep` / `head` / `tail` / `find`)

- `identity.json`, `rules.md`, `goals.md`
- `rules/{active,done}/<id>.md` and `goal/<owner>/{opened,in_progress,closed}/<id>.md`
- `kpi/<goal-id>/<kpi-id>.md`
- `index.md`, `summaries/`, `sessions/`
- `graph/query|find|show|impact|neighborhood|layers|tour|path/…`
  (`query` is hybrid/semantic; `find` is substring)
- `docs/index.md`, `docs/find/<words>`, `docs/<source-file>.md`

Writes on the mount are limited to `echo` / `printf` / `tee` with validated
redirects; `mv`/`rm` only transition rule or goal lifecycle. Interpreters,
network clients, and `find -exec` are denied. Do not spawn subagents to read
this mount.

### Claude Code hooks

SessionStart (+ async setup), UserPromptSubmit capture + recall, PreToolUse
(Bash/Read/Grep/Glob), PostToolUse/Stop/SubagentStop capture, SessionEnd
(wiki worker + plugin-cache-gc + graph-on-stop). SessionStart also spawns
auto-mine and memory backfill when due.

### Codex hooks

SessionStart (+ setup, matcher `startup|resume|clear|compact`), UserPromptSubmit
capture + recall, PreToolUse Bash only (Codex documents shell as `Bash`; there
is no Read/Grep/Glob tool), PostToolUse / Stop / SubagentStop capture,
SessionEnd (wiki worker). Graph auto-build stays on Stop because Codex
SessionEnd is advisory and capped at 3s. plugin-cache-gc is Claude-plugin-cache
specific. Standing memory instructions also live in a managed block in
`~/.codex/AGENTS.md`.

### Antigravity hooks

PreInvocation (first-call inject + recall + setup spawn), PreToolUse (steer
off the virtual mount; never `allow`), PostToolUse capture, Stop (capture +
wiki + graph). Memory is MCP (`memoree_ls` / `memoree_read` / `memoree_grep`
/ `memoree_write` / `memoree_mv` / `memoree_rm`) wrapping the existing VFS.
Claude Code and Codex keep intercept-and-rewrite. Wiki workers spawn
`agy -p --dangerously-skip-permissions` and inherit the user's Google login.

### CLI (supported)

`install` / `doctor` / `status` / `uninstall`; `claude|codex|antigravity install|uninstall`;
`backend`; `embeddings`; `rules` / `goal` / `kpi` / `docs` / `context`;
`graph build|diff|history|init|pull|uninstall`; `skillify` (status, scope,
team, install, promote, pull, push, unpull, mine-local, hygiene);
`memory backfill|flush`; `sessions prune`.

Coverage of each row, including what live still skips, is the table in
[docs/TESTING.md](docs/TESTING.md).

## Project Structure

Core TypeScript lives in `src/`. CLI code is under `src/cli/` and
`src/commands/`; shared hooks are in `src/hooks/shared/`, with Codex-specific
hooks in `src/hooks/codex/` and Antigravity-specific hooks in
`src/hooks/antigravity/`. Runtime packaging lives in `harnesses/`, docs in
`docs/`, utilities in `scripts/`, and QA records in `library/`.

Tests are grouped under `tests/claude-code/`, `tests/codex/`, `tests/cli/`, and
`tests/shared/`. Put new agent-independent coverage in `tests/shared/`. Build
outputs (`dist/`, `bundle/`, harness bundles, and `embeddings/`)
are generated and must not be edited by hand. Do not add a fourth harness.

## Commands

- `npm ci` installs dependencies; Node.js 22.13 or newer is required.
- `npm run verify` runs TypeScript checks, the runtime-validator JavaScript
  check, the npm pack manifest check, and source-level Vitest without rebuilding bundles.
- `npm run build` type-checks and builds the CLI and supported runtime bundles.
- `npm test` runs the full source and built-artifact suite.
- `npm run live:e2e` runs unaided Claude Code + Codex sessions against an
  isolated DB (needs promoted runtime bundles, authenticated CLIs). Antigravity
  unaided `agy` is skipped when the CLI is missing or not signed in.
- `npm run runtime:validate` is the promote-completion live gate (needs
  promoted or `MEMOREE_RUNTIME_DIR` bundles).
- `npx vitest run tests/shared/atomic-write.test.ts` targets one test file.
- `npx vitest run tests/shared/graph-query-and-hygiene.test.ts` is the isolated
  VFS/product walkthrough for graph `query/` and skill hygiene.
- `npx vitest run tests/shared/harness-wiring.test.ts` checks Claude Code,
  Codex, and Antigravity MCP hook routing only. See `docs/TESTING.md`.
- `git diff --check` catches whitespace errors before commit.

## Code and Tests

Use strict TypeScript, ES modules, two-space indentation, double quotes, and
semicolons. Include `.js` extensions in relative imports for compiled Node ESM.
Use camelCase for values, PascalCase for types, and kebab-case filenames. Match
nearby code; there is no standalone formatter.

Use Vitest with `*.test.ts` names. Cover success, failure, idempotency,
configuration preservation, and platform-specific branches. Inject filesystem,
timing, process, and environment seams instead of using live services or real
home directories. Add new source files to the per-file coverage thresholds in
`vitest.config.ts`, normally at 80%.

When you add a user-visible feature, add a row to the coverage map in
`docs/TESTING.md` and a source test that would fail if the feature were
unwired (the SessionStart auto-spawn lock in
`tests/shared/session-start-auto-spawn.test.ts` is the pattern).

## Commits and Pull Requests

Use focused Conventional Commits such as `fix(runtime): ...`, `feat(graph): ...`,
`test(summary): ...`, or `docs: ...`. PRs need a clear summary and test plan,
relevant tests, and confirmation of `npm run verify`. Major or runtime-affecting
PRs also require `npm run build`, `npm test`, and `git diff --check`. Record the
exact committed SHA and its successful `npm run runtime:validate` result before
declaring the runtime change complete. If authenticated validation must happen
after merge because sessions must be closed, mark that gate pending and do
not treat the rollout as complete until it passes. Documentation-only and
other non-runtime PRs do not require promotion. Do not bump the package version in PRs. Merges to `main` with `feat` / `fix` /
`perf` commits are published by `.github/workflows/publish.yml` (Node 24,
OIDC trusted publisher, no `NODE_AUTH_TOKEN` / `registry-url`). Docs-only
merges do not publish. `runtime:promote` is a developer-machine tool and is
never a substitute for npm; end users upgrade with
`npx -y @sskarz/memoree install`.
