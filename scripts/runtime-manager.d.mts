export interface RuntimePaths {
  runtimeDir: string;
  metadataPath: string;
  repository: string;
}

export function runtimePaths(env?: NodeJS.ProcessEnv): RuntimePaths;
export function activeAgentProcesses(processList: string, currentPid?: number): string[];
export function assertNoActiveAgentSessions(deps?: {
  processList?: string;
  currentPid?: number;
}): void;
export function resolveCommit(repository: string, ref?: string): string;
export function runtimeHead(runtimeDir: string): string;
export function assertCleanRuntime(runtimeDir: string): void;
export function readRuntimeMetadata(metadataPath: string): Record<string, unknown> | null;
export function initializeRuntime(ref?: string): void;
export function promoteRuntime(ref?: string): void;
export function rollbackRuntime(): void;
