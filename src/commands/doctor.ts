import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadStorageConfig } from "../config.js";
import { createStorageBackend } from "../storage/factory.js";
import { getEmbeddingsEnabled } from "../user-config.js";
import { isSharedDepsInstalled, SHARED_DAEMON_PATH } from "../cli/embeddings.js";
import { pkgRoot } from "../cli/util.js";

const CLAUDE_HOOK_FILES = ["session-start.js", "capture.js", "recall.js", "session-end.js"];
const VERSION_RE = /(\d+\.\d+\.\d+)/;

interface DoctorDependencies {
  loadStorageConfig: typeof loadStorageConfig;
  createStorageBackend: typeof createStorageBackend;
  getEmbeddingsEnabled: typeof getEmbeddingsEnabled;
  isSharedDepsInstalled: typeof isSharedDepsInstalled;
  existsSync: typeof existsSync;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  execFileSync: typeof execFileSync;
  homedir: typeof homedir;
  pkgRoot: typeof pkgRoot;
  log: (message: string) => void;
}

type DirReader = (path: string) => string[];
type FileReader = (path: string, encoding: BufferEncoding) => string;
type ExistsFn = (path: string) => boolean;

/** Newest non-orphaned Claude marketplace cache bundle, or null. */
export function findInstalledClaudeHookBundle(
  home: string,
  exists: ExistsFn = existsSync,
  readDir: DirReader = path => readdirSync(path) as string[],
): string | null {
  const cache = join(home, ".claude", "plugins", "cache", "memoree", "memoree");
  if (!exists(cache)) return null;
  let versions: string[] = [];
  try { versions = readDir(cache); } catch { return null; }
  const sorted = [...versions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (let i = sorted.length - 1; i >= 0; i--) {
    const dir = join(cache, sorted[i]!);
    if (exists(join(dir, ".orphaned_at"))) continue;
    const candidates = [join(dir, "bundle"), join(dir, "harnesses", "claude-code", "bundle")];
    const found = candidates.find(path => exists(path));
    if (found) return found;
  }
  return null;
}

export function parseSemver(raw: string): string | null {
  const match = raw.trim().match(VERSION_RE);
  return match ? match[1]! : null;
}

function readStamp(dir: string, exists: ExistsFn, readFile: FileReader): string | null {
  const path = join(dir, ".memoree_version");
  if (!exists(path)) return null;
  try {
    const stamp = readFile(path, "utf-8").trim();
    return stamp && stamp !== "0.0.0" ? stamp : null;
  } catch {
    return null;
  }
}

function hookFilesPresent(bundle: string, files: string[], exists: ExistsFn): boolean {
  return files.every(file => exists(join(bundle, file)));
}

export async function runDoctor(overrides: Partial<DoctorDependencies> = {}): Promise<number> {
  const deps: DoctorDependencies = {
    loadStorageConfig,
    createStorageBackend,
    getEmbeddingsEnabled,
    isSharedDepsInstalled,
    existsSync,
    readdirSync,
    readFileSync,
    execFileSync,
    homedir,
    pkgRoot,
    log: console.log,
    ...overrides,
  };
  const results: Array<[string, boolean, string]> = [];
  const config = deps.loadStorageConfig();
  if (!config) results.push(["database", false, "MEMOREE_POSTGRES_URL is missing"]);
  else {
    const backend = deps.createStorageBackend(config);
    try {
      await backend.initializeSchema();
      const tables = await backend.listTables(true);
      let databaseOk = true;
      let databaseDetail = config.kind === "sqlite" ? config.path : `PostgreSQL schema ${config.schema}`;
      if (config.kind === "sqlite") {
        const integrity = await backend.query("PRAGMA integrity_check");
        databaseOk = String(integrity[0]?.["integrity_check"] ?? "").toLowerCase() === "ok";
        if (!databaseOk) databaseDetail = `${config.path} failed integrity_check`;
      }
      const requiredTables = [
        config.tableName,
        config.sessionsTableName,
        config.skillsTableName,
        config.rulesTableName,
        config.goalsTableName,
        config.kpisTableName,
        config.docsTableName,
        config.codebaseTableName,
      ];
      const missingTables = requiredTables.filter(table => !tables.includes(table));
      results.push(["database", databaseOk, databaseDetail]);
      results.push(["schema", missingTables.length === 0, missingTables.length === 0
        ? `${requiredTables.length} required tables`
        : `missing ${missingTables.join(", ")}`]);
    } catch (error) { results.push(["database", false, (error as Error).message]); }
    finally { await backend.close(); }
  }

  const embeddings = deps.getEmbeddingsEnabled();
  const embeddingRuntimeOk = deps.isSharedDepsInstalled() && deps.existsSync(SHARED_DAEMON_PATH);
  const modelCache = join(deps.homedir(), ".memoree", "models");
  const embeddingModelOk = deps.existsSync(modelCache);
  results.push(["embeddings", !embeddings || (embeddingRuntimeOk && embeddingModelOk), embeddings
    ? `enabled; model cache ${modelCache}`
    : "lexical only"]);
  try { deps.execFileSync("claude", ["--version"], { stdio: "ignore" }); results.push(["Claude Code", true, "available"]); }
  catch { results.push(["Claude Code", false, "claude executable not found"]); }
  try {
    const plugins = deps.execFileSync("claude", ["plugin", "list"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    results.push(["plugin", plugins.includes("memoree@memoree"), "user scope"]);
  } catch { results.push(["plugin", false, "unable to inspect Claude plugins"]); }

  const home = deps.homedir();
  const installedClaude = findInstalledClaudeHookBundle(home, deps.existsSync, path => {
    const entries = deps.readdirSync(path, { encoding: "utf8" });
    return Array.isArray(entries) ? entries.map(String) : [];
  });
  const checkoutClaude = join(deps.pkgRoot(), "harnesses", "claude-code", "bundle");
  // Prefer the installed Claude cache. Checkout-relative harnesses are a
  // source/npm extra — missing them inside a Codex/Antigravity plugin bundle
  // is not a FAIL when the cache (or no Claude install) is the real layout.
  if (installedClaude) {
    const hooksOk = hookFilesPresent(installedClaude, CLAUDE_HOOK_FILES, deps.existsSync);
    results.push(["hook bundles", hooksOk, installedClaude]);
  } else if (deps.existsSync(checkoutClaude)) {
    const hooksOk = hookFilesPresent(checkoutClaude, CLAUDE_HOOK_FILES, deps.existsSync);
    results.push(["hook bundles", hooksOk, checkoutClaude]);
  } else {
    results.push(["hook bundles", true, "Claude plugin cache not installed"]);
  }

  const codexBundle = join(home, ".codex", "memoree", "bundle");
  if (deps.existsSync(codexBundle)) {
    try { deps.execFileSync("codex", ["--version"], { stdio: "ignore" }); results.push(["Codex", true, "available"]); }
    catch { results.push(["Codex", false, "codex executable not found"]); }
    const codexHooksOk = ["session-start.js", "capture.js", "pre-tool-use.js", "stop.js", "graph-on-stop.js"]
      .every(file => deps.existsSync(join(codexBundle, file)));
    results.push(["Codex hook bundles", codexHooksOk, codexBundle]);
  }

  const agyBundleCandidates = [
    join(home, ".gemini", "config", "plugins", "memoree", "bundle"),
    join(home, ".gemini", "antigravity-cli", "plugins", "memoree", "bundle"),
  ];
  const agyBundle = agyBundleCandidates.find(path => deps.existsSync(path));
  if (agyBundle) {
    try { deps.execFileSync("agy", ["--version"], { stdio: "ignore" }); results.push(["Antigravity", true, "available"]); }
    catch { results.push(["Antigravity", false, "agy executable not found"]); }
    const agyHooksOk = ["pre-invocation.js", "capture.js", "stop.js", "mcp-server.js", "session-summary-worker.js", "graph-on-stop.js"]
      .every(file => deps.existsSync(join(agyBundle, file)));
    results.push(["Antigravity hook bundles", agyHooksOk, agyBundle]);
  }

  const hookStamps = [
    readStamp(join(home, ".codex", "memoree"), deps.existsSync, (path, encoding) => String(deps.readFileSync(path, encoding))),
    installedClaude ? readStamp(join(installedClaude, ".."), deps.existsSync, (path, encoding) => String(deps.readFileSync(path, encoding))) : null,
    readStamp(join(home, ".gemini", "config", "plugins", "memoree"), deps.existsSync, (path, encoding) => String(deps.readFileSync(path, encoding))),
    readStamp(join(home, ".gemini", "antigravity-cli", "plugins", "memoree"), deps.existsSync, (path, encoding) => String(deps.readFileSync(path, encoding))),
  ].filter((stamp): stamp is string => Boolean(stamp));
  let pathCliVersion: string | null = null;
  try {
    const raw = deps.execFileSync("memoree", ["--version"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    pathCliVersion = parseSemver(String(raw));
  } catch { /* PATH CLI missing or not a memoree bin */ }
  if (pathCliVersion && hookStamps.some(stamp => stamp !== pathCliVersion)) {
    const stamp = hookStamps.find(s => s !== pathCliVersion) ?? hookStamps[0];
    deps.log(
      `warn  CLI version: PATH memoree ${pathCliVersion} ≠ hook stamp ${stamp} — leftover npm -g is not updated; run npx -y @sskarz/memoree install`,
    );
  }

  for (const [name, ok, detail] of results) deps.log(`${ok ? "ok" : "FAIL"}  ${name}: ${detail}`);
  return results.every(([, ok]) => ok) ? 0 : 1;
}
