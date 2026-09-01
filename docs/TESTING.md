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
| `MEMOREE_LIVE_CLAUDE_MODEL` | optional; default `haiku` for live `claude -p` |
| `MEMOREE_LIVE_CODEX_MODEL` | optional; default `gpt-5.6-luna` for live `codex exec` |
| `MEMOREE_LIVE_CODEX_REASONING_EFFORT` | optional; default `low` |

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

**Wiring (Claude Code, Codex, and Antigravity MCP hooks)** — does the app actually reach that code?

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
| Built artifacts | `npm run build` then `npm test` | CLI + Claude/Codex/Antigravity/embed bundles and built-artifact tests | no | no |
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

That type-checks, checks the runtime-validator script, checks the npm pack
manifest for `npx @sskarz/memoree install`, and runs source tests,
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

If `agy` is missing or not signed in:

```sh
npm run runtime:validate -- --skip-live-antigravity
```

Report **Antigravity live skipped**, not passed. Product wiki workers inherit
the user's Google login; do not write `modelProvider: "gemini"` into the
operator `~/.gemini` settings.

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
  Claude observatory-lantern fact from `~/.memoree/memory/` (sessions plus
  summaries; wiki may paraphrase the lantern sentence)
- structured VFS rule/goal/KPI edits persisted with the expected owner/status
- missing VFS paths fail as normal commands; unsafe `rm -rf` on the mount is
  denied (hook status 2)

### `live:e2e`

Stdout must look like:

```
Live session e2e passed: N events, M summaries, unaided Claude/Codex hooks, …
```

with N &gt; 0 and M &gt; 0. Also:

- Claude ran **without** `--bare` and with `--model haiku` (or `MEMOREE_LIVE_CLAUDE_MODEL`)
- Codex ran **without** `--ephemeral`, with `-s read-only`, `-m gpt-5.6-luna`
  (or `MEMOREE_LIVE_CODEX_MODEL`), and `model_reasoning_effort=low`
