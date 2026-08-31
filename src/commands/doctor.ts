import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadStorageConfig } from "../config.js";
import { createStorageBackend } from "../storage/factory.js";
import { getEmbeddingsEnabled } from "../user-config.js";
import { isSharedDepsInstalled, SHARED_DAEMON_PATH } from "../cli/embeddings.js";
import { pkgRoot } from "../cli/util.js";

interface DoctorDependencies {
  loadStorageConfig: typeof loadStorageConfig;
  createStorageBackend: typeof createStorageBackend;
  getEmbeddingsEnabled: typeof getEmbeddingsEnabled;
  isSharedDepsInstalled: typeof isSharedDepsInstalled;
  existsSync: typeof existsSync;
  execFileSync: typeof execFileSync;
  homedir: typeof homedir;
  pkgRoot: typeof pkgRoot;
  log: (message: string) => void;
}

export async function runDoctor(overrides: Partial<DoctorDependencies> = {}): Promise<number> {
  const deps: DoctorDependencies = {
    loadStorageConfig,
    createStorageBackend,
    getEmbeddingsEnabled,
    isSharedDepsInstalled,
    existsSync,
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
  const bundle = join(deps.pkgRoot(), "harnesses", "claude-code", "bundle");
  const hooksOk = ["session-start.js", "capture.js", "recall.js", "session-end.js"].every(file => deps.existsSync(join(bundle, file)));
  results.push(["hook bundles", hooksOk, bundle]);

  const codexBundle = join(deps.homedir(), ".codex", "memoree", "bundle");
  if (deps.existsSync(codexBundle)) {
    try { deps.execFileSync("codex", ["--version"], { stdio: "ignore" }); results.push(["Codex", true, "available"]); }
    catch { results.push(["Codex", false, "codex executable not found"]); }
    const codexHooksOk = ["session-start.js", "capture.js", "pre-tool-use.js", "stop.js", "graph-on-stop.js"]
      .every(file => deps.existsSync(join(codexBundle, file)));
    results.push(["Codex hook bundles", codexHooksOk, codexBundle]);
  }

  for (const [name, ok, detail] of results) deps.log(`${ok ? "ok" : "FAIL"}  ${name}: ${detail}`);
  return results.every(([, ok]) => ok) ? 0 : 1;
}
