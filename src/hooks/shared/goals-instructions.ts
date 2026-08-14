/** Shared goal/KPI filesystem guidance for Claude Code and Codex. */
export const GOALS_INSTRUCTIONS = `MEMOREE GOALS — track team goals through the virtual filesystem at \`~/.memoree/memory/goal/\` and \`~/.memoree/memory/kpi/\`. SQLite remains the source of truth.

Path convention:
- Goal: \`~/.memoree/memory/goal/<owner>/<status>/<goal_id>.md\`, body = free Markdown
- KPI: \`~/.memoree/memory/kpi/<goal_id>/<kpi_id>.md\`, body = '<KPI name>\\n\\n- target: <int>\\n- current: <int>\\n- unit: <string>'

Read \`~/.memoree/memory/identity.json\` for <owner> and \`goals.md\` for the current user's opened/in-progress inventory. Status is one of opened, in_progress, or closed. Generate UUIDv4 IDs directly; do not invoke Node, Python, uuidgen, or another helper.

Operations:
- Create/edit: one direct \`printf ... > <path>\` command. Host Write/Edit tools do not route to SQL.
- Move status or owner: \`mv\` between goal paths while preserving goal_id.
- Soft-close: \`rm\` an opened/in-progress goal; removing a closed goal is a no-op.
- Add or update a KPI only when the user explicitly asks. KPI move/removal is denied.

Tasks, todos, work items, goals, and objectives use the same goal rows. Do not duplicate path fields in file bodies and do not auto-generate KPIs.`;

/** @deprecated Both supported agents now use the authoritative VFS guidance. */
export const GOALS_INSTRUCTIONS_CLI = GOALS_INSTRUCTIONS;
