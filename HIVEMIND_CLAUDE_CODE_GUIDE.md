# How Hivemind Works in Claude Code

This guide describes the Claude Code integration in this repository as it exists in Hivemind `0.7.145` at commit `3c4c601b`. It focuses on the code that is actually wired into `harnesses/claude-code`, including local SQLite behavior. Where an older README or skill description disagrees with the implementation, this guide calls out the implementation as authoritative.

## The short mental model

Hivemind is a lifecycle recorder, a storage abstraction, and a virtual filesystem adapter for Claude Code.

It does four main things:

1. It listens to Claude Code lifecycle events and records prompts, tool activity, and assistant responses.
2. It stores those events and derived data in Deeplake, SQLite, or PostgreSQL.
3. It makes stored data look to Claude like files under `~/.deeplake/memory/`, even though those files generally do not exist on the normal filesystem.
4. It runs background jobs that turn raw events into summaries, reusable skills, code graphs, and optional code documentation.

The most important implementation detail is this:

> The Claude plugin does not add a native `database` tool or automatically register Hivemind's MCP tools. It intercepts Claude's existing tools when they target `~/.deeplake/memory/` and translates those operations into storage queries.

For example, when Claude runs:

```bash
cat ~/.deeplake/memory/index.md
```

Claude Code first invokes its normal `Bash` tool. The Hivemind `PreToolUse` hook sees that the command touches the memory mount, queries the selected backend, synthesizes the index text, and replaces the original command with a safe command that prints the result. The host shell never reads a real `~/.deeplake/memory/index.md` file.

With local SQLite, the architecture is roughly:

```text
Claude Code
  |
  | lifecycle event JSON on stdin
  v
Hivemind hook process (Node.js bundle)
  |
  | provider-neutral storage calls / SQL
  v
node:sqlite DatabaseSync
  |
  v
~/.deeplake/hivemind.sqlite3
```

For memory reads, there is an additional interception layer:

```text
Claude uses Bash/Read/Grep/Glob
  |
  | command or path targets ~/.deeplake/memory
  v
PreToolUse hook
  |
  +-- fast compiled handler for common cat/grep/ls/find operations
  +-- graph and docs virtual-path handlers
  +-- sandboxed just-bash virtual shell as a fallback
  |
  v
SQLite/PostgreSQL/Deeplake rows rendered as text
```

## What the Claude Code plugin installs

The Claude plugin lives in [`harnesses/claude-code`](harnesses/claude-code). Its manifest is [`harnesses/claude-code/.claude-plugin/plugin.json`](harnesses/claude-code/.claude-plugin/plugin.json), and its hook wiring is [`harnesses/claude-code/hooks/hooks.json`](harnesses/claude-code/hooks/hooks.json).

It contributes four kinds of things:

| Surface | What is added |
| --- | --- |
| Lifecycle hooks | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, and `SessionEnd` handlers |
| Skills | `hivemind-memory`, `hivemind-goals`, and `hivemind-graph` |
| Slash commands | `/hivemind:login` and `/hivemind:update` |
| Bundled workers | Summary, skill-mining, skill-optimization, graph, embedding, cache-GC, auth, and virtual-shell programs |

### Does it add tools to Claude?

Not in the usual native-tool sense.

The Claude Code harness contains no MCP configuration and no custom tool schema. Claude continues to use tools it already has, principally:

- `Bash`
- `Read`
- `Grep`
- `Glob`
- `Write`
- `Edit`

Hivemind changes the behavior of those tools only when their path or command touches the configured memory mount, which defaults to `~/.deeplake/memory`.

The three Hivemind skills declare subsets of Claude's existing tools:

- `hivemind-memory`: `Grep`, `Read`, and `Bash`
- `hivemind-goals`: `Read` and `Bash`
- `hivemind-graph`: `Read` and `Bash`

The repository does separately ship a stdio MCP server in [`src/mcp/server.ts`](src/mcp/server.ts). That server exposes `hivemind_search`, `hivemind_docs_search`, `hivemind_read`, and `hivemind_index`. Those are not registered by this Claude Code plugin harness, so they do not appear merely because you launch Claude with `--plugin-dir`. A client would have to configure the MCP server separately.

## The hook lifecycle

Claude Code sends a JSON payload to each command hook on standard input. The hook either performs background work or prints a Claude hook response as JSON. Hivemind bundles each TypeScript entry point into a standalone JavaScript program under `harnesses/claude-code/bundle/`.

The exact hook order and timing are:

| Claude event | Hivemind program | Timeout | Async? | Purpose |
| --- | --- | ---: | --- | --- |
| `SessionStart` | `session-start.js` | 10 s | No | Inject memory instructions, backend identity, rules, goals, and graph/docs hints; create initial state |
| `SessionStart` | `session-notifications.js` | 8 s | No | Show user-visible notices without putting them in model context |
| `SessionStart` | `session-start-setup.js` | 120 s | Yes | Provision graph dependencies, initialize storage, and warm embeddings |
| `UserPromptSubmit` | `capture.js` | 10 s | Yes | Store the user's prompt as a session event |
| `UserPromptSubmit` | `recall.js` | 2 s | No | Optionally inject one semantically relevant prior summary |
| `PreToolUse` | `pre-tool-use.js` | 60 s | No | Intercept memory-mount operations before the real tool runs |
| `PostToolUse` | `capture.js` | 15 s | Yes | Store the tool name, input, and response |
| `Stop` | `capture.js` | 30 s | Yes | Store the assistant's final response and tick background summary/skill triggers |
| `Stop` | `graph-on-stop.js` | 30 s | Yes | Rebuild the local code graph when its gates say it is stale |
| `SubagentStop` | `capture.js` | 30 s | Yes | Store a subagent's final response and metadata |
| `SessionEnd` | `session-end.js` | 60 s | No | Mark the session ended and spawn summary/skill workers |
| `SessionEnd` | `plugin-cache-gc.js` | 15 s | Yes | Remove old marketplace plugin versions while keeping the newest three |
| `SessionEnd` | `graph-on-stop.js` | 30 s | Yes | Give the graph another opportunity to refresh |

