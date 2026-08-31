import { build } from "esbuild";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const esmPackageJson = '{"type":"module"}\n';
const memoreeVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const treeSitterExternals = [
  "tree-sitter",
  "tree-sitter-typescript",
  "tree-sitter-javascript",
  "tree-sitter-python",
  "tree-sitter-go",
  "tree-sitter-rust",
  "tree-sitter-java",
  "tree-sitter-ruby",
  "tree-sitter-c",
  "tree-sitter-cpp",
];
const runtimeExternals = [
  "node:*",
  "node-liblzma",
  "@mongodb-js/zstd",
  "@huggingface/transformers",
  "onnxruntime-node",
  "onnxruntime-common",
  "sharp",
  ...treeSitterExternals,
];

for (const dir of [
  "bundle",
  "harnesses/claude-code/bundle",
  "harnesses/codex/bundle",
  "harnesses/antigravity/bundle",
]) rmSync(dir, { recursive: true, force: true });

async function buildEntries(entries, outdir) {
  await build({
    entryPoints: Object.fromEntries(entries.map(entry => [entry.out, entry.entry])),
    bundle: true,
    platform: "node",
    format: "esm",
    outdir,
    external: runtimeExternals,
    define: { __MEMOREE_VERSION__: JSON.stringify(memoreeVersion) },
  });
  for (const entry of entries) chmodSync(`${outdir}/${entry.out}.js`, 0o755);
  writeFileSync(`${outdir}/package.json`, esmPackageJson);
}

async function buildGraphOnStop(outdir) {
  await build({
    entryPoints: { "graph-on-stop": "dist/src/hooks/graph-on-stop.js" },
    bundle: true,
    platform: "node",
    format: "esm",
    outdir,
    splitting: true,
    chunkNames: "graph-chunks/[name]-[hash]",
    external: runtimeExternals,
    define: { __MEMOREE_VERSION__: JSON.stringify(memoreeVersion) },
  });
  chmodSync(`${outdir}/graph-on-stop.js`, 0o755);
}

const claudeEntries = [
  ["src/hooks/session-start", "session-start"],
  ["src/hooks/session-start-setup", "session-start-setup"],
  ["src/hooks/capture", "capture"],
  ["src/hooks/recall", "recall"],
  ["src/hooks/pre-tool-use", "pre-tool-use"],
  ["src/hooks/session-end", "session-end"],
  ["src/hooks/plugin-cache-gc", "plugin-cache-gc"],
  ["src/hooks/wiki-worker", "wiki-worker"],
  ["src/hooks/graph-pull-worker", "graph-pull-worker"],
  ["src/hooks/graph-deps-worker", "graph-deps-worker"],
  ["src/skillify/skillify-worker", "skillify-worker"],
  ["src/skillify/hygiene-worker", "hygiene-worker"],
  ["src/skillify/skillopt-worker", "skillopt-worker"],
  ["src/shell/memoree-shell", "shell/memoree-shell"],
  ["src/embeddings/daemon", "embeddings/embed-daemon"],
].map(([entry, out]) => ({ entry: `dist/${entry}.js`, out }));

const codexEntries = [
  ["src/hooks/codex/session-start", "session-start"],
  ["src/hooks/codex/session-start-setup", "session-start-setup"],
  ["src/hooks/codex/capture", "capture"],
  ["src/hooks/codex/pre-tool-use", "pre-tool-use"],
  ["src/hooks/codex/stop", "stop"],
  ["src/hooks/codex/wiki-worker", "wiki-worker"],
  ["src/cli/index", "command/memoree"],
  ["src/hooks/graph-pull-worker", "graph-pull-worker"],
  ["src/hooks/graph-deps-worker", "graph-deps-worker"],
  ["src/skillify/skillify-worker", "skillify-worker"],
  ["src/skillify/hygiene-worker", "hygiene-worker"],
  ["src/skillify/skillopt-worker", "skillopt-worker"],
  ["src/shell/memoree-shell", "shell/memoree-shell"],
  ["src/embeddings/daemon", "embeddings/embed-daemon"],
].map(([entry, out]) => ({ entry: `dist/${entry}.js`, out }));

const antigravityEntries = [
  ["src/hooks/antigravity/pre-invocation", "pre-invocation"],
  ["src/hooks/antigravity/session-start-setup", "session-start-setup"],
  ["src/hooks/antigravity/capture", "capture"],
  ["src/hooks/antigravity/pre-tool-use", "pre-tool-use"],
  ["src/hooks/antigravity/stop", "stop"],
  ["src/hooks/antigravity/wiki-worker", "wiki-worker"],
  ["src/mcp/server", "mcp-server"],
  ["src/cli/index", "command/memoree"],
  ["src/hooks/graph-pull-worker", "graph-pull-worker"],
  ["src/hooks/graph-deps-worker", "graph-deps-worker"],
  ["src/skillify/skillify-worker", "skillify-worker"],
  ["src/skillify/hygiene-worker", "hygiene-worker"],
  ["src/skillify/skillopt-worker", "skillopt-worker"],
  ["src/shell/memoree-shell", "shell/memoree-shell"],
  ["src/embeddings/daemon", "embeddings/embed-daemon"],
].map(([entry, out]) => ({ entry: `dist/${entry}.js`, out }));

await buildEntries(claudeEntries, "harnesses/claude-code/bundle");
await buildEntries(codexEntries, "harnesses/codex/bundle");
await buildEntries(antigravityEntries, "harnesses/antigravity/bundle");
await buildGraphOnStop("harnesses/claude-code/bundle");
await buildGraphOnStop("harnesses/codex/bundle");
await buildGraphOnStop("harnesses/antigravity/bundle");

await build({
  entryPoints: { cli: "dist/src/cli/index.js" },
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  outdir: "bundle",
  external: runtimeExternals,
  define: { __MEMOREE_VERSION__: JSON.stringify(memoreeVersion) },
});
const cliPath = "bundle/cli.js";
const cliSource = readFileSync(cliPath, "utf8");
if (!cliSource.startsWith("#!")) writeFileSync(cliPath, `#!/usr/bin/env node\n${cliSource}`);
chmodSync(cliPath, 0o755);

await build({
  entryPoints: { "embed-daemon": "dist/src/embeddings/daemon.js" },
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "embeddings",
  external: runtimeExternals,
  define: { __MEMOREE_VERSION__: JSON.stringify(memoreeVersion) },
});
chmodSync("embeddings/embed-daemon.js", 0o755);

console.error(`Built: ${claudeEntries.length} Claude Code + ${codexEntries.length} Codex + ${antigravityEntries.length} Antigravity + 1 CLI + 1 embedding daemon`);
