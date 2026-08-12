import { execFileSync } from "node:child_process";
import { log } from "./util.js";
import { pkgRoot } from "./util.js";

const MARKETPLACE_NAME = "memoree";
const PLUGIN_KEY = "memoree@memoree";

interface ClaudeResult { ok: boolean; stdout: string; stderr: string }

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

export function installClaude(): void {
  requireClaudeCli();
  const source = pkgRoot();
  const marketplaces = runClaude(["plugin", "marketplace", "list"]);
  if (!marketplaces.ok || !new RegExp(`(^|\\s)${MARKETPLACE_NAME}(\\s|$)`, "m").test(marketplaces.stdout)) {
    const added = runClaude(["plugin", "marketplace", "add", source]);
    if (!added.ok) throw new Error(`Failed to register local marketplace '${source}': ${added.stderr.slice(0, 200)}`);
  }

  const installed = runClaude(["plugin", "list"]);
  if (!installed.ok || !installed.stdout.includes(PLUGIN_KEY)) {
    const result = runClaude(["plugin", "install", PLUGIN_KEY, "--scope", "user"]);
    if (!result.ok) throw new Error(`Failed to install Memoree plugin: ${result.stderr.slice(0, 200)}`);
  }
  const enabled = runClaude(["plugin", "enable", PLUGIN_KEY, "--scope", "user"]);
  if (!enabled.ok) throw new Error(`Failed to enable Memoree plugin: ${enabled.stderr.slice(0, 200)}`);
  log(`  Claude Code    enabled ${PLUGIN_KEY} from ${source}`);
}

export function uninstallClaude(): void {
  requireClaudeCli();
  runClaude(["plugin", "disable", PLUGIN_KEY, "--scope", "user"]);
  runClaude(["plugin", "uninstall", PLUGIN_KEY, "--scope", "user"]);
  log("  Claude Code    Memoree plugin uninstalled");
}
