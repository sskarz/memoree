import { loadConfig, type StorageProvider } from "../config.js";
import { createStorageBackend } from "../storage/factory.js";
import type { StorageBackend } from "../storage/backend.js";

export interface WorkerStorageMetadata {
  storage?: { kind: StorageProvider };
  memoryTable?: string;
  sessionsTable: string;
  userName: string;
}

export function createWorkerStorage(metadata: WorkerStorageMetadata, _retryLogger?: (message: string) => void): StorageBackend {
  const config = loadConfig();
  if (!config) throw new Error("Storage configuration is unavailable in worker");
  return createStorageBackend(config, metadata.memoryTable ?? config.tableName);
}

export async function queryWorkerStorage(backend: StorageBackend, sql: string): Promise<Record<string, unknown>[]> {
  try { return await backend.query(sql); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace(/^Query failed:\s*/, "Storage "));
  }
}
