export interface IsolatedCounts {
  matchingEvents: number;
  summaries: number;
  matchingSummaries: number;
}

export interface WaitForCaptureOptions {
  requireSummary?: boolean;
  timeoutMs?: number;
  pollMs?: number;
}

export function authenticatedClaudeEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  home: string,
  configDir?: string,
): NodeJS.ProcessEnv;
export function assertAgentResponseContainsIdentifier(
  response: string,
  identifier: string,
  phase: string,
): void;
export function lexicalValidationPrompt(identifier: string): string;
export function copyCodexAuthentication(realHome: string, isolatedCodexHome: string): void;
export function createValidationWorkspace(home?: string): string;
export function classifyAgentCommandError(error: unknown): string | null;
export function runStructuredFilesystemViaHooks(
  preToolPath: string,
  commands: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; sessionId?: string },
): Array<{ command: string; status: number | null; stdout: string; stderr: string }>;
export function skipLiveCodexRequested(argv?: string[], env?: NodeJS.ProcessEnv): boolean;
export function hookUpdatedInput(stdout: string): Record<string, unknown>;
export function linkSharedEmbeddingRuntime(realHome: string, isolatedHome: string): void;
export function hookBodyContains(stdout: string, needle: string): boolean;
export function isolatedCounts(databasePath: string, text: string): IsolatedCounts;
export function waitForCapture(
  databasePath: string,
  text: string,
  options?: WaitForCaptureOptions,
): Promise<IsolatedCounts>;
export function validateRuntime(options?: { skipLiveCodex?: boolean }): Promise<void>;
