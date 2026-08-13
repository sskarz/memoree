import { execFileSync } from "node:child_process";
import { log } from "./util.js";
import { pkgRoot } from "./util.js";

const MARKETPLACE_NAME = "memoree";
const PLUGIN_KEY = "memoree@memoree";

interface ClaudeResult { ok: boolean; stdout: string; stderr: string }

function isAlreadyEnabled(result: ClaudeResult): boolean {
  return /plugin\s+["']?memoree@memoree["']?\s+is already enabled\b/i.test(
    `${result.stdout}\n${result.stderr}`,
  );
}

function runClaude(args: string[]): ClaudeResult {
  try {
    const stdout = execFileSync("claude", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const value = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      stdout: value.stdout?.toString() ?? "",
      stderr: value.stderr?.toString() ?? value.message ?? "",
    };
  }
}

function requireClaudeCli(): void {
  try { execFileSync("claude", ["--version"], { stdio: "ignore" }); }
  catch { throw new Error("Claude Code CLI ('claude') not found on PATH. Install Claude Code first."); }
}

function marketplaceSource(output: string): string | null {
  const block = output.match(/(?:^|\n)\s*[❯>*-]?\s*memoree\s*\n\s*Source:\s*Directory\s*\(([^)]+)\)/i);
  return block?.[1]?.trim() ?? null;
}

export function installClaude(options: { source?: string } = {}): void {
  requireClaudeCli();
  const source = options.source ?? pkgRoot();
  const marketplaces = runClaude(["plugin", "marketplace", "list"]);
  const configuredSource = marketplaces.ok ? marketplaceSource(marketplaces.stdout) : null;
  if (configuredSource !== source) {
    if (configuredSource !== null) {
      const removed = runClaude(["plugin", "marketplace", "remove", MARKETPLACE_NAME]);
      if (!removed.ok) throw new Error(`Failed to remove stale Memoree marketplace: ${removed.stderr.slice(0, 200)}`);
    }
    const added = runClaude(["plugin", "marketplace", "add", source]);
    if (!added.ok) throw new Error(`Failed to register local marketplace '${source}': ${added.stderr.slice(0, 200)}`);
  }

  const installed = runClaude(["plugin", "list"]);
  if (!installed.ok || !installed.stdout.includes(PLUGIN_KEY)) {
    const result = runClaude(["plugin", "install", PLUGIN_KEY, "--scope", "user"]);
    if (!result.ok) throw new Error(`Failed to install Memoree plugin: ${result.stderr.slice(0, 200)}`);
  } else {
    const result = runClaude(["plugin", "update", PLUGIN_KEY, "--scope", "user"]);
    if (!result.ok) throw new Error(`Failed to update Memoree plugin: ${result.stderr.slice(0, 200)}`);
  }
  const enabled = runClaude(["plugin", "enable", PLUGIN_KEY, "--scope", "user"]);
  if (!enabled.ok && !isAlreadyEnabled(enabled)) {
    throw new Error(`Failed to enable Memoree plugin: ${enabled.stderr.slice(0, 200)}`);
  }
  log(`  Claude Code    enabled ${PLUGIN_KEY} from ${source}`);
}

export function uninstallClaude(): void {
  requireClaudeCli();
  runClaude(["plugin", "disable", PLUGIN_KEY, "--scope", "user"]);
  runClaude(["plugin", "uninstall", PLUGIN_KEY, "--scope", "user"]);
  log("  Claude Code    Memoree plugin uninstalled");
}
