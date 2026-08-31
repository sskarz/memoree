# How to test Memoree

Testing and installing are different jobs. Tests never change what everyday
Claude Code or Codex is running. Installing (`runtime:promote`) does.

Tests and live harnesses must use throwaway folders and a fake home directory.
They must not write into the real `~/.memoree` database.

This file is the operational playbook for humans and for a PR verification
agent. Product behavior lives in [README.md](../README.md). Agent rules live
in [AGENTS.md](../AGENTS.md).

## Isolation rules

Never point live or automated checks at the operator database. The live
scripts already set these; copy them if you add a harness:

| Variable | Role |
|---|---|
| `MEMOREE_SQLITE_PATH` | throwaway SQLite file |
| `MEMOREE_CONFIG_PATH` | throwaway `config.json` |
| `MEMOREE_MEMORY_PATH` | throwaway VFS root |
| `MEMOREE_STATE_DIR` | throwaway agent state |
| `MEMOREE_GRAPHS_HOME` | throwaway graph snapshots |
| `HOME` / `CODEX_HOME` | isolated profiles (Codex hooks + auth copy) |
| `MEMOREE_VALIDATION_CLAUDE_HOME` | real home so Claude auth and wiki workers still work |

`recall-events.jsonl` currently writes under `homedir()` / `.memoree`, not
`MEMOREE_STATE_DIR`. Live e2e therefore uses an isolated `HOME` so telemetry
does not land in the operator tree.

API keys for live Claude/Codex belong in a chmod-600 env file that is not
committed, for example `~/.config/memoree-live.env`. Source it only in the
shell that runs live gates:

```sh
set -a
. "$HOME/.config/memoree-live.env"
set +a
export PATH="$HOME/.npm-global/bin:$PATH"
```

## Two files for this feature

**Product (no Claude, no Codex)** — does graph search and skill cleanup work?

```sh
npx vitest run tests/shared/graph-query-and-hygiene.test.ts
```

Calls the virtual filesystem and hygiene functions directly. Example:
`query/store` should find `persistGraph` even though that word is not in the
name; `find/store` should not. Hygiene dry-run must not delete files.

**Wiring (Claude Code and Codex hooks)** — does the app actually reach that code?

```sh
npx vitest run tests/shared/harness-wiring.test.ts
```

Only checks routing: `cat` / Read / `ls` hit the graph mount. It does not
re-prove ranking.

You can run both from any session. You do not need to close Claude or Codex.
That does **not** mean daily apps already load this code.

## Gate matrix

| Gate | Command | What it proves | Needs API keys | Changes daily runtime |
|---|---|---|---|---|
| Source | `npm run verify` | TypeScript, runtime-validator JS check, source Vitest | no | no |
| Built artifacts | `npm run build` then `npm test` | CLI + Claude/Codex/MCP/embed bundles and built-artifact tests | no | no |
| Whitespace | `git diff --check` | no leftover spaces | no | no |
| Promoted-bundle live | `npm run runtime:validate` | Direct hook-bundle invocation + `claude --bare` / `codex exec` against isolated DB; VFS, capture, wiki, embeddings, cross-agent recall | yes | no (reads promoted checkout) |
| Unaided-hook live | `npm run live:e2e` | `claude -p` **without** `--bare`, `codex exec` **without** `--ephemeral`; SessionStart/capture/Stop/SessionEnd fire on their own | yes | no (reads promoted checkout) |
| Promote | `npm run runtime:promote -- <sha>` | Detached checkout, `npm link` from it, marketplace + Codex hooks, `memoree doctor` | no | **yes** |

`runtime:validate` and `live:e2e` both talk to the **promoted** checkout at
`~/.local/share/memoree-runtime` (override with `MEMOREE_RUNTIME_DIR`). They
do not test an unpromoted PR SHA unless that SHA is already the runtime HEAD
or you pointed `MEMOREE_RUNTIME_DIR` at a built checkout of that SHA.

They overlap on capture, summaries, 768-d embeddings, and recall. Keep both:

- `runtime:validate` is the promote-completion gate. It drives hook bundles
  as Node processes, including structured VFS writes, Grep/Glob intercepts,
  lexical fallback with embeddings off, and SQLite integrity.
- `live:e2e` is the unaided-plugin proof. `--bare` and `--ephemeral` skip the
  path users actually run.

Do not treat a green `runtime:validate` as proof that Claude plugin hooks
fired, and do not treat a green `live:e2e` as the full VFS/security suite.

## 1. Every PR (no install)

```sh
npm run verify
```

That type-checks, checks the runtime-validator script, and runs source tests,
including the two files above. No rebuild, no install.

Put agent-independent tests under `tests/shared/`. Inject filesystem, time,
and embedder fakes. Never call the real embedding daemon or the real home
directory.

## 2. Runtime-affecting PRs (still no install)

