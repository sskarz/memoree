import { existsSync, lstatSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  HOME, pkgRoot, ensureDir, copyDir, writeJson, writeJsonIfChanged,
  writeVersionStamp, symlinkForce, log, warn,
} from "./util.js";
import { getVersion } from "./version.js";

const GEMINI_HOME = join(HOME, ".gemini");
export const ANTIGRAVITY_PLUGIN_DIR = join(GEMINI_HOME, "antigravity-cli", "plugins", "memoree");
export const ANTIGRAVITY_HOOKS_PATH = join(GEMINI_HOME, "config", "hooks.json");
export const ANTIGRAVITY_MCP_PATH = join(GEMINI_HOME, "config", "mcp_config.json");

function hookCommand(bundleFile: string, event: string, timeout: number): Record<string, unknown> {
  return {
    type: "command",
    command: `node "${join(ANTIGRAVITY_PLUGIN_DIR, "bundle", bundleFile)}" ${event}`,
    timeout,
  };
}

function matcherBlock(bundleFile: string, event: string, timeout: number): Record<string, unknown> {
  return {
    matcher: "*",
    hooks: [hookCommand(bundleFile, event, timeout)],
  };
}

/** Named-hook map entry for Memoree (Antigravity `hooks.json` schema). */
export function buildMemoreeHookBlock(): Record<string, unknown> {
  return {
    PreInvocation: [hookCommand("pre-invocation.js", "PreInvocation", 10)],
    PreToolUse: [matcherBlock("pre-tool-use.js", "PreToolUse", 10)],
    PostToolUse: [matcherBlock("capture.js", "PostToolUse", 15)],
    Stop: [
      hookCommand("stop.js", "Stop", 30),
      hookCommand("graph-on-stop.js", "Stop", 30),
    ],
  };
}

export function mergeNamedHooks(
  existing: Record<string, unknown>,
  ours: Record<string, unknown>,
): Record<string, unknown> {
  return { ...existing, memoree: ours };
}

function readJsonObject(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    warn(`  Antigravity    ${path} unparseable — ignoring prior content`);
  }
  return {};
}

function mcpServerEntry(): Record<string, unknown> {
  return {
    command: "node",
    args: [join(ANTIGRAVITY_PLUGIN_DIR, "bundle", "mcp-server.js")],
  };
}

export function mergeMcpServers(
  existing: Record<string, unknown>,
  server: Record<string, unknown>,
): Record<string, unknown> {
  const servers = (existing.mcpServers && typeof existing.mcpServers === "object")
    ? { ...(existing.mcpServers as Record<string, unknown>) }
    : {};
  servers.memoree = server;
  return { ...existing, mcpServers: servers };
}

export function stripMcpServer(existing: Record<string, unknown>): Record<string, unknown> {
  const servers = (existing.mcpServers && typeof existing.mcpServers === "object")
    ? { ...(existing.mcpServers as Record<string, unknown>) }
    : {};
  delete servers.memoree;
  const next = { ...existing };
  if (Object.keys(servers).length === 0) delete next.mcpServers;
  else next.mcpServers = servers;
  return next;
}

function tryAgyPluginInstall(): void {
  try {
    execFileSync("agy", ["plugin", "install", ANTIGRAVITY_PLUGIN_DIR], { stdio: "ignore" });
    log("  Antigravity    agy plugin install ok");
  } catch {
    // IDE users may not have `agy` on PATH; hooks + MCP still land on disk.
  }
}

export function antigravityBundleExists(root: string): boolean {
  return existsSync(join(root, "harnesses", "antigravity", "bundle"));
}

