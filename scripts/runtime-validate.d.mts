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

export function claudeProfileRoot(env?: NodeJS.ProcessEnv, home?: string): string;
export function prepareIsolatedClaudeConfig(
  sourceRoot: string,
  targetRoot: string,
  autoMemoryDirectory: string,
): string;
export function isolatedCounts(databasePath: string, text: string): IsolatedCounts;
export function waitForCapture(
  databasePath: string,
  text: string,
  options?: WaitForCaptureOptions,
): Promise<IsolatedCounts>;
export function validateRuntime(): Promise<void>;