- harbor-kite UUID in the Claude answer, later Claude recall, and Codex grep
- lantern UUID captured from Codex, then Claude grep of that lantern UUID
- unless Antigravity live is skipped: Agy UUID in Claude and Codex grep; Agy
  MCP grep of harbor-kite and lantern; Agy `memoree_read` of `graph/query/store`
  contains `persistGraph`
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
| Claude/Codex/Antigravity missing or unauthenticated | `LIVE_SKIPPED` with the missing binary/auth, not a live pass |
| `--skip-live-codex` | Codex live skipped; Claude/VFS parts may still pass |
| `--skip-live-antigravity` | Antigravity live `agy` skipped; Node hook-bundle checks still run |
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
| Cross-agent session/rule/graph retrieve (Claude↔Codex↔Agy) | S | V | L | Same isolated DB/cwd. Claude/Codex grep the Agy UUID and cat the Agy-written rule; Agy MCP greps Claude/Codex facts and reads `graph/query/store`. MCP capture skips embeddings, so proactive semantic recall of an Agy-only row is recorded as hit/miss, not a silent pass. |
| Claude SessionStart inject + placeholder summary | S | V | L | Auto-mine/backfill spawn is unit-locked and wired |
| Claude session-start-setup (async) | S | V | L | Runs in plugin; validate also invokes the bundle |
| Claude UserPromptSubmit capture | S | V | L | |
| Claude UserPromptSubmit recall.js | S | V | L | Threshold 0.4 in live env; telemetry file uses `homedir()` |
| Claude PreToolUse VFS (Bash/Read/Grep/Glob) | S | V | L | Live exercises `cat`/`printf` on the mount |
| Claude PostToolUse / Stop / SubagentStop capture | S | V | L | SubagentStop is source-tested; live is main session |
| Claude SessionEnd wiki + plugin-cache-gc + graph-on-stop | S | V | L | Wiki worker uses `MEMOREE_VALIDATION_CLAUDE_HOME` |
| Codex SessionStart + setup | S | V | — | Matcher is `startup\|resume\|clear\|compact`; `codex exec` may still skip it |
| Codex capture (UserPromptSubmit / PostToolUse / Stop / SubagentStop) | S | V | L | Stop needs a real session file; no `--ephemeral`; SubagentStop is source + validate |
| Codex UserPromptSubmit recall.js | S | V | L | Same recall.js bundle as Claude; Codex documents additionalContext as developer context |
| Codex PreToolUse Bash VFS + compatibility broker | S | V | L | Live uses read-only sandbox; writes go through Claude |
| Codex SessionEnd wiki | S | V | L | Advisory, max 3s; wiki spawn is a fast detach. Stop still spawns wiki under the same lock. Usage recap parses Codex rollouts (`function_call` / `exec_command_*`), not Claude `tool_use` transcripts |
| Antigravity install/uninstall + named hooks + MCP | S | V | — | Plugin at `~/.gemini/config/plugins/memoree`; merges `memoree` into `~/.gemini/config/hooks.json` and the legacy `~/.gemini/antigravity-cli/hooks.json` (CLI#49). `memoree install` detects Antigravity only when `~/.gemini/antigravity-cli` or `~/.gemini/antigravity` exists — a Gemini CLI-only `~/.gemini` is skipped. |
| Antigravity PreInvocation inject + recall | S | V | L | First `invocationNum` 0/1 claims wake lock; `injectSteps`. Hook JSON is parsed without waiting for stdin EOF (`agy -p` keeps the pipe open) |
| Antigravity PreToolUse steer (never `allow`) | S | V | — | `{ decision: "deny", reason }` on the mount; unrelated tools `{}` |
| Antigravity capture + Stop wiki (`agy -p`) | S | V | L | `agy -p` loads hooks.json but does not execute command hooks. Unaided capture is MCP tool-call rows (`captureMcpToolCall`); MCP capture skips embedding so a hung daemon cannot delay `tools/call`. PostToolUse skips `memoree_*` / `call_mcp_tool` to avoid duplicate interactive rows. `waitForCapture` requires the UUID in `sessions`. Wiki summary stays best-effort (`requireSummary: false`) |
| Antigravity MCP VFS tools | S | V | L | Same sandbox as Claude/Codex. Stdio is official NDJSON (agy). `runtime:validate` drives all 11 MCP tools; unaided `agy` must `call_mcp_tool` read + write + grep |
| Identity / rules.md / goals.md VFS | S | V | L | |
| Rules CLI + `rules/{active,done}` lifecycle | S | V | L | |
| Goals CLI + `goal/<owner>/{opened,in_progress,closed}` | S | V | L | |
| KPI CLI + `kpi/<goal>/<kpi>.md` | S | V | L | |
| `index.md` / `summaries/` / `sessions/` | S | V | L | |
| Graph `build` + `history` | S | V | L | |
| Graph VFS `query/` + `layers` | S | V | L | Live e2e: Claude cats `graph/layers` and `graph/query/store`; Codex cats `query/store`; Agy `memoree_read` of `graph/query/store` |
| Graph VFS `find`/`show`/`impact`/`neighborhood`/`tour`/`path` | S | V | — | Driven in `runtime:validate`, not unaided live |
| Graph `init` / `diff` / `pull` / `uninstall` | S | — | — | CLI + git-hook unit tests; not in live harness |
| Docs set/show/list + VFS `docs/index.md`, `docs/find/<words>`, `docs/<file>.md` | S | V | L | There is no `docs/leaves` path |
| Docs `wiki` / `generate` / `sync` LLM | S | — | dry-run | Live runs `docs wiki --dry-run` only |
| Skillify status/scope/team CLI | S | V | L | |
| Skillify mine-local / pull / push / hygiene LLM | S | — | — | Validate sets `MEMOREE_SKILLIFY_WORKER=1` and `MEMOREE_SKILLOPT_DISABLED=1` |
| `memory backfill` | S | — | dry-run | |
| `memory flush` | S | — | — | |
| `sessions prune` | S | — | L | |
| `backend check` / embeddings status | S | V | L | |
| PostgreSQL backend | S | — | — | Opt-in; not in default live |
| `npx @sskarz/memoree install` / durable package stage | S | — | — | Pack includes `scripts/ensure-tree-sitter.mjs`; postinstall no-ops without `src/` unless `MEMOREE_STRICT_POSTINSTALL` / `MEMOREE_HEAL_TREE_SITTER`; fake-HOME Claude/Codex-only/neither; live still uses promoted runtime |
| npm publish from `main` (OIDC trusted publisher) | S | — | — | `publish.yml` uses Node 24, environment `memoree github actions`, no `registry-url` / `NODE_AUTH_TOKEN`. `release-from-main.mjs` strips classic tokens. Users upgrade with `npx -y @sskarz/memoree install` |
| Interactive TUI (`claude` / `codex` without `-p`/`exec`) | — | — | — | Live is headless only |
| Live Claude/Codex model pin (haiku / gpt-5.6-luna) | S | — | — | `runtime:validate` + `live:e2e` pass `--model haiku` / `-m gpt-5.6-luna` + low effort. Cheap Codex recall greps `~/.memoree/memory/` (not summaries-only). Override `MEMOREE_LIVE_CLAUDE_MODEL` / `MEMOREE_LIVE_CODEX_MODEL` |

## Why each sandboxed command exists

Claude Code and Codex are taught this exact command set in the memory skill.
Antigravity must expose the same jobs (as MCP tools) or an agent following
the skill cannot finish the work. echo/printf/tee are three shell spellings
of one write; they share `memoree_write`. Everything else is a distinct job:

| Command | MCP tool | Unique job | Not the same as |
|---|---|---|---|
| `ls` | `memoree_ls` | Inventory a directory without opening file bodies | `cat` dumps bodies |
| `cat` | `memoree_read` | Read a whole virtual file (identity, summaries, `graph/query/…`, docs) | `head`/`tail`/`wc` slice or measure |
| `grep` | `memoree_grep` | Search file contents (recall) | `find` matches names |
| `head` | `memoree_head` | First N lines of a large file without a full cat | `tail` is the end; `cat` is everything |
| `tail` | `memoree_tail` | Last N lines (recent index/session text) | `head` is the start |
| `wc` | `memoree_wc` | Line count before deciding to cat a huge transcript | `cat` returns the body |
| `find` | `memoree_find` | Locate files by **name**, not content | `grep` searches bodies |
| `jq` | `memoree_jq` | Field extract on real JSON (`identity.json`). Not session `.jsonl` views | `cat` dumps the whole document |
| `echo` / `printf` / `tee` | `memoree_write` | Create or overwrite a rule, goal, or KPI | `mv`/`rm` change status of an existing id |
| `mv` | `memoree_mv` | Lifecycle move, same id (`active`↔`done`, `opened`→`in_progress`) | `write` creates; `rm` closes |
| `rm` | `memoree_rm` | Mark a rule done or close a goal — not a hard delete | `mv` is an explicit destination; neither unlinks |

Source lock: `tests/shared/mcp-vfs-job-uniqueness.test.ts` (observable
head≠tail≠cat≠wc, ls vs body, grep vs find, jq vs cat, write vs mv vs rm).
`runtime:validate` drives all 11 MCP tools through the sandbox and asserts
those unique outputs. Unaided `agy` must `call_mcp_tool` for read, write, and
grep (the discovery, create, and search jobs). head/tail/wc/find/jq/mv/rm stay
on the Node MCP client so a single model turn is not required to hit every
alias.

## Known gaps, overlap, and follow-ups

Not missing from the product on purpose, but not fully live-proven:

- Wiki **generation** (LLM pages), only `--dry-run` in live e2e
- Skillify mine / pull / push against a live model
- Graph git-hook init, snapshot diff, backend pull, uninstall
- `memoree memory flush`
- Interactive TUIs
- Codex SessionStart during `codex exec` (matcher now includes `clear`/`compact`; exec may still skip SessionStart)
- `recall-events.jsonl` ignoring `MEMOREE_STATE_DIR`

Documented shareability edges (source-tested; not a schema change in this pass):

- Session/summary `project` is cwd basename only; grep/recall are DB-wide. Docs/skills/graphs use `deriveProjectKey`. Antigravity proactive recall matches Claude/Codex (no basename filter).
- Skillify project install is Claude-canonical (`<cwd>/.claude/skills`); Codex/Agy see those files only after global pull + symlink fan-out.

Redundant or stale on purpose until cleaned up:

- `runtime:validate` vs `live:e2e` overlap (different proofs; keep both)
- Graph search is VFS-only (`~/.memoree/memory/graph/`); it is not a CLI
  subcommand. `memoree graph pull` is implemented.
- `library/knowledge` still mentions frozen/unsupported harnesses. Graph
  discovery skips `experimental/pi/`.

Follow-ups that would make the PR loop tighter (do not block docs):

- Honor `MEMOREE_STATE_DIR` in `src/hooks/shared/recall-events.ts`
- Optional `MEMOREE_RUNTIME_DIR` mode that installs Codex hooks from the PR
  checkout into the **isolated** `CODEX_HOME` only, without `npm link`

## Adding a new agent later

Do not start with Docker. Add a few cases to
`tests/shared/harness-wiring.test.ts` (or a sibling file if that file gets
crowded), plus product coverage in
`tests/shared/graph-query-and-hygiene.test.ts` when the feature is not
harness-specific. Then add a row to the coverage map above. Promote only when
you are ready for daily use. Claude Code, Codex, and Antigravity are the
supported harnesses. Antigravity live `agy` is skipped (`LIVE_SKIPPED`) when
the CLI is missing or not signed in — do not treat that as a pass, and do not
document env-key / `modelProvider: "gemini"` as product auth.
