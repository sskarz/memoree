import { defineConfig } from "vitest/config";

// Root vitest config. `npm test` runs `vitest run` from the repo root, so
// this is the file that actually gets picked up. The one in harnesses/claude-code/
// is a historical leftover and is not used by the root test script.
//
// Coverage thresholds are enforced per-file on the files touched by each
// PR. New files/PRs should add their paths to the `thresholds` block so
// the CI check grows over time instead of collapsing to a global average
// that hides regressions in new code.

export default defineConfig({
  // Match esbuild's `define` for __MEMOREE_VERSION__ so source files that
  // read it directly don't need a typeof guard for tests. Bundled builds
  // substitute the real version; tests get the "dev" sentinel.
  define: {
    __MEMOREE_VERSION__: JSON.stringify("dev"),
  },
  test: {
    include: [
      "tests/claude-code/**/*.test.ts",
      "tests/cli/**/*.test.ts",
      "tests/codex/**/*.test.ts",
      "tests/scripts/**/*.test.ts",
      // Non-agent-specific tests for shared `src/` modules (auth,
      // memoree-api, embeddings, grep, notifications, etc.). New
      // location since PR #183 — the older convention dumps everything
      // shared into tests/claude-code/, which misleadingly suggests
      // agent scope. New tests for src/* modules go here; a follow-up
      // issue tracks the migration of the existing ones.
      "tests/shared/**/*.test.ts",
    ],
    setupFiles: ["./tests/test-setup.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // `json` is needed by davelosert/vitest-coverage-report-action@v2 to
      // render per-file / per-line coverage in its PR comment (alongside the
      // aggregated json-summary). Without it the action emits a warning
      // about a missing coverage-final.json and falls back to the summary.
      reporter: ["text", "text-summary", "json", "json-summary", "html"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "src/**/*.js",
        "src/**/*.js.map",
        // CLI entry points — `main()` calls process.exit(), so source-level
        // unit tests don't make sense. These files have subprocess-spawn
        // coverage via tests/claude-code/shell-bundle-*.test.ts instead.
        "src/shell/memoree-shell.ts",
        // Skillify worker entry points: skillify-worker.ts parses cfg from
        // process.argv[2] at top level then runs main() which spawns
        // detached subprocesses; spawn-skillify-worker.ts is the spawner.
        // Both are excluded from vitest because they need a live Memoree
        // workspace + a real agent CLI to exercise meaningfully.
        // Coverage on the SHIPPED bundle is enforced indirectly by
        // tests/claude-code/skillify-bundle-scan.test.ts (asserts the
        // skillify-worker.js bundle exists per agent and contains the
        // required entry strings + agent labels). For full e2e in
        // development, see the manual matrix script described in the
        // PR description (lives at /tmp/skillify-e2e-matrix.mjs in the
        // author's worktree, not committed).
        "src/skillify/skillify-worker.ts",
        "src/skillify/spawn-skillify-worker.ts",
        "src/skillify/hygiene-worker.ts",
      ],
      // Per-file thresholds. Each PR that ships new files should append
      // its paths here with 80 / 80 / 80 / 80, so we prevent regressions
      // on the new code without having to first bring the whole
      // (~500-file) codebase up to 80%.
      thresholds: {
        "src/config.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/user-config.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/storage/backend.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/storage/factory.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/storage/postgres.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/storage/schema.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/storage/sqlite.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/storage/sql-dialect.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/storage/vector-search.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/commands/backend.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/commands/doctor.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/cli/install-claude.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/cli/stage-package.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/cli/run-install.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/hooks/shared/memory-command-contract.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/hooks/shared/shell-replacement.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/hooks/codex/compatibility-broker.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/hooks/codex/session-end.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/hooks/codex/transcript.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/embeddings/client.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/embeddings/nomic.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/embeddings/protocol.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/embeddings/sql.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/graph/hybrid-find.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/graph/node-embeddings.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/skillify/hygiene-parser.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/skillify/hygiene.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
        "src/skillify/spawn-hygiene-worker.ts": { statements: 80, branches: 80, functions: 80, lines: 80 },
      },
    },
  },
});
