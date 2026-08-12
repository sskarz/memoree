import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface UserConfig {
  storage?: {
    provider?: "sqlite" | "postgres";
    sqlitePath?: string;
    postgresSchema?: string;
  };
  userName?: string;
  capture?: { enabled?: boolean };
  embeddings?: { enabled?: boolean };
  docs?: { llmAgent?: string };
}

let _configPath: () => string = () =>
  process.env.MEMOREE_CONFIG_PATH ?? join(homedir(), ".memoree", "config.json");
let _cache: UserConfig | null = null;

export function readUserConfig(): UserConfig {
  if (_cache !== null) return _cache;
  const path = _configPath();
  if (!existsSync(path)) return (_cache = {});
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return (_cache = isPlainObject(parsed) ? parsed as UserConfig : {});
  } catch {
    return (_cache = {});
  }
}

export function writeUserConfig(patch: Partial<UserConfig>): UserConfig {
  const merged = deepMerge(readUserConfig(), patch);
  const path = _configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
  return (_cache = merged);
}

export function getEmbeddingsEnabled(): boolean {
  const configured = readUserConfig().embeddings?.enabled;
  if (typeof configured === "boolean") return configured;
  const env = process.env.MEMOREE_EMBEDDINGS;
  return env === undefined ? true : !["0", "false", "no", "off"].includes(env.toLowerCase());
}

export function setEmbeddingsEnabled(enabled: boolean): void {
  writeUserConfig({ embeddings: { enabled } });
}

export function getDocsLlmAgent(): string | undefined {
  const value = readUserConfig().docs?.llmAgent;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function setDocsLlmAgent(llmAgent: string): void {
  writeUserConfig({ docs: { llmAgent } });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: UserConfig, patch: Partial<UserConfig>): UserConfig {
  const out: UserConfig = { ...base };
  for (const key of Object.keys(patch) as Array<keyof UserConfig>) {
    const next = patch[key];
    const current = base[key];
    if (isPlainObject(next) && isPlainObject(current)) (out as Record<string, unknown>)[key] = { ...current, ...next };
    else if (next !== undefined) (out as Record<string, unknown>)[key] = next;
  }
  return out;
}

export function _setConfigPathForTesting(fn: () => string): void {
  _configPath = fn;
  _cache = null;
}

export function _resetUserConfigForTesting(): void {
  _configPath = () => process.env.MEMOREE_CONFIG_PATH ?? join(homedir(), ".memoree", "config.json");
  _cache = null;
}
