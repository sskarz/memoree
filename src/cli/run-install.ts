import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadStorageConfig } from "../config.js";
import { createStorageBackend } from "../storage/factory.js";
import { writeUserConfig } from "../user-config.js";
import { docsHintShown, docsInstallLines, markDocsHintShown } from "../docs/install-hint.js";
import { installClaude, claudeCliAvailable } from "./install-claude.js";
import { installCodex } from "./install-codex.js";
import { installEmbeddings, preloadEmbeddingModel } from "./embeddings.js";
import { detectPlatforms, log, warn, type PlatformId } from "./util.js";
import {
  codexBundleExists,
  packageRootForInstall,
  stagePackage,
} from "./stage-package.js";

export interface InstallRuntime {
  stagePackage: typeof stagePackage;
  packageRootForInstall: typeof packageRootForInstall;
  detectPlatforms: typeof detectPlatforms;
  claudeCliAvailable: typeof claudeCliAvailable;
  codexBundleExists: typeof codexBundleExists;
  installClaude: typeof installClaude;
  installCodex: typeof installCodex;
  initializeStorage: typeof initializeStorage;
  installEmbeddings: typeof installEmbeddings;
  preloadEmbeddingModel: typeof preloadEmbeddingModel;
  writeUserConfig: typeof writeUserConfig;
  docsHintShown: typeof docsHintShown;
  docsInstallLines: typeof docsInstallLines;
  markDocsHintShown: typeof markDocsHintShown;
  log: typeof log;
  warn: typeof warn;
}

export interface RunInstallResult {
  stagedRoot: string;
  wired: PlatformId[];
  location: string;
  embeddingsEnabled: boolean;
}

function resolveRuntime(overrides: Partial<InstallRuntime> = {}): InstallRuntime {
  return {
    stagePackage,
    packageRootForInstall,
    detectPlatforms,
    claudeCliAvailable,
    codexBundleExists,
    installClaude,
    installCodex,
    initializeStorage,
    installEmbeddings,
    preloadEmbeddingModel,
    writeUserConfig,
    docsHintShown,
    docsInstallLines,
    markDocsHintShown,
    log,
    warn,
    ...overrides,
  };
}

export async function initializeStorage(): Promise<string> {
  const config = loadStorageConfig();
  if (!config) throw new Error("MEMOREE_POSTGRES_URL is required when PostgreSQL is selected");
  if (config.kind === "sqlite") mkdirSync(dirname(config.path), { recursive: true, mode: 0o700 });
  const backend = createStorageBackend(config);
  try { await backend.initializeSchema(); }
  finally { await backend.close(); }
  writeUserConfig({
    storage: config.kind === "sqlite"
      ? { provider: "sqlite", sqlitePath: config.path }
      : { provider: "postgres", postgresSchema: config.schema },
    userName: config.userName,
    capture: { enabled: true },
  });
  return config.kind === "sqlite" ? config.path : `PostgreSQL schema ${config.schema}`;
}

function wireClaude(stagedRoot: string, runtime: InstallRuntime): boolean {
  if (!runtime.claudeCliAvailable()) {
    runtime.warn("  Claude Code    skipped: claude CLI not found on PATH");
    return false;
  }
  runtime.installClaude({ source: stagedRoot });
  return true;
}

function wireCodex(stagedRoot: string, runtime: InstallRuntime): boolean {
  if (!runtime.codexBundleExists(stagedRoot)) {
    runtime.warn(`  Codex          skipped: bundle missing at ${stagedRoot}/harnesses/codex/bundle`);
    return false;
  }
  runtime.installCodex({ packageRoot: stagedRoot });
  return true;
}

function nextStepLines(wired: PlatformId[]): string[] {
  const lines: string[] = [];
  if (wired.includes("claude")) {
    lines.push("Restart Claude Code to activate Memoree.");
  }
  if (wired.includes("codex")) {
    lines.push("Restart Codex, then open /hooks and trust Memoree so its hooks can run.");
  }
  lines.push("Then run `npx memoree doctor`.");
  return lines;
}

/**
 * Default `memoree install`: stage a durable copy, init SQLite, then wire
 * every detected harness. `--all` is accepted as an alias for that default.
 * A missing CLI is skipped with a warning; zero wired harnesses is an error.
 */
export async function runInstall(
  args: string[],
  overrides: Partial<InstallRuntime> = {},
): Promise<RunInstallResult> {
  const runtime = resolveRuntime(overrides);
  const stagedRoot = runtime.stagePackage({ sourceRoot: runtime.packageRootForInstall() });
  const location = await runtime.initializeStorage();
  const noEmbeddings = args.includes("--no-embeddings");
  runtime.writeUserConfig({ embeddings: { enabled: !noEmbeddings } });
  if (!noEmbeddings) {
    runtime.installEmbeddings({ quietNoInstalls: true });
    try { await runtime.preloadEmbeddingModel(); }
    catch (error) {
      throw new Error(
        `Embedding initialization failed: ${(error as Error).message}. Retry with \`memoree embeddings install\` or use --no-embeddings.`,
      );
    }
  }

  const detected = runtime.detectPlatforms().map(platform => platform.id);
  if (detected.length === 0) {
    throw new Error(
      "No Claude Code or Codex installation found. Install one of them, then rerun `npx memoree install`.",
    );
  }

  const wired: PlatformId[] = [];
  for (const target of detected) {
    const ok = target === "claude" ? wireClaude(stagedRoot, runtime) : wireCodex(stagedRoot, runtime);
    if (ok) wired.push(target);
  }
  if (wired.length === 0) {
    throw new Error(
      "Failed to wire any harness. Install the Claude Code CLI (`claude`) or Codex, then rerun `npx memoree install`.",
    );
  }

  runtime.log("");
  runtime.log(`Staged plugin: ${stagedRoot}`);
  runtime.log(`Database: ${location}`);
  runtime.log(`Embeddings: ${noEmbeddings ? "disabled (lexical retrieval only)" : "enabled"}`);
  runtime.log(`Harnesses: ${wired.join(", ")}`);
  if (!runtime.docsHintShown()) {
    for (const line of runtime.docsInstallLines()) runtime.log(line);
    runtime.markDocsHintShown();
  }
  for (const line of nextStepLines(wired)) runtime.log(line);
  return { stagedRoot, wired, location, embeddingsEnabled: !noEmbeddings };
}

/** `memoree claude|codex install` — stage first so npx cache eviction cannot break hooks. */
export function installPlatform(id: PlatformId, overrides: Partial<InstallRuntime> = {}): void {
  const runtime = resolveRuntime(overrides);
  const stagedRoot = runtime.stagePackage({ sourceRoot: runtime.packageRootForInstall() });
  if (id === "claude") runtime.installClaude({ source: stagedRoot });
  else runtime.installCodex({ packageRoot: stagedRoot });
}
