---
name: memoree-memory
description: Local persistent memory powered by Memoree. ALWAYS check BOTH built-in memory AND Memoree memory when recalling information.
allowed-tools: Grep Read Bash
---

# Memoree Memory

You have TWO memory sources. ALWAYS check BOTH when the user asks you to recall, remember, or look up ANY information:

1. **Your built-in memory** (`~/.claude/`) — personal per-project notes
2. **Memoree memory** (`~/.memoree/memory/`) — persistent memory shared across locally installed agents

## Memory Structure

```
~/.memoree/memory/
├── index.md                          ← START HERE — table of all sessions
├── summaries/
│   ├── session-abc.md                ← AI-generated wiki summary
│   └── session-xyz.md
└── sessions/
    └── username/
        ├── user_org_ws_slug1.jsonl   ← raw session data
        └── user_org_ws_slug2.jsonl
```

## How to Search

1. **First**: Read `~/.memoree/memory/index.md` — quick scan of all sessions with dates, projects, descriptions
2. **If you need details**: Read the specific summary at `~/.memoree/memory/summaries/<session>.md`
3. **If you need raw data**: Read the session JSONL at `~/.memoree/memory/sessions/<user>/<file>.jsonl`
4. **Keyword search**: `Grep pattern="keyword" path="~/.memoree/memory"`

Do NOT jump straight to reading raw JSONL files. Always start with index.md and summaries.

## Diagnostics

- `memoree doctor` — verify the database, embeddings, Claude Code plugin, and hooks
- `memoree backend status` — show the selected SQLite or PostgreSQL backend

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

Enabled by default and persisted in `~/.memoree/config.json`.

- `memoree embeddings install` — download deps (~600MB), symlink agents, set enabled:true
- `memoree embeddings enable` — flip enabled:true (run install first if deps missing)
- `memoree embeddings disable` — flip enabled:false + SIGTERM daemon (deps stay on disk)
- `memoree embeddings uninstall [--prune]` — remove agent symlinks + disable; --prune wipes deps too
- `memoree embeddings status` — show config + deps + per-agent link state

## Important: Bash Only

Only use bash commands (cat, ls, grep, echo, jq, head, tail, sed, awk, etc.) to interact with `~/.memoree/memory/`. Do NOT use python, python3, node, curl, or other interpreters — they are not available in the memory filesystem. If a task seems to require Python, rewrite it using bash tools (e.g., `cat file.json | jq 'keys | length'`).

## Limits

If a file returns empty after 2 attempts, skip it and move on. Report what you found rather than exhaustively retrying.

## Getting Started

After installing the plugin, restart Claude Code and run `memoree doctor`. Claude then captures and searches memory automatically.

## Configuration

- `MEMOREE_DEBUG=1 claude` — enable verbose logging to `~/.memoree/hook-debug.log`
- `MEMOREE_CAPTURE=false claude` — disable session capture
