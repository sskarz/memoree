import { defineConfig } from "vitest/config";

/** Routine source gate. Artifact-level tests run after `npm run build`. */
export default defineConfig({
  define: { __MEMOREE_VERSION__: JSON.stringify("dev") },
  test: {
    include: [
      "tests/claude-code/**/*.test.ts",
      "tests/cli/**/*.test.ts",
      "tests/codex/**/*.test.ts",
      "tests/scripts/**/*.test.ts",
      "tests/shared/**/*.test.ts",
    ],
    exclude: [
      "tests/claude-code/embeddings-bundle-scan.test.ts",
      "tests/claude-code/plugin-cache-gc-bundle.integration.test.ts",
      "tests/claude-code/plugin-cache-gc.test.ts",
      "tests/claude-code/plugin-cache.test.ts",
      "tests/claude-code/plugin-version-resolution.test.ts",
      "tests/claude-code/session-insert-sql.test.ts",
      "tests/claude-code/skillify-bundle-scan.test.ts",
      "tests/claude-code/spawn-backfill-memory-worker-wiring.test.ts",
      "tests/claude-code/spawn-mine-local-worker.test.ts",
      "tests/claude-code/version-define-bundles.test.ts",
      "tests/claude-code/wiki-worker-upload-sql.test.ts",
      "tests/cli/cli-bundle-runtime.test.ts",
      "tests/cli/cli-install-codex-fs.test.ts",
      "tests/cli/cli-install-mcp-shared.test.ts",
      "tests/shared/embeddings-schema.test.ts",
      "tests/shared/graph/graph-on-stop-bundle.test.ts",
    ],
    setupFiles: ["./tests/test-setup.ts"],
    environment: "node",
  },
});
