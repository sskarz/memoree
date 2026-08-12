import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { loadConfig, type Config } from "./config.js";

export const DIR_CONFIG_FILENAMES = [".memoree.local", ".memoree"] as const;

export interface DirConfigFile {
  repositoryKey?: string;
  collect?: boolean;
}

export interface FoundDirConfig { path: string; raw: DirConfigFile }
export interface ResolvedDirConfig { config: Config; collect: boolean; found: FoundDirConfig | null }

export function parseDirConfig(contents: string): DirConfigFile | null {
  try {
    const value = JSON.parse(contents) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const result: DirConfigFile = {};
    if (typeof value.repositoryKey === "string" && value.repositoryKey.trim()) result.repositoryKey = value.repositoryKey.trim();
    if (typeof value.collect === "boolean") result.collect = value.collect;
    return result;
  } catch { return null; }
}

export function findDirConfig(startDir: string, stopAt?: string): FoundDirConfig | null {
  let dir = resolve(startDir);
  const boundary = stopAt ? resolve(stopAt) : null;
  for (;;) {
    for (const name of DIR_CONFIG_FILENAMES) {
      const path = join(dir, name);
      try {
        const raw = parseDirConfig(readFileSync(path, "utf-8"));
        if (raw) return { path, raw };
      } catch { /* absent or unreadable */ }
    }
    if (dir === boundary) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function resolveDirConfig(base: Config, cwd: string): ResolvedDirConfig {
  const found = findDirConfig(cwd);
  if (!found) return { config: base, collect: true, found: null };
  const repositoryKey = found.raw.repositoryKey ?? base.workspaceId;
  const storage = { ...base.storage, workspaceId: repositoryKey };
  return {
    config: { ...base, workspaceId: repositoryKey, storage },
    collect: found.raw.collect !== false,
    found,
  };
}

export function loadRoutedConfig(cwd: string = process.cwd()): Config | null {
  const base = loadConfig();
  return base ? resolveDirConfig(base, cwd).config : null;
}
