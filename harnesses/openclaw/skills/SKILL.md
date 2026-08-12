---
name: memoree
description: Search and update persistent local Memoree memory before answering questions about prior work.
---

# Memoree

Use `memoree_search` before answering questions that may depend on earlier sessions, decisions, or repository context. Use `memoree_read` to inspect a specific hit and `memoree_index` to browse known entries. Do not merge facts from distinct users or paths.

Use `memoree_goal_add` and `memoree_kpi_add` only when the user explicitly asks to record them. Use the graph tools for structural code questions such as callers, callees, definitions, and imports.

Memoree is local-first. SQLite is the default backend, embeddings run locally, and lexical search remains available when embeddings are disabled. If tools report storage errors, ask the user to run `memoree doctor` in a terminal.

Available slash commands:

- `/memoree_capture` — toggle capture
- `/memoree_setup` — repair explicit OpenClaw allowlists
