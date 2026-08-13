# Repository Guidelines

## Isolated Development and Runtime

Use this development checkout only for editing, source tests, and commits.
Never run `npm link`, register a marketplace, or install global hooks from the
development checkout. Claude Code and Codex load Memoree globally, so those
actions can replace the code used by active sessions.

Use `npm run verify` for routine validation. Runtime promotion requires an
immutable committed revision, explicit user authorization, and all Claude Code
and Codex sessions closed. Use only `npm run runtime:init`,
`runtime:promote`, `runtime:validate`, and `runtime:rollback` to manage the
detached checkout at `~/.local/share/memoree-runtime`; never terminate sessions
to force a promotion.

Production state belongs under `~/.memoree`. Automated tests and validation
must use isolated temporary homes, config paths, and SQLite databases. Never
write synthetic records to the real database. Claude Code and Codex are the
only supported harnesses. The frozen pi snapshot under `experimental/pi/` is
excluded from builds, tests, CLI discovery, and support.

## Project Structure

Core TypeScript lives in `src/`. CLI code is under `src/cli/` and
`src/commands/`; shared hooks are in `src/hooks/shared/`, with Codex-specific
hooks in `src/hooks/codex/`. Runtime packaging lives in `harnesses/`, docs in
`docs/`, utilities in `scripts/`, and QA records in `library/`.

Tests are grouped under `tests/claude-code/`, `tests/codex/`, `tests/cli/`, and
`tests/shared/`. Put new agent-independent coverage in `tests/shared/`. Build
outputs (`dist/`, `bundle/`, harness bundles, `mcp/bundle/`, and `embeddings/`)
are generated and must not be edited by hand.

## Commands

- `npm ci` installs dependencies; Node.js 22.13 or newer is required.
- `npm run verify` runs strict type checking and source-level Vitest without rebuilding bundles.
- `npm run build` type-checks and builds the CLI and supported runtime bundles.
- `npm test` runs the full source and built-artifact suite.
- `npx vitest run tests/shared/atomic-write.test.ts` targets one test file.
- `git diff --check` catches whitespace errors before commit.

## Code and Tests

Use strict TypeScript, ES modules, two-space indentation, double quotes, and
semicolons. Include `.js` extensions in relative imports for compiled Node ESM.
Use camelCase for values, PascalCase for types, and kebab-case filenames. Match
nearby code; there is no standalone formatter.

Use Vitest with `*.test.ts` names. Cover success, failure, idempotency,
configuration preservation, and platform-specific branches. Inject filesystem,
timing, process, and environment seams instead of using live services or real
home directories. Add new source files to the per-file coverage thresholds in
`vitest.config.ts`, normally at 80%.

## Commits and Pull Requests

Use focused Conventional Commits such as `fix(runtime): ...`, `feat(graph): ...`,
`test(summary): ...`, or `docs: ...`. PRs need a clear summary and test plan,
relevant tests, and confirmation of `npm run verify`; include `npm run build`
and `npm test` when runtime artifacts change. Do not bump the package version
unless a release is explicitly intended.
