---
name: memoree-goals
description: Create, track and update team goals + KPIs in Memoree via the `memoree` CLI. Use whenever the user mentions a goal, objective, KPI, target, milestone, or asks to track progress on something measurable. ALSO use when the user says "task", "todo", "work item", "remind me to", "fix X", or any actionable work item — the goal system replaced the legacy `memoree tasks` CLI and now covers both objectives and tasks.
allowed-tools: terminal
---

# Memoree Goals — CLI only (Hermes)

⚠️  **CRITICAL: On this runtime (Hermes), you MUST use the `memoree` shell CLI for goals + KPIs. DO NOT use `write_file` on `~/.memoree/memory/goal/...` paths — those writes go to the local filesystem and never reach the team-shared `memoree_goals` table. Other team members will NOT see them.**

The memoree-memory skill describes a generic memory layout — it does NOT apply to goals/KPIs. For goals/KPIs, use the CLI below.

## Commands (invoke via terminal tool)

```
memoree goal add "<text>"                                  # create goal, prints goal_id
memoree goal list [--mine|--all]                           # list (default --mine)
memoree goal done <goal_id>                                # mark closed
memoree goal progress <goal_id> <opened|in_progress|closed>

memoree kpi add <goal_id> <kpi_id> <target> <unit> [name]  # add KPI to goal
memoree kpi list <goal_id>                                 # list KPIs for goal
memoree kpi bump <goal_id> <kpi_id> <delta>                # increment current (int)
```

## Workflow when the user expresses a goal

1. `memoree goal add "<short description>"` — capture stdout, that's the `goal_id` (UUID).
2. If the user explicitly asks for KPIs: `memoree kpi add <goal_id> <slug> <target> <unit>` per KPI.
3. Tell the user the goal_id and that it is now team-visible in Memoree.

## Capture a task for later (with resumable context)

When the user **parks a tangential task** mid-session — "save this for later", "remind me to …", "don't let me forget …", "let's do X later" — store enough **context to resume cold** later, not just a one-liner. Tag it `--agent capture` so parked side-tasks are separable from hand-made goals:

```
memoree goal add --agent capture "Add rate-limiting to the webhook handler

Start here: add a per-IP token bucket on the handler entry path
Files: src/webhook/handler.ts:120-160, src/webhook/limits.ts
Branch: feat/webhook-hardening
Run: pnpm test webhook
Why: bursty clients hammer the endpoint; defer until retry-backoff lands"
```

Line 1 is the label (what `goal list` shows). Fill `Start here / Files / Branch / Run / Why` from the conversation; `Start here:` matters most. Pass the whole package as **one double-quoted argument** so the newlines are preserved.

## Resume a parked task (automatic context transfer)

When the user says "let's work on that task / goal" or "pick up the `<X>` task":

1. `memoree goal list --mine` — match the user's reference to a `goal_id`.
2. `memoree goal get <goal_id>` — prints the **full** package (`goal list` shows only the first line, so always use `goal get`). Read it as your working context.
3. `memoree goal progress <goal_id> in_progress` — mark it started.
4. Begin from `Start here:` using the `Files` / `Branch` / `Run` lines. Continue as if the context was never lost.

## What NOT to do

- Do NOT call `write_file` on any path under `~/.memoree/memory/goal/` or `~/.memoree/memory/kpi/`.
- Do NOT do `mkdir` / `cat >` to create those files manually via terminal.
- Do NOT auto-generate KPIs unless the user explicitly asks.

If the user wants to inspect goals you created, run `memoree goal list --mine` (terminal) and present the output.