`async: true` is important: Claude Code does not wait for the work to finish before continuing. It also means a query immediately after a prompt or immediately after Claude exits can race an event write or summary worker.

Most hooks deliberately fail soft. They log and exit successfully rather than breaking the Claude session. This makes Claude resilient to storage outages, but it also means a missing capture can be silent unless debugging is enabled.

## What happens at session start

The primary `SessionStart` hook performs both setup and prompt injection.

### 1. It establishes session sidecar state

It records that the session is active, associates it with the owning Claude process where possible, updates a heartbeat, and clears an old ended marker when a session is resumed. These files help Hivemind decide whether another session is still live and whether a resume notice is appropriate.

The sidecar state lives under:

```text
~/.claude/hooks/summary-state/<session-id>.json
~/.claude/hooks/summary-state/<session-id>.lock
~/.claude/hooks/summary-state/<session-id>.ended
~/.claude/hooks/summary-state/<session-id>.owner
```

### 2. It resolves storage

The provider selection precedence is:

```text
HIVEMIND_BACKEND environment variable
  > ~/.deeplake/config.json storage.provider
  > deeplake
```

SQLite does not require Deeplake credentials. PostgreSQL requires `HIVEMIND_POSTGRES_URL`. Deeplake requires a token and organization.

For Deeplake, the nearest `.hivemind` or `.hivemind.local` file can route organization/workspace access. For SQLite and PostgreSQL, organization/workspace routing does not create another SQL namespace: the SQLite file or PostgreSQL schema is the effective workspace boundary. `collect: false` is still honored for all providers.

### 3. It creates or heals core tables

When capture is enabled, the hook ensures the memory and sessions tables exist and creates an `in progress` placeholder summary for the session. Table creation and healing are additive and idempotent: existing tables remain, and missing known columns are added.

If `HIVEMIND_CAPTURE=false`, the primary hook treats the session as read-only and skips both writes and schema-changing DDL. There is a current caveat: the separate async `session-start-setup.js` hook does not check that flag before ensuring the `memory` and `sessions` tables. Therefore the Claude integration is not strictly zero-DDL under `HIVEMIND_CAPTURE=false`, even though event capture, the placeholder, session-end summary orchestration, and the primary hook's DDL are disabled. The same caveat applies to a directory-level `collect: false` because the async setup hook loads routed storage without consulting the collect result.

### 4. It injects instructions into Claude's model context

The hook returns `hookSpecificOutput.additionalContext`. In Claude Code this is model-only context, not a normal user-visible chat message.

The injected instructions tell Claude:

- there are two memory sources: Claude's built-in memory and Hivemind;
- to start at Hivemind's virtual `index.md`;
- to prefer summaries before raw JSONL sessions;
- how to resume work from a previous summary;
- how to use Hivemind organization, skill, and embedding commands;
- to use safe shell-style commands for the virtual mount;
- not to spawn subagents merely to read memory;
- which backend is active and whether collection is disabled.

It can also append:

- up to ten active Hivemind rules;
- up to ten current-user goals in `opened` or `in_progress` state;
- a one-line description of the local code graph and its age;
- a hint that project documentation exists;
- a note about locally mined skills.

Rules and goals are sanitized before insertion to reduce newline-based prompt injection from stored content.

### 5. It pulls skills and starts background maintenance

Every session start attempts an idempotent skill pull into `~/.claude/skills/`, bounded to five seconds. Disable this with:

```bash
HIVEMIND_AUTOPULL_DISABLED=1 claude
```

The detached setup hook can also:

- provision tree-sitter packages used by graph extraction;
- initialize or heal the selected backend;
- warm the optional local embedding daemon;
- trigger an auto-update check;
- trigger an opted-in documentation refresh check.

### 6. It displays separate user notifications

`session-notifications.js` emits user-facing `systemMessage` content separately from model context. It drains version, backend, onboarding, balance, and rule-driven notifications with deduplication. This separation is intentional: billing or account notices should be shown to the person, not injected as instructions to the model.

## What exactly is captured

The capture hook writes one independent row per event into the `sessions` table. It does not continually rewrite a single giant transcript row.

### User prompt event

On `UserPromptSubmit`, the stored JSON resembles:

```json
{
  "id": "<uuid>",
  "session_id": "<claude-session-id>",
  "transcript_path": "<claude-transcript-path>",
  "cwd": "<working-directory>",
  "permission_mode": "<mode>",
  "hook_event_name": "UserPromptSubmit",
  "timestamp": "<ISO timestamp>",
  "type": "user_message",
  "content": "<full user prompt>"
}
```

### Tool event

On `PostToolUse`, it stores:

- `type: "tool_call"`;
- the tool name;
- the tool-use ID;
- the full serialized tool input;
- the full serialized tool response;
- the common session metadata.

This can be a large and sensitive payload. A command, file content, build log, API response, or tool error returned to Claude may end up in the database.

### Assistant or subagent event

On `Stop` and `SubagentStop`, it stores:

- `type: "assistant_message"`;
- the final assistant text;
- subagent identifiers and transcript path when present;
- best-effort model and token-usage metadata parsed from Claude's transcript.

### Row metadata

Each database row also has searchable metadata outside the JSON message:

