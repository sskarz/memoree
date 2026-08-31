---
name: memoree-goals
description: Create, track and update team goals + KPIs via Memoree MCP tools (memoree_read / memoree_write / memoree_mv / memoree_rm on goal/ and kpi/ paths).
---

# Memoree Goals

Track goals and KPIs as Markdown files in Memoree memory. In Antigravity, use MCP tools — not `cat` / `printf` on `~/.memoree/memory`.

## Path conventions

```
goal/<owner>/<status>/<goal_id>.md
kpi/<goal_id>/<kpi_id>.md
```

- `<owner>` — `userName` from `memoree_read` path=`identity.json`
- `<status>` — one of `opened`, `in_progress`, `closed`
- `<goal_id>` — UUIDv4 you generate at create time
- `<kpi_id>` — short slug like `k-prs`

**Path encoding is the source of truth.** Do NOT write owner/status/goal_id/kpi_id inside the file content.

## Operations

### Create a goal

1. `memoree_read` path=`identity.json` for `userName`.
2. Generate a UUIDv4 directly (no Node/Python/`uuidgen`).
3. `memoree_write` path=`goal/<owner>/opened/<uuid>.md` content=`<description>`.

### List goals

`memoree_read` path=`goals.md`, or `memoree_ls` path=`goal/<owner>/opened`.

### Move / close

- In progress: `memoree_mv` from=`goal/<owner>/opened/<uuid>.md` to=`goal/<owner>/in_progress/<uuid>.md`
- Close: `memoree_mv` to `closed/`, or `memoree_rm` path=`goal/<owner>/opened/<uuid>.md` (soft-close)

### KPI

`memoree_write` path=`kpi/<goal_id>/<kpi-slug>.md` with:

```
PRs merged

- target: 5
- current: 2
- unit: count
```
