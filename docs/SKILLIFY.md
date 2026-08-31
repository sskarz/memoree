# Skills (skillify)

Memoree **codifies recurring patterns from your team's recent sessions into reusable skills** that propagate to every agent on your team — automatically. Same architecture as the wiki worker: an async background process that fires on Stop / SessionEnd, mines recent sessions in scope, asks Haiku whether the activity contains something worth keeping, and writes a `SKILL.md` if so.

## When the skillify worker fires

| Trigger          | When it fires                                                                  |
|------------------|--------------------------------------------------------------------------------|
| **Stop counter** | Mid-session, after every `MEMOREE_SKILLIFY_EVERY_N_TURNS` (default 20) turns. |
| **SessionEnd**   | Always at end-of-session, regardless of counter — catches tail-of-session knowledge. |

Per-project counter state lives at `~/.memoree/state/skillify/<project-key>.json`. Project key is the sha1 of `git config remote.origin.url` (with the absolute path as fallback for non-git dirs).

## How a skill is generated

1. The worker pulls the **last 10 sessions in scope** from the `sessions` Memoree table — strictly newer than the watermark in the state file.
2. It strips each session to **prompt + assistant text only** (tool calls and thinking blocks are dropped — they're noise for skill mining).
3. It builds a gate prompt: existing project skill bodies + the 10 stripped exchanges + decision rules.
4. It runs `claude -p haiku --permission-mode bypassPermissions` with the prompt. The model returns a JSON verdict:
   - `KEEP <name> <body>` — write a new skill.
   - `MERGE <existing-name> <merged-body>` — update an existing skill, bump version.
   - `SKIP <reason>` — pattern is one-off / generic / already covered.
5. On KEEP/MERGE the skill is written to `<project>/.claude/skills/<name>/SKILL.md` (or `~/.claude/skills/...` if you've set `install` to `global`), with provenance frontmatter (`source_sessions`, `version`, `created_by_agent`, timestamps).
6. A row is also inserted into the `skills` Memoree table for org-wide provenance (append-only — never UPDATE, sidesteps the UPDATE-coalescing quirk).

## `/skillify` — managing scope, team, install location

The `/skillify` slash command (Claude Code, Codex) and the `memoree skillify` CLI control mining behaviour.

```bash
memoree skillify                            # show current scope, team, install, per-project state
memoree skillify scope <me|team>            # who counts as "in scope" for mining
memoree skillify install <project|global>   # where new skills are written
memoree skillify promote <skill-name>       # move a project skill to ~/.claude/skills/
memoree skillify team add <username>        # add to the team list (used when scope=team)
memoree skillify team remove <username>     # remove from team
memoree skillify team list                  # list current team members
```

The team list flows into the worker's session-fetch SQL: `scope=me` filters by your own username, `scope=team` filters by `author IN (<team>)` (or falls back to `scope=me` when the team list is empty). A legacy `scope=org` value (no author filter, retired) is silently coerced to `team` on read for users who still have it in their config.

Config persists at `~/.memoree/state/skillify/config.json` (one global file shared across projects).

## `pull` / `unpull` — sharing skills across the org

Once a teammate's skills are mined into the Memoree `skills` table, you can install them locally with `pull`. Layout written to disk:

```text
<root>/<name>--<author>/SKILL.md      ← pulled skills (e.g. deploy--alice/)
<root>/<name>/SKILL.md                ← your locally-mined skills (flat, no suffix)
```

The `--<author>` suffix keeps cross-author entries with the same name disjoint and lets Claude Code's single-depth skill loader find pulled skills without any symlink trickery. `<root>` is `~/.claude/skills` for `--to global` and `<cwd>/.claude/skills` for `--to project`.

```bash
memoree skillify pull                                # all authors, install globally
memoree skillify pull --user alice@example.com       # only this author
memoree skillify pull --users a@x.com,b@y.com        # multiple authors (CSV)
memoree skillify pull --all-users                    # explicit "no author filter" (default)
memoree skillify pull --to project                   # install under <cwd>/.claude/skills
memoree skillify pull --dry-run                      # preview, no disk writes
memoree skillify pull --force                        # overwrite even when local version >= remote
memoree skillify pull <skill-name>                   # pull only that skill (combinable with --user)
```

Every successful pull records an entry in `~/.memoree/state/skillify/pulled.json`. That manifest is the source of truth for `unpull` — anything not in the manifest is **never** touched by default, even if its directory follows the `<name>--<author>` shape (this protects user-authored variant skills like `deploy--blue-green`).

```bash
memoree skillify unpull                              # remove every pulled entry under the install scope
memoree skillify unpull --user alice@example.com     # remove only this author's pulls
memoree skillify unpull --users a@x.com,b@y.com      # multiple authors
memoree skillify unpull --not-mine                   # remove all pulls except your own
memoree skillify unpull --dry-run                    # preview, no disk writes
memoree skillify unpull --to project                 # operate on <cwd>/.claude/skills instead of global
memoree skillify unpull --all                        # ALSO remove flat-layout (locally-mined) skills — destructive
memoree skillify unpull --legacy-cleanup             # ALSO remove pre-`--author`-layout `<projectkey>/` dirs from older skillify versions
```

Drift handling: if a manifest entry's directory was deleted out-of-band (e.g. `rm -rf` by hand), the next `unpull` reports it as `manifest-orphan` and prunes the entry from the manifest without errors.

Cross-project caveat: same `(name, author)` from two different projects collides on disk under the new flat layout — the more recently pulled row wins, and the prior `SKILL.md` is preserved as `SKILL.md.bak`. The underlying row stays in the Memoree `skills` table, so re-pulling from the other project recovers it.

## Auto-pull at SessionStart

Claude Code, Codex, and Antigravity auto-run the equivalent of `memoree skillify pull --all-users --to global` at the start of every session, so teammate-mined skills become available without a manual pull.

There is no throttle window. File writes inside `runPull` are idempotent (skipped when the local SKILL.md version is at-or-newer than remote), symlink fan-out is `lstat`-checked, and manifest writes are dedup'd — so the per-call cost is one SQL round-trip plus a handful of `existsSync` syscalls when nothing has changed. Bounded by a 5-second timeout so a slow Memoree never blocks SessionStart. All failures (network, missing table, auth) are swallowed silently and the session starts regardless.

The pull writes canonically to `~/.claude/skills/<name>--<author>/SKILL.md` and fans out a symlink to Codex's `~/.agents/skills/` root when Codex is installed. Symlink targets are recorded per entry so `unpull` reverses the fan-out without rescanning the filesystem.

| Env var                            | Default | Effect                                  |
|------------------------------------|---------|-----------------------------------------|
| `MEMOREE_AUTOPULL_DISABLED`       | unset   | Set to `1` to disable auto-pull entirely. |

## Configuration

| Env var                              | Default | Effect                                                  |
|--------------------------------------|---------|---------------------------------------------------------|
| `MEMOREE_SKILLIFY_EVERY_N_TURNS`     | `20`    | Stop-counter threshold for mid-session worker fires     |
| `MEMOREE_SKILLS_TABLE`              | `skills`| Memoree table name for org-wide provenance             |
| `MEMOREE_SKILLIFY_WORKER=1`          | unset   | Recursion guard (set automatically inside the worker)   |

## Per-agent gate CLI

The skillify worker calls the active supported agent's own headless CLI for the gate prompt, so a Codex-only user does not need `claude` on `PATH`:

| Agent       | Gate command                                                                          |
|-------------|----------------------------------------------------------------------------------------|
| claude_code | `claude -p <prompt> --no-session-persistence --model haiku --permission-mode bypassPermissions` |
| codex       | `codex exec --dangerously-bypass-approvals-and-sandbox <prompt>`                       |

## Logs

Worker activity logs to `~/.claude/hooks/skillify.log`. Each line shows which session pool was mined, what the gate decided, and whether a file was written.