- row UUID;
- virtual session path;
- filename;
- optional message embedding;
- author;
- MIME type;
- byte size;
- project name;
- Claude hook event description;
- agent name (`claude_code`);
- plugin version;
- creation and update timestamps.

The virtual path is shared by all events in one session. Reading that session through the VFS queries all matching rows in chronological order and joins their JSON messages with newlines.

### Redaction

Before either storage or embedding, Hivemind serializes the event and passes it through its secret redactor. The intent is to mask recognizable tokens, API keys, passwords, and similar credential shapes.

Treat this as defense in depth, not a guarantee. Redaction is heuristic. Novel credentials, private source code, personal data, database results, and secrets in an unrecognized format can still be captured. Do not enable capture in a directory whose tool activity must never be retained.

### Local event mirror

After a successful database insert, Hivemind appends the same serialized event to:

```text
~/.claude/hooks/session-cache/<session-id>.jsonl
```

This is a performance cache for the summary worker. The selected database remains the source of truth. Cache files older than 14 days are pruned opportunistically at session end. Set `HIVEMIND_SESSION_EVENT_CACHE=0` to disable the mirror and force summary workers to read the database.

## The virtual memory filesystem

`~/.deeplake/memory` is a trigger path, not normally a disk directory containing the shared memory files.

The default is configured by `HIVEMIND_MEMORY_PATH`. Once a tool operation touches it, Hivemind rewrites the path to its internal virtual root `/` and dispatches by virtual path.

The important path families are:

```text
~/.deeplake/memory/
├── index.md
├── summaries/<user>/<session-id>.md
├── sessions/<user>/<generated-session-name>.jsonl
├── goal/<owner>/<opened|in_progress|closed>/<goal-id>.md
├── kpi/<goal-id>/<kpi-id>.md
├── graph/
│   ├── index.md
│   ├── query/<pattern>
│   ├── find/<pattern>
│   ├── show/<handle-or-pattern>
│   ├── neighborhood/<file>
│   ├── impact/<pattern>
│   ├── path/<from>/<to>
│   ├── layers
│   └── tour
└── docs/
    ├── index.md
    ├── <project tree and pages>
    └── find/<query>
```

### `index.md`

`index.md` is synthesized from the most recently updated summary and session paths. It is not a stored SQLite file. It includes creation/update time, project, and description, with a default limit of 50 entries per section. Hivemind caches the rendered index for the current Claude session under `~/.deeplake/query-cache/`.

### Summaries

Summary rows live in the `memory` table. The VFS renders their `summary` column as Markdown. A session-start placeholder may appear as `in progress` until the background wiki worker finishes.

### Raw sessions

A raw session is represented by many rows in the `sessions` table. All events have the same virtual path. A VFS read orders those rows and reconstructs one JSONL document.

### Read and search interception

The `PreToolUse` hook supports fast paths for common operations including:

- `cat`, `head`, `tail`, and `wc -l`;
- `ls` and compatible `Glob` requests;
- supported `grep` forms;
- `find ... -name ...`;
- bounded combinations handled by the command compiler.

For a Claude `Read` call, the hook cannot return arbitrary file content directly in the same shape. It materializes the query result under:

```text
~/.deeplake/query-cache/<session-id>/read/<virtual-path>
```

and changes `Read.file_path` to that real temporary cache file.

For Bash-style calls, it commonly rewrites the command to a safely quoted `echo` of the query result. More complex supported commands run through the bundled `deeplake-shell.js`, which uses `just-bash` over the Hivemind virtual filesystem rather than the host filesystem.

If an unsupported interpreter or unsafe command shape touches the memory mount, the hook returns retry guidance instead of letting it fall through to the real shell. This prevents a mixed or malformed virtual-memory command from accidentally operating on a similarly shaped host path.

### Why `Write` and `Edit` are denied

A `PreToolUse` hook can change a tool's input, but it cannot turn Claude's `Write` tool into a `Bash` tool. `Write` and `Edit` are therefore denied on the memory mount with instructions to use intercepted Bash redirection instead:

```bash
echo 'text' > ~/.deeplake/memory/goal/alice/opened/<uuid>.md
```

or:

```bash
cat > ~/.deeplake/memory/goal/alice/opened/<uuid>.md <<'EOF'
multi-line content
EOF
```

## Search and recall are two different mechanisms

It is useful to separate manual/reactive memory search from proactive recall.

### Manual or reactive search

Claude can explicitly run a supported `grep` against the VFS. That path searches summaries and sessions. It has a lexical path and can add semantic scoring when embeddings are enabled and available.

This works with embeddings disabled:

```bash
grep -ri "sqlite" ~/.deeplake/memory/summaries/
```

The current session-start instruction recommends Bash `grep` on a specific `summaries/` or `sessions/` subtree. Although parts of the hook also understand Claude's built-in `Grep`, Bash grep is the intended and most consistently supported interface on this virtual mount.

### Proactive recall

On a recall-worthy user prompt, the synchronous `recall.js` hook may search prior summaries and silently inject one attributed snippet into Claude's model context.

This path is deliberately conservative:

- cheap gates skip short acknowledgements and prompts unlikely to need memory;
- it searches summary rows, excluding the current session;
- it asks for up to three candidates;
- it injects only the best candidate if it clears the cosine threshold;
- it has a default total budget of 1.5 seconds inside a two-second hook timeout;
- a timeout or error produces no injection and does not block the turn.

In the current implementation, proactive recall is semantic-only. If embeddings are disabled, unavailable, malformed, or fail to produce a query vector, proactive recall skips. It does not use a lexical fallback. Some older README wording still describes a proactive lexical mode; that is not what [`src/hooks/recall.ts`](src/hooks/recall.ts) currently does.

