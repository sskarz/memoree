---
name: memoree-graph
description: Query the local code graph through Memoree MCP (memoree_read path=graph/...). Use when the user asks structural questions about the codebase.
---

# Memoree Code Graph

A deterministic, AST-derived map of the current repository. In Antigravity, query it with `memoree_read` — there are no real files on disk.

The graph **builds and refreshes automatically** on Stop. You never run a build command — just read it.

## Path cheat sheet

```
memoree_read path="graph/index.md"
memoree_read path="graph/query/<pattern>"    # START HERE (hybrid/semantic)
memoree_read path="graph/find/<pattern>"     # substring
memoree_read path="graph/show/<handle-or-pattern>"
memoree_read path="graph/neighborhood/<file>"
memoree_read path="graph/impact/<pattern>"
memoree_read path="graph/path/<from>/<to>"
memoree_read path="graph/layers"
memoree_read path="graph/tour"
```

Multi-token AND: `graph/query/<a>+<b>`.

## Workflow

1. Broad? Start at `graph/index.md`.
2. Looking for a symbol? `graph/find/<name>` or `graph/query/<name>`.
3. Relationships? `graph/show/<handle>` / `graph/neighborhood/<file>`.
4. Need the actual code? Take `source_file:line` and open the real source — don't answer from the graph alone.

Do not `cat ~/.memoree/memory/graph/...` with `run_command`.
