import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadStorageConfig, type StorageProvider } from "../config.js";
import { createStorageBackend } from "../storage/factory.js";
import { readUserConfig, writeUserConfig } from "../user-config.js";

const PROVIDERS = new Set<StorageProvider>(["sqlite", "postgres"]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function option(args: string[], name: string): string | undefined {
  const index = args.findIndex(arg => arg === name || arg.startsWith(`${name}=`));
  if (index < 0) return undefined;
  return args[index].includes("=") ? args[index].split("=", 2)[1] : args[index + 1];
}

export function selectedBackend(): StorageProvider {
  const raw = process.env.MEMOREE_BACKEND ?? readUserConfig().storage?.provider ?? "sqlite";
  if (!PROVIDERS.has(raw as StorageProvider)) throw new Error(`Invalid MEMOREE_BACKEND: ${raw}`);
  return raw as StorageProvider;
}

function displayPath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function renderBackendStatus(): string {
  const persisted = readUserConfig().storage;
  const provider = selectedBackend();
  const lines = [`Backend: ${provider}`];
  if (provider === "sqlite") {
    const path = resolve(process.env.MEMOREE_SQLITE_PATH ?? persisted?.sqlitePath ?? join(homedir(), ".memoree", "memoree.sqlite3"));
    lines.push(`Database: ${displayPath(path)}`);
  } else {
    lines.push(`Schema: ${process.env.MEMOREE_POSTGRES_SCHEMA ?? persisted?.postgresSchema ?? "memoree"}`);
    lines.push(`Connection: ${process.env.MEMOREE_POSTGRES_URL ? "configured via environment" : "not configured"}`);
  }
  return lines.join("\n");
}

async function checkSelected(): Promise<void> {
  const config = loadStorageConfig();
  if (!config) throw new Error("PostgreSQL backend requires MEMOREE_POSTGRES_URL");
  const backend = createStorageBackend(config);
  try {
    await backend.initializeSchema();
    await backend.query("SELECT 1 AS ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(config.kind === "postgres" ? message.split(config.connectionUrl).join("[redacted PostgreSQL URL]") : message);
  } finally { await backend.close(); }
}

export async function runBackendCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? "status";
  if (sub === "status") { console.log(renderBackendStatus()); return 0; }
  if (sub === "check") { await checkSelected(); console.log(`${selectedBackend()} backend: ok`); return 0; }
  if (sub !== "use") throw new Error("Usage: memoree backend status | use <sqlite|postgres> | check");
  const provider = args[1] as StorageProvider | undefined;
  if (!provider || !PROVIDERS.has(provider)) throw new Error("Usage: memoree backend use sqlite [--path <file>] | postgres [--schema <name>]");

  if (provider === "sqlite") {
    const path = resolve(option(args.slice(2), "--path") ?? join(homedir(), ".memoree", "memoree.sqlite3"));
    writeUserConfig({ storage: { provider, sqlitePath: path } });
    process.env.MEMOREE_BACKEND = "sqlite";
    process.env.MEMOREE_SQLITE_PATH = path;
    await checkSelected();
    console.log(`Backend set to sqlite (${displayPath(path)}).`);
    return 0;
  }

  const schema = option(args.slice(2), "--schema") ?? "memoree";
  if (!IDENTIFIER.test(schema)) throw new Error(`Invalid PostgreSQL schema: ${schema}`);
  if (!process.env.MEMOREE_POSTGRES_URL) throw new Error("PostgreSQL backend requires MEMOREE_POSTGRES_URL; the URL is never persisted");
  writeUserConfig({ storage: { provider, postgresSchema: schema } });
  process.env.MEMOREE_BACKEND = "postgres";
  process.env.MEMOREE_POSTGRES_SCHEMA = schema;
  await checkSelected();
  console.log(`Backend set to postgres (schema ${schema}; connection URL kept in environment).`);
  return 0;
}