This distinction means:

| Embeddings state | Explicit VFS grep | Automatic proactive recall |
| --- | --- | --- |
| Enabled and healthy | Lexical plus optional semantic behavior | Available |
| Disabled or unavailable | Lexical search still works | Skipped |

Proactive-recall attempts are recorded independently of debug mode in:

```text
~/.deeplake/recall-events.jsonl
```

Disable only proactive recall with either:

```bash
HIVEMIND_PROACTIVE_RECALL_DISABLED=1 claude
HIVEMIND_PROACTIVE_RECALL=0 claude
```

Capture and explicit VFS searches continue to work.

## How summaries are generated

Raw event capture and session summarization are separate.

### Triggering

A summary worker can be triggered:

- at session end;
- periodically after enough captured events;
- periodically after enough elapsed time with at least one new event.

The default periodic cadence is 50 events or two hours, with special first-summary behavior after an initial smaller event count. Per-session locks prevent periodic and session-end workers from overwriting each other.

### Worker flow

The detached wiki worker:

1. Reads the local session event cache when complete enough, otherwise queries `sessions`.
2. Loads the existing summary and last processed event offset for a resumed session.
3. Selects only events newer than that offset and caps the input size.
4. Writes temporary JSONL and summary files.
5. Runs the host `claude -p` CLI with a structured summarization prompt.
6. Reads the generated Markdown file.
7. Redacts secrets again.
8. Optionally embeds the summary.
9. Upserts the summary row in `memory` and advances the sidecar offset.

The worker has a 120-second Claude invocation timeout and is detached, so Claude Code can exit while summarization continues. Immediate inspection can therefore find session rows but still see an `in progress` summary.

The summary contains sections for what happened, people, entities, decisions, key facts, files modified, open questions, and next steps. It is capped to a compact wiki-style entry.

### A critical local-storage privacy boundary

Using SQLite keeps the database itself local. It does not make all Hivemind processing offline.

The summary worker passes a slice of captured session data to your installed Claude CLI using `claude -p`. That request uses the Claude CLI's existing authentication and plan rather than a separate Hivemind API key, but it is still an LLM service call. Skill mining and optional documentation generation can similarly invoke a host agent CLI.

If you require storage and processing to remain entirely offline, disable the LLM-derived background features or do not run this plugin as currently wired. Setting `HIVEMIND_WIKI_WORKER=1` in a top-level Claude launch suppresses the summary worker through its recursion guard, while capture and explicit memory reads remain separate. Be aware that this variable is also used internally by workers, so it is a blunt operational switch rather than a polished user setting.

## Goals and KPIs

The `hivemind-goals` skill teaches Claude to treat goals and KPIs as virtual Markdown files.

Goal paths are:

```text
/goal/<owner>/<status>/<goal-id>.md
```

where status is one of `opened`, `in_progress`, or `closed`.

KPI paths are:

```text
/kpi/<goal-id>/<kpi-id>.md
```

The path is the structural source of truth. Owner, status, goal ID, and KPI ID are not duplicated in the body.

Writes are versioned rather than destructive:

- creating or overwriting a goal inserts a new version;
- moving a goal between status directories inserts a new version with the new status;
- moving between owner directories reassigns it;
- `rm` on a goal soft-closes it by writing a `closed` version;
- older versions remain in the SQL table for audit history.

KPI bodies conventionally contain one-line `target`, `current`, and `unit` values.

The skill advises Claude not to invent KPIs unless the user explicitly requests them. Parked tasks can be stored as goals with detailed resume context through `hivemind goal add --agent capture`.

The current `hivemind-goals` skill text still describes automatic KPI progress after `git commit`. The live capture implementation explicitly disables that feature because spawning a reasoning pass for every commit consumed too many tokens. No commit-driven KPI update is currently wired. Manual KPI reads and writes work.

That skill also suggests a surgical `sed -i` edit. The current memory-path safety allowlist explicitly removes `sed` and `awk` because both can execute commands in supported forms. Use `cat` plus a quoted heredoc to overwrite the complete KPI body instead.

## Rules

Hivemind rules are versioned rows with active/done status and team scope. Session start reads the latest active rules and adds a bounded, sanitized rules block to Claude's model context.

Rules are intended for durable operating principles such as repository policies or safety constraints. Because they enter model context automatically, only trusted users and content should be allowed to write them.

## Skill mining and sharing

Hivemind has two related systems: Skillify and SkillOpt.

### Skillify

Skillify mines repeated workflows from past session events and converts them into Claude skills, normally written under:

```text
<project>/.claude/skills/<skill-name>/SKILL.md
```

or promoted/pulled globally under:

```text
~/.claude/skills/<skill-name>/SKILL.md
```

Mining can run:

- after every configured number of assistant turns; the default is 20;
- at session end;
- manually through `hivemind skillify mine-local`.

The mining worker is detached and can invoke `claude -p` to identify reusable behavior. Depending on configured scope, a skill can be stored in the `skills` table. Re-pushing creates another version. Session start auto-pulls stored skills from all users into the global Claude skill directory, skipping local copies that are already current.

Local skill state and manifests live under:

```text
~/.deeplake/state/skillify/
```

Worker activity is logged to:

```text
~/.claude/hooks/skillify.log
```

### SkillOpt

When Hivemind observes use of an organization skill in `PreToolUse`, it can arm SkillOpt for that session. A later user reaction can be interpreted as feedback on that skill, and a detached optimization worker may update the learned skill after its trigger conditions are met.

This is not a general review of every response. It is tied to observed skill use and accumulated feedback state.