export function agyCliAvailable(): boolean {
  try {
    execFileSync("agy", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function installAntigravity(options: { packageRoot?: string } = {}): void {
  const root = options.packageRoot ?? pkgRoot();
  const srcBundle = join(root, "harnesses", "antigravity", "bundle");
  const srcSkills = join(root, "harnesses", "antigravity", "skills");
  const srcPluginJson = join(root, "harnesses", "antigravity", "plugin.json");
  const srcManifest = join(root, "harnesses", "antigravity", ".antigravity-plugin");
  const srcRules = join(root, "harnesses", "antigravity", "rules");

  if (!existsSync(srcBundle)) {
    throw new Error(`Antigravity bundle missing at ${srcBundle}. Run 'npm run build' first.`);
  }

  ensureDir(ANTIGRAVITY_PLUGIN_DIR);
  copyDir(srcBundle, join(ANTIGRAVITY_PLUGIN_DIR, "bundle"));
  if (existsSync(srcSkills)) copyDir(srcSkills, join(ANTIGRAVITY_PLUGIN_DIR, "skills"));
  if (existsSync(srcRules)) copyDir(srcRules, join(ANTIGRAVITY_PLUGIN_DIR, "rules"));
  if (existsSync(srcManifest)) copyDir(srcManifest, join(ANTIGRAVITY_PLUGIN_DIR, ".antigravity-plugin"));
  if (existsSync(srcPluginJson)) {
    writeJson(join(ANTIGRAVITY_PLUGIN_DIR, "plugin.json"), JSON.parse(readFileSync(srcPluginJson, "utf-8")));
  } else {
    writeJson(join(ANTIGRAVITY_PLUGIN_DIR, "plugin.json"), {
      name: "memoree",
      description: "Local-first persistent memory for Antigravity via Memoree MCP tools and hooks",
    });
  }

  const hookBlock = buildMemoreeHookBlock();
  writeJson(join(ANTIGRAVITY_PLUGIN_DIR, "hooks.json"), { memoree: hookBlock });
  writeJson(join(ANTIGRAVITY_PLUGIN_DIR, "mcp_config.json"), { mcpServers: { memoree: mcpServerEntry() } });

  if (!writeJsonIfChanged(ANTIGRAVITY_HOOKS_PATH, mergeNamedHooks(readJsonObject(ANTIGRAVITY_HOOKS_PATH), hookBlock))) {
    log("  Antigravity    hooks.json unchanged — skipped rewrite");
  }
  if (!writeJsonIfChanged(ANTIGRAVITY_MCP_PATH, mergeMcpServers(readJsonObject(ANTIGRAVITY_MCP_PATH), mcpServerEntry()))) {
    log("  Antigravity    mcp_config.json unchanged — skipped rewrite");
  }

  const pluginNm = join(ANTIGRAVITY_PLUGIN_DIR, "node_modules");
  const embedDepsNm = join(HOME, ".memoree", "embed-deps", "node_modules");
  if (existsSync(embedDepsNm)) {
    try {
      const st = lstatSync(pluginNm);
      if (st.isDirectory() && !st.isSymbolicLink()) rmSync(pluginNm, { recursive: true });
    } catch { /* not found */ }
    symlinkForce(embedDepsNm, pluginNm);
  }

  writeVersionStamp(ANTIGRAVITY_PLUGIN_DIR, getVersion());
  tryAgyPluginInstall();
  log(`  Antigravity    installed -> ${ANTIGRAVITY_PLUGIN_DIR}`);
}

export function uninstallAntigravity(): void {
  if (existsSync(ANTIGRAVITY_HOOKS_PATH)) {
    const existing = readJsonObject(ANTIGRAVITY_HOOKS_PATH);
    const next = { ...existing };
    delete next.memoree;
    if (Object.keys(next).length === 0) {
      unlinkSync(ANTIGRAVITY_HOOKS_PATH);
      log(`  Antigravity    removed ${ANTIGRAVITY_HOOKS_PATH}`);
    } else {
      writeJson(ANTIGRAVITY_HOOKS_PATH, next);
      log("  Antigravity    stripped memoree from hooks.json");
    }
  }
  if (existsSync(ANTIGRAVITY_MCP_PATH)) {
    const stripped = stripMcpServer(readJsonObject(ANTIGRAVITY_MCP_PATH));
    if (!stripped.mcpServers && Object.keys(stripped).length === 0) {
      unlinkSync(ANTIGRAVITY_MCP_PATH);
      log(`  Antigravity    removed ${ANTIGRAVITY_MCP_PATH}`);
    } else {
      writeJson(ANTIGRAVITY_MCP_PATH, stripped);
      log("  Antigravity    stripped memoree MCP server from mcp_config.json");
    }
  }
  try {
    execFileSync("agy", ["plugin", "uninstall", "memoree"], { stdio: "ignore" });
  } catch { /* optional */ }
  log(`  Antigravity    plugin files kept at ${ANTIGRAVITY_PLUGIN_DIR}`);
}
