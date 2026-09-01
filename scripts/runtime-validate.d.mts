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
export const CLAUDE_LEXICAL_RECALL_ATTEMPTS: 3;
export function claudeLexicalRecallPrompt(identifier: string): string;
export function codexSemanticRecallPrompt(): string;
export function copyCodexAuthentication(realHome: string, isolatedCodexHome: string): void;
export function createValidationWorkspace(home?: string): string;
export function classifyAgentCommandError(error: unknown): string | null;
export function runStructuredFilesystemViaHooks(
  preToolPath: string,
  commands: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; sessionId?: string },
): Array<{ command: string; status: number | null; stdout: string; stderr: string }>;
export function skipLiveCodexRequested(argv?: string[], env?: NodeJS.ProcessEnv): boolean;
export const DEFAULT_LIVE_CLAUDE_MODEL: "haiku";
export const DEFAULT_LIVE_CODEX_MODEL: "gpt-5.6-luna";
export const DEFAULT_LIVE_CODEX_REASONING_EFFORT: "low";
export function liveClaudeModel(env?: NodeJS.ProcessEnv): string;
export function liveCodexModel(env?: NodeJS.ProcessEnv): string;
export function liveCodexReasoningEffort(env?: NodeJS.ProcessEnv): string;
export function claudeLiveCliArgs(
  prompt: string,
  extra?: string[],
  env?: NodeJS.ProcessEnv,
): string[];
export function codexExecLiveArgs(rest?: string[], env?: NodeJS.ProcessEnv): string[];
export function hookUpdatedInput(stdout: string): Record<string, unknown>;
export function linkSharedEmbeddingRuntime(realHome: string, isolatedHome: string): void;
export function hookBodyContains(stdout: string, needle: string): boolean;
export function isolatedCounts(databasePath: string, text: string): IsolatedCounts;
export function waitForCapture(
  databasePath: string,
  text: string,
  options?: WaitForCaptureOptions,
): Promise<IsolatedCounts>;
export function inspectCaptureDatabase(
  databasePath: string,
  options?: {
    requireInEvents?: string[];
    requireInSummaries?: string[];
    requireInEventsOrSummaries?: string[];
    emptyEventsMessage?: string;
    emptySummariesMessage?: string;
  },
): { events: number; summaries: number };
export function run(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    capture?: boolean;
    timeout?: number;
    input?: string;
  },
): string;
export function assert(condition: unknown, message: string): asserts condition;
export function status(message: string): void;
export function runCodex(
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean; timeout?: number },
): string;
export function removeValidationWorkspace(root: string): void;
export function validateRuntime(options?: { skipLiveCodex?: boolean }): Promise<void>;