## Code graph

The graph subsystem builds an AST-derived snapshot of the repository and exposes synthesized query paths under `/graph/`.

The snapshot tracks symbols and relationships such as:

- modules, functions, methods, classes, interfaces, types, enums, and constants;
- calls and callers where statically resolvable;
- imports;
- `extends`, `implements`, and `method_of` edges.

At `Stop` and `SessionEnd`, `graph-on-stop.js` checks several gates:

- `HIVEMIND_GRAPH_ON_STOP=0` disables it;
- a default ten-minute rate limit avoids constant rebuilding;
- git state and file changes determine whether a rebuild is needed;
- graph dependencies must be provisioned.

Local graph state is stored under:

```text
~/.hivemind/graphs/<repository-key>/
```

Graph reads use the local snapshot and do not make a network request. A separate push/pull path can synchronize snapshot data through the selected backend's `codebase` table when enabled and available.

The graph is an index, not source truth. It can lag recent edits, dynamic dispatch is incomplete, and a symbol with no recorded incoming edge is not necessarily unused. The current Claude graph skill documents its primary supported coverage as TypeScript, JavaScript, and Python. Always open current source before making a consequential claim.

## Code documentation

Hivemind also contains an optional code-docs system. When explicitly onboarded, it stores versioned, project-scoped pages in `hivemind_docs` and exposes them under `/docs/`.

The docs system can:

- render a directory-like index;
- read per-source pages;
- search pages lexically and, when available, semantically;
- track source fingerprints and show stale-state information;
- keep private branch overlays separate from canonical main-branch pages;
- invoke a configured host LLM CLI for refreshes.

Session start only injects a docs hint and runs refresh checks when the local docs-consent registry says the project was onboarded. It is not automatically enabled for every repository.

## Storage backends

The same higher-level storage interface is implemented for three providers:

| Provider | Boundary | Authentication | Vector representation |
| --- | --- | --- | --- |
| Deeplake | organization plus workspace | Deeplake credentials | backend array/vector type |
| SQLite | one database file | none | JSON text |
| PostgreSQL | one configured schema | connection URL in environment | double-precision array |

The backend interface includes querying, execution, transactions, schema initialization/healing, table introspection, batched row writes, and table-specific ensure methods. Most feature code is provider-neutral above this layer.

### Logical tables

The initialized schema contains:

| Default table | Purpose |
| --- | --- |
| `memory` | AI-generated session summaries and optional embeddings |
| `sessions` | One raw JSON event per captured hook event |
| `skills` | Versioned reusable skills, provenance, scope, and installation metadata |
| `hivemind_rules` | Versioned active/done team rules |
| `hivemind_goals` | Versioned goals with owner and status |
| `hivemind_kpis` | Versioned KPI bodies linked to goals |
| `hivemind_docs` | Versioned project documentation and optional embeddings |
| `codebase` | Code-graph snapshots and synchronization metadata |

Most names can be overridden through environment variables, but changing them creates an advanced and potentially confusing configuration. The canonical schema definitions are in [`src/deeplake-schema.ts`](src/deeplake-schema.ts).

## SQLite in detail

### Where the database is stored

The default SQLite file is:

```text
~/.deeplake/hivemind.sqlite3
```

The actual expanded path on macOS is normally:

```text
/Users/<your-user>/.deeplake/hivemind.sqlite3
```

You can select a custom path persistently:

```bash
node bundle/cli.js backend use sqlite --path "$HOME/.deeplake/hivemind-local-test.sqlite3"
```

The CLI validates the backend, creates/heals all tables, and persists only the provider and SQLite path in:

```text
~/.deeplake/config.json
```

Verify the effective selection rather than assuming it:

```bash
node bundle/cli.js backend status
node bundle/cli.js backend check
```

The `status` output is the authoritative answer to “which file will hooks use?” unless the Claude process is launched with overriding environment variables.

Do not put a backslash between `sqlite` and `--path`. A backslash followed by a space escapes the space and changes argument parsing. The correct command is one logical line as shown above, or a multiline command with the backslash at the very end of the line:

```bash
node bundle/cli.js backend use sqlite \
  --path "$HOME/.deeplake/hivemind-local-test.sqlite3"
```

### How Hivemind opens it

The SQLite backend lazily imports Node's built-in `node:sqlite` module, then creates a `DatabaseSync` connection. It configures:

- a 5-second busy timeout;
- WAL journal mode;
- foreign keys on;
- `synchronous=NORMAL`;
- serialized operations within each backend instance;
- `BEGIN IMMEDIATE` transactions;
- up to six busy retries with increasing 25 ms steps.

WAL allows multiple short-lived hook processes to cooperate more safely. While the database is active, SQLite may create sibling files:

```text
hivemind.sqlite3-wal
hivemind.sqlite3-shm
```

Those are normal SQLite files and should be kept with the main database while active.

Each Claude hook is a separate Node process. It loads the persisted configuration, opens the same database file, performs a short operation, and exits. Detached workers do the same. There is no long-running SQL server and no network socket for the SQLite backend.

Node may print:

```text
ExperimentalWarning: SQLite is an experimental feature
```

That warning comes from the Node version's `node:sqlite` API status; it is not a failed backend check.

### Why the earlier `no such table: sessions` error happened

The earlier backend command reported:

```text
Backend set to sqlite (~/.deeplake/hivemind.sqlite3).
```

and `backend status` also reported the default `~/.deeplake/hivemind.sqlite3`. The later inspection script instead opened:

```text
~/.deeplake/hivemind-local-test.sqlite3
```

Those are two different databases. Opening a nonexistent path with `new DatabaseSync(path)` creates a new empty SQLite file. The empty file naturally had no `sessions` table, producing `no such table: sessions`.

