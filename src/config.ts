import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { readUserConfig } from "./user-config.js";

export type StorageProvider = "sqlite" | "postgres";

export interface CommonStorageConfig {
  kind: StorageProvider;
  userName: string;
  workspaceId: string;
  orgId: string;
  orgName: string;
  tableName: string;
  sessionsTableName: string;
  skillsTableName: string;
  rulesTableName: string;
  goalsTableName: string;
  kpisTableName: string;
  docsTableName: string;
  codebaseTableName: string;
  memoryPath: string;
  vectorScanLimit: number;
}

export interface SqliteStorageConfig extends CommonStorageConfig {
  kind: "sqlite";
  path: string;
}

export interface PostgresStorageConfig extends CommonStorageConfig {
  kind: "postgres";
  connectionUrl: string;
  schema: string;
}

export type StorageConfig = SqliteStorageConfig | PostgresStorageConfig;

export interface Config extends CommonStorageConfig {
  storage: StorageConfig;
}

const PROVIDERS = new Set<StorageProvider>(["sqlite", "postgres"]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function providerFrom(raw: unknown): StorageProvider {
  const value = typeof raw === "string" ? raw.toLowerCase() : "";
  if (!value) return "sqlite";
  if (!PROVIDERS.has(value as StorageProvider)) {
    throw new Error(`Invalid MEMOREE_BACKEND: ${String(raw)}`);
  }
  return value as StorageProvider;
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function commonStorage(home: string): Omit<CommonStorageConfig, "kind"> {
  const persisted = readUserConfig();
  return {
    userName: process.env.MEMOREE_USER_NAME ?? persisted.userName ?? userInfo().username ?? "local",
    workspaceId: process.env.MEMOREE_REPOSITORY_KEY ?? "default",
    orgId: "local",
    orgName: "local",
    tableName: process.env.MEMOREE_TABLE ?? "memory",
    sessionsTableName: process.env.MEMOREE_SESSIONS_TABLE ?? "sessions",
    skillsTableName: process.env.MEMOREE_SKILLS_TABLE ?? "skills",
    rulesTableName: process.env.MEMOREE_RULES_TABLE ?? "memoree_rules",
    goalsTableName: process.env.MEMOREE_GOALS_TABLE ?? "memoree_goals",
    kpisTableName: process.env.MEMOREE_KPIS_TABLE ?? "memoree_kpis",
    docsTableName: process.env.MEMOREE_DOCS_TABLE ?? "memoree_docs",
    codebaseTableName: process.env.MEMOREE_CODEBASE_TABLE ?? "codebase",
    memoryPath: process.env.MEMOREE_MEMORY_PATH ?? join(home, ".memoree", "memory"),
    vectorScanLimit: positiveInteger(process.env.MEMOREE_VECTOR_SCAN_LIMIT, 2000),
  };
}

export function loadStorageConfig(): StorageConfig | null {
  const home = homedir();
  const persisted = readUserConfig().storage;
  const provider = providerFrom(process.env.MEMOREE_BACKEND ?? persisted?.provider);
  const common = commonStorage(home);

  if (provider === "sqlite") {
    const path = process.env.MEMOREE_SQLITE_PATH ?? persisted?.sqlitePath ?? join(home, ".memoree", "memoree.sqlite3");
    return { ...common, kind: "sqlite", path: resolve(path) };
  }

  const connectionUrl = process.env.MEMOREE_POSTGRES_URL;
  if (!connectionUrl) return null;
  const schema = process.env.MEMOREE_POSTGRES_SCHEMA ?? persisted?.postgresSchema ?? "memoree";
  if (!IDENTIFIER.test(schema)) throw new Error(`Invalid PostgreSQL schema: ${schema}`);
  return { ...common, kind: "postgres", connectionUrl, schema };
}

export function configFromStorage(storage: StorageConfig): Config {
  return { ...storage, storage };
}

export function storageFromConfig(config: Config): StorageConfig {
  return config.storage;
}

export function loadConfig(): Config | null {
  const storage = loadStorageConfig();
  return storage ? configFromStorage(storage) : null;
}
