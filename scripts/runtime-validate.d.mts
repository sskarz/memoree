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
export function isolatedCounts(databasePath: string, text: string): IsolatedCounts;
export function waitForCapture(
  databasePath: string,
  text: string,
  options?: WaitForCaptureOptions,
): Promise<IsolatedCounts>;
export function validateRuntime(): Promise<void>;
