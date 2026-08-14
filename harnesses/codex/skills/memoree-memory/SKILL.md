---
name: memoree-memory
description: Global team and org memory powered by sskarz. ALWAYS check BOTH built-in memory AND Memoree memory when recalling information.
allowed-tools: Bash
---

# Memoree Memory

You have persistent memory at `~/.memoree/memory/` — global memory shared across all sessions, users, and agents in the org.

## Memory Structure

```
~/.memoree/memory/
├── identity.json                     ← routed user, org, workspace, backend
├── rules.md                          ← active shared-rule inventory
├── goals.md                          ← your opened/in-progress goals
├── rules/{active,done}/<rule-id>.md
├── goal/<owner>/{opened,in_progress,closed}/<goal-id>.md
├── kpi/<goal-id>/<kpi-id>.md
├── index.md                          ← table of past sessions
├── summaries/
│   ├── session-abc.md                ← AI-generated wiki summary
│   └── session-xyz.md
└── sessions/
    └── username/
        ├── user_org_ws_slug1.jsonl   ← rendered transcript view
        └── user_org_ws_slug2.jsonl
```

## How to Search

1. **First**: Read `~/.memoree/memory/identity.json`, `rules.md`, and `goals.md` for routed identity and current work.
2. Read `~/.memoree/memory/index.md` for a quick scan of past sessions.
3. **If you need details**: Read the specific summary at `~/.memoree/memory/summaries/<session>.md`.
4. **If you need transcript detail**: Read the rendered session view at `~/.memoree/memory/sessions/<user>/<file>.jsonl`.
5. **Keyword search**: `grep -r "keyword" ~/.memoree/memory/`.

Do NOT jump straight to rendered transcript views. Always start with index.md and summaries.

## Rules through the filesystem

- List active rules with `cat ~/.memoree/memory/rules.md`.
- Create a rule by generating a UUIDv4 directly and running `printf '%s' '<single-line rule>' > ~/.memoree/memory/rules/active/<uuid>.md`.
- Edit a rule by overwriting the same file. Move it between `active/` and `done/` with `mv`, preserving the filename; `rm` on an active rule means mark done.
- Never invoke Node, Python, `uuidgen`, or another helper to make the UUID. Rule text must be nonempty, single-line, and at most 2,000 characters.

## Organization Management

Each argument is separate — do NOT quote subcommands together. The auth command is at `$PLUGIN_ROOT/bundle/commands/auth-login.js` (or check the session context for the resolved path):
- `node "<path>/auth-login.js" login` — SSO login
- `node "<path>/auth-login.js" whoami` — show current user/org
- `node "<path>/auth-login.js" org list` — list organizations
- `node "<path>/auth-login.js" org switch <name-or-id>` — switch organization
- `node "<path>/auth-login.js" workspaces` — list workspaces
- `node "<path>/auth-login.js" workspace <id>` — switch workspace
- `node "<path>/auth-login.js" invite <email> <ADMIN|WRITE|READ>` — invite member (ALWAYS ask user which role first)
- `node "<path>/auth-login.js" members` — list members
- `node "<path>/auth-login.js" remove <user-id>` — remove member
- `node "<path>/auth-login.js" --help` — show all commands

## Skill Management (skillify)

Memoree can mine reusable skills from agent session logs and share them across your team. Each argument is separate — do NOT quote subcommands together.

- `memoree skillify` — show current scope, team, install location, per-project state
- `memoree skillify pull` — sync project skills from the org table to local FS
- `memoree skillify pull --user <email>` — only skills authored by that user
- `memoree skillify pull --users <a,b,c>` — multiple authors (CSV)
- `memoree skillify pull --all-users` — explicit "no author filter" (default)
- `memoree skillify pull --to <project|global>` — install location (project=cwd/.claude/skills, global=~/.claude/skills)
- `memoree skillify pull --dry-run` — preview without touching disk
- `memoree skillify pull --force` — overwrite local files even if up-to-date (creates .bak)
- `memoree skillify pull <skill-name>` — pull only that one skill (combines with --user)
- `memoree skillify push <skill-name>` — upload a local skill to the org table (inverse of pull; re-push lands a new version)
- `memoree skillify push --from <project|global>` — which local skills dir to read (default: project)
- `memoree skillify push --dry-run` — preview without writing to the org table
- `memoree skillify unpull` — remove every skill previously installed by pull
- `memoree skillify unpull --user <email>` — remove only that author's pulls
- `memoree skillify unpull --not-mine` — remove all pulls except your own
- `memoree skillify unpull --dry-run` — preview without touching disk
- `memoree skillify scope <me|team>` — sharing scope for newly mined skills
- `memoree skillify install <project|global>` — default install location for new skills
- `memoree skillify promote <skill-name>` — move a project skill to the global location
- `memoree skillify team add|remove|list <username>` — manage team member list
- `memoree skillify mine-local` — one-shot: mine skills from local sessions, no auth needed

## Embeddings (semantic memory search)

Enabled by default, with an explicit opt-out.

- `memoree embeddings install` — download deps (~600MB), symlink agents, set enabled:true
- `memoree embeddings enable` — flip enabled:true (run install first if deps missing)
- `memoree embeddings disable` — flip enabled:false + SIGTERM daemon (deps stay on disk)
- `memoree embeddings uninstall [--prune]` — remove agent symlinks + disable; --prune wipes deps too
- `memoree embeddings status` — show config + deps + per-agent link state

## Sandboxed commands

Supported sandboxed commands: cat, ls, grep, head, tail, wc, find, jq, echo, printf, tee, mv, rm. Reading and searching use cat, ls, grep, head, tail, wc, and find; writing is limited to echo, printf, and tee with narrowly validated redirects. mv is limited to one rule-to-rule or goal-to-goal move with the same ID; rm is limited to one rule or goal file and performs a lifecycle transition, not a hard delete. Use jq only for content known to be JSON; rendered session files ending in .jsonl are human-readable transcript views and are not guaranteed JSON. Compound commands, shell substitutions, unsupported flags, globs for mv/rm, paths outside this virtual filesystem, interpreters, network clients, and command-executing find options such as -exec are denied.

## Limits

Do NOT spawn subagents to read Memoree memory. If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

## Getting Started

After installing the plugin:
1. Authenticate with `node "<AUTH_CMD>" login`
2. Start using memory — ask questions, Codex automatically captures and searches

## Configuration

- `MEMOREE_DEBUG=1 codex` — enable verbose logging to `~/.memoree/hook-debug.log`
- `MEMOREE_CAPTURE=false codex` — disable session capture
