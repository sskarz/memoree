// Helpers that read and write ~/.openclaw/openclaw.json on behalf of the
// /memoree_setup slash command and the CLI
// installer at src/cli/install-openclaw.ts. Kept in its own module so the
// config-IO code stays separate from the network code in index.ts and has
// a narrow public surface.

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Every tool registered by the openclaw plugin (contracts + setup hints). */
export const MEMOREE_TOOL_NAMES = [
  "memoree_search",
  "memoree_read",
  "memoree_index",
  "memoree_goal_add",
  "memoree_kpi_add",
  "memoree_graph_search",
  "memoree_graph_neighborhood",
];

/**
 * Core memory tools whose per-name alsoAllow entry counts as full suite
 * coverage. Niche tools (goals/KPIs/graph) must NOT — a user who allowlists
 * only memoree_graph_search still needs "memoree" added by /memoree_setup.
 */
export const MEMOREE_CORE_ALLOWLIST_TOOLS = [
  "memoree_search",
  "memoree_read",
  "memoree_index",
];

export function getOpenclawConfigPath(): string {
  return join(homedir(), ".openclaw", "openclaw.json");
}

export function isAllowlistCoveringMemoree(alsoAllow: unknown): boolean {
  if (!Array.isArray(alsoAllow)) return false;
  for (const entry of alsoAllow) {
    if (typeof entry !== "string") continue;
    const normalized = entry.trim().toLowerCase();
    if (normalized === "memoree") return true;
    if (normalized === "group:plugins") return true;
    if (MEMOREE_CORE_ALLOWLIST_TOOLS.includes(normalized)) return true;
  }
  return false;
}

/**
 * True when plugins.allow is an explicit non-empty array that doesn't yet
 * include "memoree". Mirrors openclaw's own `ensurePluginAllowlisted`
 * semantics (ext/openclaw/src/config/plugins-allowlist.ts): only patch
 * when the user has opted into an explicit allowlist. If it's absent or
 * empty, openclaw treats that as default-allow, and we must not silently
 * flip the user into explicit-allowlist mode — that would disable every
 * other plugin they have installed.
 */
export function isPluginsAllowMissingMemoree(allow: unknown): boolean {
  return Array.isArray(allow) && allow.length > 0 && !allow.includes("memoree");
}

export type AllowlistDelta = {
  pluginsAllow: boolean;
  toolsAlsoAllow: boolean;
};

export type SetupResult =
  | { status: "already-set"; configPath: string }
  | { status: "added"; configPath: string; backupPath: string; delta: AllowlistDelta }
  | { status: "error"; configPath: string; error: string };

/**
 * Patch ~/.openclaw/openclaw.json so the memoree plugin can both load
 * (plugins.allow) and expose its tools (tools.alsoAllow). Atomic write
 * via tmp+rename with a timestamped backup. Idempotent across re-runs.
 *
 * Called from the /memoree_setup slash command AND from the CLI installer
 * — both surfaces need exactly the same config-patch semantics, so they
 * share this one entry point. The slash command only becomes reachable
 * AFTER plugins.allow already accepts memoree, so the CLI installer is
 * the one path that can fix that case end-to-end (issue #121).
 */
export function ensureMemoreeAllowlisted(): SetupResult {
  const configPath = getOpenclawConfigPath();
  if (!existsSync(configPath)) {
    return { status: "error", configPath, error: "openclaw config file not found" };
  }
  let parsed: Record<string, unknown>;
  try {
    const raw = readFileSync(configPath, "utf-8");
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    return { status: "error", configPath, error: `could not read/parse config: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "error", configPath, error: "openclaw config is not a JSON object" };
  }

  const plugins = (parsed.plugins ?? {}) as Record<string, unknown>;
  const pluginsAllowRaw = plugins.allow;
  const tools = (parsed.tools ?? {}) as Record<string, unknown>;
  const alsoAllowRaw = tools.alsoAllow;

  const pluginsAllowNeedsPatch = isPluginsAllowMissingMemoree(pluginsAllowRaw);
  // Match the same explicit-non-empty-only contract used for plugins.allow:
  // only patch when the user has opted into an explicit array. Absent or
  // empty → leave alone, so we don't flip default-allow setups into
  // restrictive explicit-allowlist mode (CodeRabbit on #124). The
  // reporter's broken-state config in #121 already had this as an
  // explicit array, so the original bug-fix path is unchanged.
  const toolsAlsoAllowNeedsPatch =
    Array.isArray(alsoAllowRaw) && alsoAllowRaw.length > 0 &&
    !isAllowlistCoveringMemoree(alsoAllowRaw);

  if (!pluginsAllowNeedsPatch && !toolsAlsoAllowNeedsPatch) {
    return { status: "already-set", configPath };
  }

  const updated: Record<string, unknown> = { ...parsed };

  if (pluginsAllowNeedsPatch) {
    updated.plugins = {
      ...plugins,
      // Cast safe — isPluginsAllowMissingMemoree guarantees Array.
      allow: [...(pluginsAllowRaw as unknown[]), "memoree"],
    };
  }

  if (toolsAlsoAllowNeedsPatch) {
    updated.tools = {
      ...tools,
      // Cast safe — the needs-patch check above guarantees Array.
      alsoAllow: [...(alsoAllowRaw as unknown[]), "memoree"],
    };
  }

  const backupPath = `${configPath}.bak-memoree-${Date.now()}`;
  const tmpPath = `${configPath}.tmp-memoree-${process.pid}`;
  try {
    writeFileSync(backupPath, readFileSync(configPath, "utf-8"));
    writeFileSync(tmpPath, JSON.stringify(updated, null, 2) + "\n");
    renameSync(tmpPath, configPath);
  } catch (e) {
    return { status: "error", configPath, error: `could not write config: ${e instanceof Error ? e.message : String(e)}` };
  }
  return {
    status: "added",
    configPath,
    backupPath,
    delta: {
      pluginsAllow: pluginsAllowNeedsPatch,
      toolsAlsoAllow: toolsAlsoAllowNeedsPatch,
    },
  };
}

/**
 * True if the openclaw config exists but EITHER plugins.allow or
 * tools.alsoAllow is missing memoree. Used by index.ts at plugin-
 * register time to decide whether to inject the "run /memoree_setup"
 * nudge into the system prompt. Returns false on any error so unusual
 * host environments don't produce spurious nudges.
 *
 * Note: when plugins.allow is the one that's missing memoree, the
 * plugin won't have registered in the first place and this function
 * is moot for that path — but the same check still covers the case
 * where a user manually adds memoree to plugins.allow + restarts but
 * forgets to also update tools.alsoAllow.
 */
export function detectAllowlistMissing(): boolean {
  const configPath = getOpenclawConfigPath();
  if (!existsSync(configPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const plugins = (parsed.plugins ?? {}) as Record<string, unknown>;
    const tools = (parsed.tools ?? {}) as Record<string, unknown>;
    const alsoAllow = tools.alsoAllow;
    // Same explicit-non-empty-only contract as `ensureMemoreeAllowlisted`:
    // an absent/empty `tools.alsoAllow` is default-allow, not "missing
    // memoree" — so don't trigger the nudge for those users.
    const toolsMissing =
      Array.isArray(alsoAllow) && alsoAllow.length > 0 &&
      !isAllowlistCoveringMemoree(alsoAllow);
    return isPluginsAllowMissingMemoree(plugins.allow) || toolsMissing;
  } catch {
    return false;
  }
}
