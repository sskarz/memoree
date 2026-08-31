import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(part => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text ?? "");
      return "";
    }).join("");
  }
  if (value && typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "");
  }
  return "";
}

function roleOf(obj: Record<string, unknown>): "user" | "assistant" | null {
  const raw = String(obj.role ?? obj.type ?? obj.kind ?? obj.messageType ?? "").toLowerCase();
  if (raw.includes("user") || raw === "user_input" || raw === "human") return "user";
  if (raw.includes("assistant") || raw.includes("model") || raw === "ai") return "assistant";
  return null;
}

export function parseTranscriptJsonl(raw: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    const role = roleOf(obj);
    if (!role) continue;
    const text = asText(obj.text ?? obj.content ?? obj.message ?? obj.userMessage ?? obj.prompt).trim();
    if (!text) continue;
    turns.push({ role, text });
  }
  return turns;
}

export function lastTurn(turns: TranscriptTurn[], role: TranscriptTurn["role"]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === role) return turns[i].text;
  }
  return "";
}

export function readTranscriptTurns(transcriptPath: string | undefined): TranscriptTurn[] {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  try { return parseTranscriptJsonl(readFileSync(transcriptPath, "utf-8")); }
  catch { return []; }
}

function stateDir(kind: string): string {
  return join(homedir(), ".memoree", "agent-state", kind);
}

/** Atomic first-wake claim per conversation (mkdir leaf). */
export function claimFirstInvocation(conversationId: string): boolean {
  const parent = stateDir("antigravity-wake");
  mkdirSync(parent, { recursive: true });
  const leaf = join(parent, conversationId.replace(/[^A-Za-z0-9._-]/g, "_"));
  try {
    mkdirSync(leaf);
    return true;
  } catch {
    return false;
  }
}

export function takeNewUserPrompt(conversationId: string, text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parent = stateDir("antigravity-capture");
  mkdirSync(parent, { recursive: true });
  const file = join(parent, `${conversationId.replace(/[^A-Za-z0-9._-]/g, "_")}.txt`);
  let previous = "";
  try { if (existsSync(file)) previous = readFileSync(file, "utf-8"); } catch { /* ignore */ }
  if (previous === trimmed) return null;
  writeFileSync(file, trimmed);
  return trimmed;
}
