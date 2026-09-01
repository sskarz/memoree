/** Antigravity hook stdin is camelCase and omits the event name (pass it as argv). */

export interface AntigravityHookInput {
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  invocationNum?: number;
  initialNumSteps?: number;
  stepIdx?: number;
  toolCall?: {
    name?: string;
    args?: Record<string, unknown>;
  };
  error?: string;
  executionNum?: number;
  terminationReason?: string;
  fullyIdle?: boolean;
  modelName?: string;
}

export function eventNameFromArgv(argv: string[] = process.argv): string {
  const last = argv[argv.length - 1];
  if (last && /^[A-Za-z]+$/.test(last) && last !== "node") return last;
  return "";
}

export function workspaceCwd(input: AntigravityHookInput): string {
  const first = input.workspacePaths?.[0];
  const trimmed = first?.trim();
  return trimmed ? trimmed : process.cwd();
}

export function sessionIdOf(input: AntigravityHookInput): string {
  return input.conversationId?.trim() || "unknown";
}

export const MEMORY_STEER =
  "~/.memoree/memory is a virtual filesystem. Use the Memoree MCP tools: " +
  "memoree_read, memoree_ls, memoree_grep, memoree_head, memoree_tail, memoree_wc, " +
  "memoree_find, memoree_jq, memoree_write, memoree_mv, memoree_rm. " +
  "Do not cat/ls/grep that path with run_command or view_file.";

const PATH_KEYS = [
  "CommandLine", "command", "AbsolutePath", "TargetFile", "SearchPath",
  "SearchDirectory", "DirectoryPath", "path",
];

export function toolPayloadTouchesMemory(
  input: AntigravityHookInput,
  touches: (value: string) => boolean,
): boolean {
  const args = input.toolCall?.args ?? {};
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string" && touches(value)) return true;
  }
  return false;
}