```sh
npm run build
npm test
git diff --check
```

Treat a PR as runtime-affecting when it changes `src/`, `harnesses/`,
`scripts/runtime-*.mjs`, `scripts/live-session-e2e.mjs`, hook JSON, or the
CLI bundle graph.

## 3. Authenticated live, without promoting

Run these only when `claude` and `codex` are on PATH and authenticated, and
only against isolated DBs.

On a **disposable VM** (no daily operator sessions), a PR agent may:

```sh
npm run build
MEMOREE_RUNTIME_DIR="$PWD" npm run runtime:validate
```

That uses this checkout’s built bundles via direct Node invocation. It does
**not** prove the Claude marketplace plugin or Codex `hooks.json` on disk.

Unaided `live:e2e` still needs those installed hooks. On a laptop that already
runs Claude/Codex daily, do not `runtime:promote` from a PR agent. On a
disposable VM whose only job is this PR, promoting the PR SHA and then
running both live gates is the complete live proof.

If Codex credits are missing:

```sh
npm run runtime:validate -- --skip-live-codex
```

Report that skip explicitly. A skipped Codex phase is not a Codex pass.

If live e2e fails, the workspace is kept:

```
live session e2e workspace kept for inspection: …
```

Inspect that tree; do not delete it before capturing event/summary counts.

## 4. Install onto daily Claude Code / Codex (rare, explicit)

Only after the tests above are green, and only when you want daily agents to
load this commit.

1. Commit the work. Note the SHA (`git rev-parse HEAD`).
2. Close every interactive Claude Code and Codex session. Idle Cursor is fine.
3. Promote that SHA, then run both live gates:

```sh
npm run runtime:promote -- <commit-sha>
npm run runtime:validate
npm run live:e2e
```

Promotion refuses a dirty runtime checkout or active Claude/Codex processes.
Roll back with `npm run runtime:rollback`.

Never run `runtime:promote` from unattended GitHub Actions. A PR cloud agent
may promote only on a disposable VM that does not host the operator’s daily
sessions, and only when the PR is runtime-affecting and keys are present.

## How to measure a pass

### Source / built gates

- Exit code 0.
- Vitest reports failures as failures; skipped tests must stay skipped for
  documented reasons (platform, optional native deps), not because a suite
  could not start.
- `git diff --check` silent.

### `runtime:validate`

Stdout must include a final passed line with event and summary counts.
Assert all of:

- `PRAGMA integrity_check` is `ok`
- `PRAGMA journal_mode` is `wal`
- session events &gt; 0
- summaries under `/summaries/%` &gt; 0
- at least one 768-element embedding on a session or summary row
- the Claude observatory-lantern UUID appears in sessions **or** summaries
- unless `--skip-live-codex`, Codex repeats its lexical UUID and greps the
  Claude fact from `~/.memoree/memory/summaries/`
- structured VFS rule/goal/KPI edits persisted with the expected owner/status
- missing VFS paths fail as normal commands; unsafe `rm -rf` on the mount is
  denied (hook status 2)

### `live:e2e`

Stdout must look like:

```
Live session e2e passed: N events, M summaries, unaided Claude/Codex hooks, …
```

with N &gt; 0 and M &gt; 0. Also:

- Claude ran **without** `--bare`
- Codex ran **without** `--ephemeral` and with `-s read-only`
- harbor-kite UUID in the Claude answer, later Claude recall, and Codex grep
- lantern UUID captured from Codex
- wiki/session reflection produced summaries (not only session rows)
- 768-d embeddings present
- CLI side paths used in the script succeeded (`graph build`, `docs set/show`,
  `docs wiki --dry-run`, `skillify` status, `context`, `memory backfill --dry-run`,
  `sessions prune`)

### `memoree doctor` (after a real promote)

Every check `ok`. Doctor against the operator profile is **not** a substitute
for isolated live gates.

### Fail closed

| Symptom | Report |
|---|---|
| `verify` / `test` non-zero | failed; do not run live to “make up for it” |
| Claude/Codex missing or unauthenticated | `LIVE_SKIPPED` with the missing binary/auth, not a live pass |
| `--skip-live-codex` | Codex live skipped; Claude/VFS parts may still pass |
| identifier missing, 0 events, 0 summaries, non-768 vectors, integrity not ok | live failed |
| credits / rate limit | failed phase name + stderr excerpt; do not claim success |
| live e2e kept a workspace | failed; attach that path |

Do not write synthetic rows into `~/.memoree`. Do not `npm link` the
development checkout on a machine that already has a runtime worktree.

## Feature coverage map

Legend: **S** = source/unit/integration Vitest; **V** = `runtime:validate`;
**L** = `live:e2e`; **—** = not live-LLM’d yet (keep the source tests).

