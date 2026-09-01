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

function firstString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map(entry => entry.trim());
  return items.length > 0 ? items : undefined;
}

function toolCallOf(value: unknown): AntigravityHookInput["toolCall"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : undefined;
  const args = (record.args && typeof record.args === "object" && !Array.isArray(record.args))
    ? record.args as Record<string, unknown>
    : undefined;
  if (!name && !args) return undefined;
  return { name, args };
}

/** Accept camelCase (docs) and snake_case aliases from older CLI builds. */
export function normalizeAntigravityInput(raw: unknown): AntigravityHookInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const fullyIdle = typeof record.fullyIdle === "boolean"
    ? record.fullyIdle
    : (typeof record.fully_idle === "boolean" ? record.fully_idle : undefined);
  const error = typeof record.error === "string" ? record.error : undefined;
  return {
    conversationId: firstString(record, "conversationId", "conversation_id"),
    workspacePaths: stringList(record.workspacePaths ?? record.workspace_paths),
    transcriptPath: firstString(record, "transcriptPath", "transcript_path"),
    artifactDirectoryPath: firstString(record, "artifactDirectoryPath", "artifact_directory_path"),
    invocationNum: firstNumber(record, "invocationNum", "invocation_num"),
    initialNumSteps: firstNumber(record, "initialNumSteps", "initial_num_steps"),
    stepIdx: firstNumber(record, "stepIdx", "step_idx"),
    toolCall: toolCallOf(record.toolCall ?? record.tool_call),
    error,
    executionNum: firstNumber(record, "executionNum", "execution_num"),
    terminationReason: firstString(record, "terminationReason", "termination_reason"),
    fullyIdle,
    modelName: firstString(record, "modelName", "model_name"),
  };
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
