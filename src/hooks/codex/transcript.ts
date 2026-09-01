import { existsSync, readFileSync } from "node:fs";

const MAX_ASSISTANT_CHARS = 4000;

/**
 * Pull the latest assistant text from a Codex JSONL transcript.
 *
 * Codex Stop / SubagentStop now sometimes include `last_assistant_message`.
 * When they do not, the transcript is the fallback — same nested
 * `payload.role` / `content[].text` shape used by the historical Stop hook.
 */
export function extractLastAssistantFromCodexTranscript(
  transcriptPath: string | null | undefined,
): string {
  if (!transcriptPath || !existsSync(transcriptPath)) return "";
  try {
    const transcript = readFileSync(transcriptPath, "utf-8");
    const lines = transcript.trim().split("\n").reverse();
    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const msg = (entry.payload && typeof entry.payload === "object"
          ? entry.payload
          : entry) as Record<string, unknown>;
        if (msg.role !== "assistant" || msg.content == null) continue;
        const content = assistantContentToText(msg.content);
        if (content) return content.slice(0, MAX_ASSISTANT_CHARS);
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    return "";
  }
  return "";
}

function assistantContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type?: string; text?: unknown } =>
      Boolean(block) && typeof block === "object")
    .filter(block => block.type === "output_text" || block.type === "text")
    .map(block => typeof block.text === "string" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}

/** Prefer the hook payload, then the subagent transcript, then the parent transcript. */
export function resolveCodexAssistantMessage(input: {
  last_assistant_message?: string | null;
  agent_transcript_path?: string | null;
  transcript_path?: string | null;
}): string {
  const fromPayload = typeof input.last_assistant_message === "string"
    ? input.last_assistant_message.trim()
    : "";
  if (fromPayload) return fromPayload.slice(0, MAX_ASSISTANT_CHARS);
  return extractLastAssistantFromCodexTranscript(
    input.agent_transcript_path ?? input.transcript_path,
  );
}