That error did not demonstrate that Hivemind failed to initialize its selected database. It demonstrated that the inspection command opened a different file. Always copy the path from `backend status` into `DB_PATH`.

## Fork-safe local Claude setup

For this fork, use the built harness directly. The normal installer and marketplace commands point to `activeloopai/hivemind`, not to your fork.

### Build and choose SQLite

```bash
npm ci
npm run build

node bundle/cli.js backend use sqlite \
  --path "$HOME/.deeplake/hivemind-local-test.sqlite3"

node bundle/cli.js backend status
node bundle/cli.js backend check
```

### Disable upstream auto-update while testing the fork

The session-start hook can dispatch a detached `hivemind update` on every session start when autoupdate is enabled and a `hivemind` binary is on `PATH`. In a development checkout, that updater is still tied to the published npm/upstream installation flow, not to your current Git branch.

Disable it persistently for fork testing:

```bash
node bundle/cli.js autoupdate off
```

Also avoid `/hivemind:update` during local fork testing. That slash command refreshes and updates the upstream Claude marketplace plugin.

### Launch the local harness

From the repository root:

```bash
claude --plugin-dir "$PWD/harnesses/claude-code"
```

Claude Code sets `CLAUDE_PLUGIN_ROOT` to that harness. The hook commands then execute the freshly built bundles from `harnesses/claude-code/bundle/`.

After changing TypeScript, run `npm run build` again and start a new Claude session. A running session does not magically reload newly generated bundles.

Some injected instructions invoke the bare `hivemind` CLI for goal, skill, or organization management. Core hooks work from the harness bundle, but those bare commands also require a Hivemind executable on `PATH`. During development, invoke `node "$PWD/bundle/cli.js" ...` yourself, or deliberately link/install the CLI if Claude itself needs to run those commands.

### What not to use for the fork

These commands select the upstream marketplace and are not a way to install your fork:

```text
hivemind claude install
/plugin marketplace add activeloopai/hivemind
/plugin install hivemind
/hivemind:update
```

## An end-to-end local test

### 1. Confirm the exact database

```bash
node bundle/cli.js backend status
node bundle/cli.js backend check
```

Assume the status line says:

```text
Database: ~/.deeplake/hivemind-local-test.sqlite3
```

### 2. Start Claude with the local plugin

```bash
claude --plugin-dir "$PWD/harnesses/claude-code"
```

In Claude, send a unique prompt such as:

```text
Remember this local Hivemind test marker: sapphire-wombat-8472.
```

Let Claude answer. Ask it to inspect the memory index using the virtual mount:

```text
Use Hivemind's Bash memory interface to read ~/.deeplake/memory/index.md.
```

Then exit Claude normally so `SessionEnd` fires.

### 3. Inspect the same SQLite file

```bash
DB_PATH="$HOME/.deeplake/hivemind-local-test.sqlite3" \
node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync(process.env.DB_PATH);
  console.log(db.prepare(`
    SELECT creation_date, author, message
    FROM sessions
    WHERE CAST(message AS TEXT) LIKE ?
    ORDER BY creation_date DESC
    LIMIT 10
  `).all("%sapphire-wombat-8472%"));
  db.close();
'
```

If `backend status` shows a different file, change `DB_PATH` to that file.

### 4. Inspect tables and counts

```bash
DB_PATH="$HOME/.deeplake/hivemind-local-test.sqlite3" \
node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync(process.env.DB_PATH);
  console.log("tables", db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = ? AND name NOT LIKE ?
    ORDER BY name
  `).all("table", "sqlite_%"));
  for (const name of ["memory", "sessions", "skills", "hivemind_rules", "hivemind_goals", "hivemind_kpis", "hivemind_docs", "codebase"]) {
    console.log(name, db.prepare(`SELECT count(*) AS n FROM "${name}"`).get());
  }
  db.close();
'
```

Only run this after `backend check`, which initializes all default tables.

### 5. Check the asynchronous summary

The session row should appear before its final summary because capture hooks are async and the wiki worker is detached. Inspect the worker log:

```bash
tail -n 100 ~/.claude/hooks/deeplake-wiki.log
```

Then query summaries:

```bash
DB_PATH="$HOME/.deeplake/hivemind-local-test.sqlite3" \
node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync(process.env.DB_PATH);
  console.log(db.prepare(`
    SELECT path, project, description, last_update_date
    FROM memory
    WHERE path LIKE ?
    ORDER BY last_update_date DESC
    LIMIT 10
  `).all("/summaries/%"));
  db.close();