| Feature | S | V | L | Notes |
|---|---|---|---|---|
| Claude SessionStart inject + placeholder summary | S | V | L | Auto-mine/backfill spawn is unit-locked and wired |
| Claude session-start-setup (async) | S | V | L | Runs in plugin; validate also invokes the bundle |
| Claude UserPromptSubmit capture | S | V | L | |
| Claude UserPromptSubmit recall.js | S | V | L | Threshold 0.4 in live env; telemetry file uses `homedir()` |
| Claude PreToolUse VFS (Bash/Read/Grep/Glob) | S | V | L | Live exercises `cat`/`printf` on the mount |
| Claude PostToolUse / Stop / SubagentStop capture | S | V | L | SubagentStop is source-tested; live is main session |
| Claude SessionEnd wiki + plugin-cache-gc + graph-on-stop | S | V | L | Wiki worker uses `MEMOREE_VALIDATION_CLAUDE_HOME` |
| Codex SessionStart + setup | S | V | — | Matcher is `startup\|resume`; `codex exec` may not fire it |
| Codex capture (UserPromptSubmit / PostToolUse / Stop) | S | V | L | Stop needs a real session file; no `--ephemeral` |
| Codex PreToolUse Bash VFS + compatibility broker | S | V | L | Live uses read-only sandbox; writes go through Claude |
| Codex SessionEnd | — | — | — | Codex has no SessionEnd; wiki is on Stop |
| Identity / rules.md / goals.md VFS | S | V | L | |
| Rules CLI + `rules/{active,done}` lifecycle | S | V | L | |
| Goals CLI + `goal/<owner>/{opened,in_progress,closed}` | S | V | L | |
| KPI CLI + `kpi/<goal>/<kpi>.md` | S | V | L | |
| `index.md` / `summaries/` / `sessions/` | S | V | L | |
| Graph `build` + `history` | S | V | L | |
| Graph VFS query/find/show/impact/neighborhood/layers/tour/path | S | V | L | query ≠ find (semantic vs substring) |
| Graph `init` / `diff` / `pull` / `uninstall` | S | — | — | CLI + git-hook unit tests; not in live harness |
| Docs set/show/list + VFS `docs/index`, `find`, `leaves` | S | V | L | |
| Docs `wiki` / `generate` / `sync` LLM | S | — | dry-run | Live runs `docs wiki --dry-run` only |
| Skillify status/scope/team CLI | S | V | L | |
| Skillify mine-local / pull / push / hygiene LLM | S | — | — | Validate sets `MEMOREE_SKILLIFY_WORKER=1` and `MEMOREE_SKILLOPT_DISABLED=1` |
| `memory backfill` | S | — | dry-run | |
| `memory flush` | S | — | — | |
| `sessions prune` | S | — | L | |
| `backend check` / embeddings status | S | V | L | |
| PostgreSQL backend | S | — | — | Opt-in; not in default live |
| Interactive TUI (`claude` / `codex` without `-p`/`exec`) | — | — | — | Live is headless only |
| MCP server bundle | S | — | — | Still built; installer removed; unsupported harness |
| Skill publisher | S | — | — | Kept for deferred publish; no live share |

## Known gaps, overlap, and follow-ups

Not missing from the product on purpose, but not fully live-proven:

- Wiki **generation** (LLM pages), only `--dry-run` in live e2e
- Skillify mine / pull / push against a live model
- Graph git-hook init, snapshot diff, backend pull, uninstall
- `memoree memory flush`
- Interactive TUIs
- Codex SessionStart during `codex exec` (matcher may not match)
- `recall-events.jsonl` ignoring `MEMOREE_STATE_DIR`

Redundant or stale on purpose until cleaned up:

- `runtime:validate` vs `live:e2e` overlap (different proofs; keep both)
- `mcp/bundle` still built after the unused MCP installer was removed
- Graph search is VFS-only (`~/.memoree/memory/graph/`); it is not a CLI
  subcommand. `memoree graph pull` is implemented.
- `library/knowledge` still mentions frozen/unsupported harnesses; `experimental/pi/` is excluded

Follow-ups that would make the PR loop tighter (do not block docs):

- Honor `MEMOREE_STATE_DIR` in `src/hooks/shared/recall-events.ts`
- Expand Codex SessionStart matchers if `codex exec` should inject context
- Optional `MEMOREE_RUNTIME_DIR` mode that installs Codex hooks from the PR
  checkout into the **isolated** `CODEX_HOME` only, without `npm link`

## Adding a new agent later

Do not start with Docker. Add a few cases to
`tests/shared/harness-wiring.test.ts` (or a sibling file if that file gets
crowded), plus product coverage in
`tests/shared/graph-query-and-hygiene.test.ts` when the feature is not
harness-specific. Then add a row to the coverage map above. Promote only when
you are ready for daily use. Claude Code and Codex remain the only supported
harnesses.
