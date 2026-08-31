# Memoree Bugbot rules

Memoree is a local-first memory layer for Claude Code and Codex. Production state lives under `~/.memoree`. Automated tests must use isolated temporary homes, config paths, and SQLite databases.

## Always flag

- Code or tests that write to the real operator `~/.memoree` database
- `npm link` or marketplace install from the development checkout
- `runtime:promote` from GitHub Actions, or on a machine that already hosts daily Claude Code / Codex sessions
- Using `claude --bare` or `codex --ephemeral` as the unaided-hook proof (`live:e2e` must not)
- Treating `runtime:validate` and `live:e2e` as interchangeable
- Missing Vitest coverage for new `src/` files (see `vitest.config.ts` thresholds)
- PostgreSQL URLs or other secrets serialized into config, worker handoffs, or git
- Hook changes that skip PreToolUse sandboxing of `~/.memoree/memory` (`cat` / `ls` / `grep` / `head` / `tail` / `wc` / `find` / `jq` / `echo` / `printf` / `tee`, plus lifecycle `mv` / `rm` for a single rule or goal file)

## Do not flag

- Isolated test homes (`MEMOREE_SQLITE_PATH`, `MEMOREE_CONFIG_PATH`, `MEMOREE_MEMORY_PATH`, throwaway `HOME`)
- Documentation-only edits that do not change `src/`, `harnesses/`, or runtime scripts
- Style that already matches nearby files

## Review context

- Agent rules: `AGENTS.md`
- Test gates: `docs/TESTING.md`
- Product map: `README.md` (What Memoree does)