'
```

If a row remains `in progress`, use the wiki log to distinguish an active worker, a `claude -p` failure, a storage error, or a session with no captured events.

### 6. Test recall deliberately

With embeddings disabled, test explicit lexical recall:

```text
Use Bash grep on ~/.deeplake/memory/summaries/ for sapphire-wombat-8472.
```

To test automatic proactive recall, install and enable embeddings first, create a completed summary, then ask a new recall-worthy question in another session. Check `~/.deeplake/recall-events.jsonl` to see whether the hook injected, missed, timed out, or skipped below threshold.

## Configuration controls most relevant to Claude

| Setting | Meaning |
| --- | --- |
| `HIVEMIND_BACKEND` | Runtime provider override: `deeplake`, `sqlite`, or `postgres` |
| `HIVEMIND_SQLITE_PATH` | Runtime SQLite path override |
| `HIVEMIND_POSTGRES_URL` | PostgreSQL URL; required at runtime and never persisted by the backend command |
| `HIVEMIND_POSTGRES_SCHEMA` | PostgreSQL workspace schema, default `hivemind` |
| `HIVEMIND_MEMORY_PATH` | Host path prefix that triggers virtual-memory interception |
| `HIVEMIND_CAPTURE=false` | Disable event capture, placeholder creation, and session-end summary orchestration; the current async setup hook can still ensure `memory` and `sessions` |
| `HIVEMIND_CAPTURE_ONLY_CLI=true` | Skip Agent SDK and other noninteractive Claude entry points |
| `.hivemind` `collect: false` | Disable capture for a directory tree while leaving reads available |
| `HIVEMIND_DEBUG=1` | Enable verbose hook logging |
| `HIVEMIND_PROACTIVE_RECALL_DISABLED=1` | Disable automatic recall injection only |
| `HIVEMIND_SEMANTIC_SEARCH=false` | Disable semantic search paths |
| `HIVEMIND_RECALL_TIMEOUT_MS` | Proactive recall's total synchronous budget, default 1500 ms |
| `HIVEMIND_SUMMARY_EVERY_N_MSGS` | Periodic summary event threshold, default 50 |
| `HIVEMIND_SUMMARY_EVERY_HOURS` | Periodic summary elapsed-time threshold, default 2 |
| `HIVEMIND_SESSION_EVENT_CACHE=0` | Disable the local summary event mirror |
| `HIVEMIND_SKILLIFY_EVERY_N_TURNS` | Mid-session skill-mining threshold, default 20 |
| `HIVEMIND_AUTOPULL_DISABLED=1` | Disable skill auto-pull at session start |
| `HIVEMIND_GRAPH_ON_STOP=0` | Disable automatic local graph rebuilds |
| `HIVEMIND_GRAPH_PULL=0` | Disable graph snapshot pull |
| `HIVEMIND_GRAPH_PUSH=0` | Disable graph snapshot push |
| `HIVEMIND_EMBED_WARMUP=false` | Skip session-start embedding-daemon warmup |
| `HIVEMIND_WIKI_WORKER=1` | Recursion guard that also suppresses summary-worker orchestration when set on the top-level session |

Embeddings are persisted in `~/.deeplake/config.json` and should normally be managed with:

```bash
node bundle/cli.js embeddings status
node bundle/cli.js embeddings install
node bundle/cli.js embeddings enable
node bundle/cli.js embeddings disable
```

In the current code, a machine with no persisted `embeddings.enabled` value seeds it from `HIVEMIND_EMBEDDINGS` once. An unset variable seeds `enabled: false`. After that migration, the persisted setting wins; repeatedly changing the environment variable is not the normal control path.

## Files Hivemind creates outside the selected database

Even with SQLite, Hivemind uses local sidecar files:

| Path | Purpose |
| --- | --- |
| `~/.deeplake/config.json` | Provider, SQLite path/PostgreSQL schema, autoupdate, embeddings, and docs preferences |
| `~/.deeplake/credentials.json` | Deeplake credentials, if the cloud provider is used |
| `~/.deeplake/hook-debug.log` | Opt-in verbose hook diagnostics |
| `~/.deeplake/recall-events.jsonl` | Always-on proactive-recall outcome telemetry |
| `~/.deeplake/query-cache/` | Per-session rendered index and temporary Read-tool files |
| `~/.deeplake/state/skillify/` | Skillify manifests, scope, counters, locks, and SkillOpt state |
| `~/.claude/hooks/session-cache/` | Local event mirror for summary performance |
| `~/.claude/hooks/summary-state/` | Summary offsets, trigger counts, locks, and live/ended markers |
| `~/.claude/hooks/deeplake-wiki.log` | User-visible summary worker log |
| `~/.claude/hooks/skillify.log` | Skill-mining activity |
| `~/.hivemind/graphs/` | Local code-graph snapshots and state |
| `~/.hivemind/docs-private/` | Private docs overlays when that feature is used |

## Network behavior with SQLite

SQLite removes the need for Deeplake authentication and remote database traffic. Other features can still use the network.

| Activity | Local with SQLite? | Notes |
| --- | --- | --- |
| Event inserts and memory reads | Yes | Direct file access through `node:sqlite` |
| Goal, KPI, rule, skill, docs, graph-table rows | Yes | Stored in the same file unless an external feature invokes another service |
| VFS rendering | Yes | Runs in hook processes |
| Graph snapshot reads | Yes | Read from `~/.hivemind/graphs/` |
| Local embeddings after model installation | Yes | Local daemon/model; initial dependency/model installation may download data |
| Session summary generation | No, not fully | Invokes `claude -p` with captured session material |
| Skill mining/optimization | No, not fully | Can invoke the host Claude CLI |
| Docs generation | No, not fully | Can invoke a selected host agent CLI |
| Hivemind auto-update | No | Checks/upgrades through the published npm flow when enabled |
| `/hivemind:login` | No | Deeplake cloud authentication; unnecessary for SQLite |
| `/hivemind:update` | No | Upstream Claude marketplace update |

## Common failure modes

### `no such table: sessions`

Most commonly, the inspection program opened a different or newly created database file. Compare its exact path with `backend status`, then run `backend check` against the selected provider.

### Backend status shows the default path after specifying a custom path

The CLI did not receive a valid `--path` argument. Re-run the command without an escaped space:

```bash
node bundle/cli.js backend use sqlite --path "$HOME/.deeplake/hivemind-local-test.sqlite3"
```

### Claude exits or no events appear

Confirm all of the following:

- Claude was launched with `--plugin-dir "$PWD/harnesses/claude-code"`;
- the project trust prompt was accepted;
- `npm run build` was run after the latest source changes;
- `HIVEMIND_CAPTURE` is not `false`;
- the nearest `.hivemind`/`.hivemind.local` does not set `collect: false`;
- `HIVEMIND_CAPTURE_ONLY_CLI` is not excluding this entry point;
- the Hivemind plugin is enabled in Claude;
- the exact database from `backend status` is being inspected.

Then launch once with:

```bash
HIVEMIND_DEBUG=1 claude --plugin-dir "$PWD/harnesses/claude-code"
```

and inspect `~/.deeplake/hook-debug.log`.

### Session events exist but no summary exists

That means capture worked and the derived worker did not finish. Inspect `~/.claude/hooks/deeplake-wiki.log`. Common reasons include the detached worker still running, `claude -p` not being on `PATH`, Claude authentication problems, a 120-second timeout, or the summary lock suppressing a duplicate worker.

### Automatic recall does nothing

Check `~/.deeplake/recall-events.jsonl` and embedding status. Current proactive recall requires embeddings. Explicit Bash grep is the expected lexical fallback for the user or model.

### `Read` or `Write` behaves strangely on the memory path

Use Bash `cat`, `grep`, `ls`, and redirection. `Read` relies on a materialized query-cache file, while `Write` and `Edit` are intentionally denied because the hook cannot change their tool type.

### A fork session unexpectedly updates something

Run:

```bash
node bundle/cli.js autoupdate off
```

Do not use `/hivemind:update`. Rebuild this checkout and relaunch with its `harnesses/claude-code` directory.

## Intended use

Hivemind is designed to make agent work persist beyond one context window and, with a shared backend, beyond one user or machine.

Its intended workflows are:

- resume a previous coding session from a concise summary;
- answer “what did we decide?” or “who worked on this?” from captured history;
- retain exact technical decisions, error codes, filenames, and next steps;
- track goals, parked tasks, and measurable KPIs;
- distribute repeatable Claude skills learned from prior sessions;
- inject stable team rules at session start;
- query a lightweight structural map of a codebase;
- optionally maintain searchable internal code documentation.

With one local SQLite file, it is personal persistent memory on one machine. It is not automatically shared between teammates or machines. Sharing requires a genuinely shared backend such as Deeplake or a reachable PostgreSQL instance, with the corresponding privacy and access-control decisions.

Hivemind should be treated as retained work telemetry, not merely a notes app. Because it captures tool inputs and outputs, its data sensitivity can approach the sensitivity of the entire coding session.

## Source map

The best starting points for auditing or changing behavior are:

| Concern | Source |
| --- | --- |
| Claude plugin manifest | [`harnesses/claude-code/.claude-plugin/plugin.json`](harnesses/claude-code/.claude-plugin/plugin.json) |
| Hook registration | [`harnesses/claude-code/hooks/hooks.json`](harnesses/claude-code/hooks/hooks.json) |
| Session context and startup | [`src/hooks/session-start.ts`](src/hooks/session-start.ts) |
| User-visible startup notices | [`src/hooks/session-notifications.ts`](src/hooks/session-notifications.ts) |
| Async startup setup | [`src/hooks/session-start-setup.ts`](src/hooks/session-start-setup.ts) |
| Event capture | [`src/hooks/capture.ts`](src/hooks/capture.ts) |
| Proactive recall | [`src/hooks/recall.ts`](src/hooks/recall.ts) |
| Tool interception | [`src/hooks/pre-tool-use.ts`](src/hooks/pre-tool-use.ts) |
| Virtual filesystem | [`src/shell/deeplake-fs.ts`](src/shell/deeplake-fs.ts) |
| Search engine | [`src/shell/grep-core.ts`](src/shell/grep-core.ts) |
| Session end | [`src/hooks/session-end.ts`](src/hooks/session-end.ts) |
| Summary worker | [`src/hooks/wiki-worker.ts`](src/hooks/wiki-worker.ts) |
| Storage configuration | [`src/config.ts`](src/config.ts) |
| Backend factory | [`src/storage/factory.ts`](src/storage/factory.ts) |
| SQLite backend | [`src/storage/sqlite.ts`](src/storage/sqlite.ts) |
| Provider-neutral schemas | [`src/deeplake-schema.ts`](src/deeplake-schema.ts) |
| Graph hook | [`src/hooks/graph-on-stop.ts`](src/hooks/graph-on-stop.ts) |
| Graph VFS | [`src/graph/vfs-handler.ts`](src/graph/vfs-handler.ts) |
| Skillify design | [`docs/SKILLIFY.md`](docs/SKILLIFY.md) |
| Claude memory skill | [`harnesses/claude-code/skills/hivemind-memory/SKILL.md`](harnesses/claude-code/skills/hivemind-memory/SKILL.md) |
| Claude goals skill | [`harnesses/claude-code/skills/hivemind-goals/SKILL.md`](harnesses/claude-code/skills/hivemind-goals/SKILL.md) |
| Claude graph skill | [`harnesses/claude-code/skills/hivemind-graph/SKILL.md`](harnesses/claude-code/skills/hivemind-graph/SKILL.md) |
| Optional MCP server | [`src/mcp/server.ts`](src/mcp/server.ts) |

## Bottom line

When Claude Code uses this plugin with SQLite, every participating hook process reads the same persisted backend selection, opens the same SQLite file, and writes or queries rows through a shared storage interface. Claude experiences those rows through injected context and a virtual `~/.deeplake/memory` tree implemented by tool interception.

The raw database is local. The virtual files are mostly synthesized. Capture is broad. Summary and skill generation can still send selected captured content through the Claude CLI. The fork should be launched through `--plugin-dir`, with upstream autoupdate disabled, and verified against the exact database path shown by `backend status`.
