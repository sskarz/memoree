---
name: memoree-memory
description: Global team and org memory powered by sskarz. ALWAYS check BOTH built-in memory AND Memoree memory when recalling information. In Antigravity, use Memoree MCP tools — never cat ~/.memoree/memory.
---

# Memoree Memory

You have persistent memory shared across sessions, users, and agents in the org.

**Antigravity:** `~/.memoree/memory` is virtual. Use MCP tools (same VFS as Claude/Codex `cat`/`ls`/`grep`/`head`/`tail`/`wc`/`find`/`jq`/`printf`/`mv`/`rm`):

- `memoree_read` — cat a virtual file (`identity.json`, `rules.md`, `graph/query/<q>`, `docs/...`)
- `memoree_ls` — list a directory
- `memoree_grep` — search (`pattern`, optional `path`)
- `memoree_head` / `memoree_tail` — first/last N lines (`path`, optional `lines`)
- `memoree_wc` — line count (`path`)
- `memoree_find` — `find <path> -name <pattern>`
- `memoree_jq` — jq filter on known JSON (`path`, optional `filter`)
- `memoree_write` / `memoree_mv` / `memoree_rm` — rule and goal lifecycle

Do not `cat` / `ls` / `grep` `~/.memoree/memory` with `run_command` or `view_file`.

## Memory Structure

```
identity.json                     ← routed user, org, workspace, backend
rules.md                          ← active shared-rule inventory
goals.md                          ← your opened/in-progress goals
rules/{active,done}/<rule-id>.md
goal/<owner>/{opened,in_progress,closed}/<goal-id>.md
kpi/<goal-id>/<kpi-id>.md
index.md                          ← table of past sessions
summaries/<user>/<session>.md     ← AI-generated wiki summary
sessions/<user>/<file>.jsonl      ← rendered transcript view
graph/...                         ← code graph (see memoree-graph skill)
docs/...                          ← generated docs
```

## How to Search

1. **First**: `memoree_read` `identity.json`, `rules.md`, and `goals.md`.
2. `memoree_read` `index.md` for a quick scan of past sessions.
3. **If you need details**: `memoree_read` `summaries/<user>/<session>.md`.
4. **Keyword search**: `memoree_grep` over `summaries`.
5. Only fall back to `sessions/` when a summary lacks the detail.

## Rules through memory tools

- List active rules with `memoree_read` path=`rules.md`.
- Create a rule by generating a UUIDv4 directly and `memoree_write` path=`rules/active/<uuid>.md`.
- Edit a rule by overwriting the same path. Move it between `active/` and `done/` with `memoree_mv`, preserving the filename; `memoree_rm` on an active rule means mark done.
- Never invoke Node, Python, `uuidgen`, or another helper to make the UUID. Rule text must be nonempty, single-line, and at most 2,000 characters.

Supported sandboxed commands: cat, ls, grep, head, tail, wc, find, jq, echo, printf, tee, mv, rm. Reading and searching use cat, ls, grep, head, tail, wc, and find; writing is limited to echo, printf, and tee with narrowly validated redirects. mv is limited to one rule-to-rule or goal-to-goal move with the same ID; rm is limited to one rule or goal file and performs a lifecycle transition, not a hard delete. Use jq only for content known to be JSON; rendered session files ending in .jsonl are human-readable transcript views and are not guaranteed JSON. Compound commands, shell substitutions, unsupported flags, globs for mv/rm, paths outside this virtual filesystem, interpreters, network clients, and command-executing find options such as -exec are denied.

## Skill Management (skillify)

Each argument is separate — do NOT quote subcommands together.

- `memoree skillify` — show current scope, team, install location, per-project state
- `memoree skillify pull` — sync project skills from the org table to local FS
- `memoree skillify push <skill-name>` — upload a local skill
- `memoree skillify unpull` — remove pulled skills
- `memoree skillify mine-local` — mine skills from local sessions
- `memoree skillify hygiene` — curate the local skill shelf

## Limits

Do NOT spawn subagents to read Memoree memory. If a file returns empty after 2 attempts, skip it and move on.

## Getting Started

After installing, restart Antigravity (IDE or `agy`) and run `memoree doctor`. Session capture uses your existing Google login; wiki workers spawn `agy -p` the same way.
