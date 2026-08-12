# Memoree for OpenClaw

This optional integration gives OpenClaw local Memoree capture, recall, goals, KPIs, and code-graph tools. Install it explicitly after the main Memoree setup:

```sh
memoree claw install
```

Memoree uses the backend selected in `~/.memoree/config.json`: SQLite is the default, while PostgreSQL is available through `MEMOREE_POSTGRES_URL`. No account or hosted API is involved.

Commands:

- `/memoree_capture` toggles capture for the current gateway runtime.
- `/memoree_setup` repairs an explicit OpenClaw plugin/tool allowlist when needed.

Tools:

- `memoree_search`, `memoree_read`, `memoree_index`
- `memoree_goal_add`, `memoree_kpi_add`
- `memoree_graph_search`, `memoree_graph_neighborhood`

Captured conversations are written to the selected local database. Embeddings use the local daemon under `~/.memoree`; disabled or unavailable embeddings fall back to lexical search. Run `memoree doctor` from a terminal to diagnose the shared installation.
