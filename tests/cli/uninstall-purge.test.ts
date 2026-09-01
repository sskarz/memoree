import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const repoRoot = resolve(import.meta.dirname, "../..");
const tsxLoader = join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs");
const cli = join(repoRoot, "src", "cli", "index.ts");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeFakeClaude(bin: string, stateDir: string): void {
  mkdirSync(bin, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(bin, "claude"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CLAUDE_LOG"
state_dir="$FAKE_CLAUDE_STATE"
mkdir -p "$state_dir"
case "$*" in
  --version) echo "claude 1.0"; exit 0 ;;
  "plugin marketplace list")
    if [ -f "$state_dir/marketplace" ]; then
      src=$(cat "$state_dir/marketplace")
      printf '  ❯ memoree\\n    Source: Directory (%s)\\n' "$src"
    fi
    exit 0
    ;;
  plugin\\ marketplace\\ add\\ *)
    echo "$4" > "$state_dir/marketplace"
    exit 0
    ;;
  "plugin marketplace remove memoree")
    rm -f "$state_dir/marketplace"
    exit 0
    ;;
  "plugin list")
    if [ -f "$state_dir/plugin" ]; then echo "memoree@memoree enabled"; fi
    exit 0
    ;;
  "plugin install memoree@memoree --scope user"|"plugin update memoree@memoree --scope user")
    touch "$state_dir/plugin"
    exit 0
    ;;
  "plugin enable memoree@memoree --scope user"|"plugin disable memoree@memoree --scope user")
    exit 0
    ;;
  "plugin uninstall memoree@memoree --scope user")
    rm -f "$state_dir/plugin"
    exit 0
    ;;
esac
exit 0
`);
  chmodSync(join(bin, "claude"), 0o755);
  writeFileSync(join(bin, "agy"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_AGY_LOG"
exit 0
`);
  chmodSync(join(bin, "agy"), 0o755);
}

function writeFixturePkg(pkg: string): void {
  mkdirSync(join(pkg, ".claude-plugin"), { recursive: true });
  mkdirSync(join(pkg, "harnesses", "codex", "bundle"), { recursive: true });
  mkdirSync(join(pkg, "harnesses", "codex", "skills", "memoree-memory"), { recursive: true });
  mkdirSync(join(pkg, "harnesses", "antigravity", "bundle"), { recursive: true });
  mkdirSync(join(pkg, "harnesses", "antigravity", "skills", "memoree-memory"), { recursive: true });
  mkdirSync(join(pkg, "harnesses", "antigravity", ".antigravity-plugin"), { recursive: true });
  mkdirSync(join(pkg, "harnesses", "claude-code"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "memoree", version: "0.0.0-test" }) + "\n");
  writeFileSync(
    join(pkg, ".claude-plugin", "marketplace.json"),
    readFileSync(join(repoRoot, ".claude-plugin", "marketplace.json"), "utf-8"),
  );
  writeFileSync(join(pkg, "harnesses", "codex", "bundle", "session-start.js"), "export {}\n");
  writeFileSync(join(pkg, "harnesses", "codex", "bundle", "capture.js"), "export {}\n");
  writeFileSync(join(pkg, "harnesses", "codex", "skills", "memoree-memory", "SKILL.md"), "# Memoree\n");
  writeFileSync(join(pkg, "harnesses", "antigravity", "bundle", "pre-invocation.js"), "export {}\n");
  writeFileSync(join(pkg, "harnesses", "antigravity", "bundle", "mcp-server.js"), "export {}\n");
  writeFileSync(join(pkg, "harnesses", "antigravity", "skills", "memoree-memory", "SKILL.md"), "# Memoree\n");
  writeFileSync(join(pkg, "harnesses", "antigravity", "plugin.json"), JSON.stringify({ name: "memoree" }) + "\n");
  writeFileSync(
    join(pkg, "harnesses", "antigravity", ".antigravity-plugin", "plugin.json"),
    JSON.stringify({ name: "memoree" }) + "\n",
  );
}

function isolatedEnv(
  home: string,
  pkg: string,
  bin: string,
  claudeState: string,
  claudeLog: string,
  agyLog: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    FAKE_CLAUDE_LOG: claudeLog,
    FAKE_CLAUDE_STATE: claudeState,
    FAKE_AGY_LOG: agyLog,
    MEMOREE_PACKAGE_ROOT: pkg,
    MEMOREE_EMBEDDINGS: "false",
  };
  delete env.MEMOREE_CONFIG_PATH;
  delete env.MEMOREE_BACKEND;
  delete env.MEMOREE_SQLITE_PATH;
  delete env.MEMOREE_PKG_HOME;
  return env;
}

function seedUserFiles(home: string): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".claude", "skills", "my-own"), { recursive: true });
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  writeFileSync(join(home, ".codex", "AGENTS.md"), "# My Codex instructions\nDo not delete this user content.\n");
  writeFileSync(join(home, ".codex", "hooks.json"), `${JSON.stringify({
    hooks: {
      Notification: [{ hooks: [{ type: "command", command: "/usr/local/bin/user-hook", timeout: 5 }] }],
    },
  })}\n`);
  writeFileSync(join(home, ".codex", "user-notes.txt"), "user-notes\n");
  writeFileSync(join(home, ".gemini", "config", "mcp_config.json"), `${JSON.stringify({
    mcpServers: { "user-server": { command: "echo", args: ["keep-me"] } },
  })}\n`);
  writeFileSync(join(home, ".gemini", "config", "hooks.json"), `${JSON.stringify({
    "other-plugin": { Stop: [{ type: "command", command: "true", timeout: 1 }] },
  })}\n`);
  writeFileSync(join(home, ".claude", "skills", "my-own", "SKILL.md"), "# hand-written\n");
  writeFileSync(join(home, ".bashrc"), "pre-existing-dotfile\n");
}

function setupHarnessHome(): {
  home: string;
  env: NodeJS.ProcessEnv;
  claudeState: string;
  claudeLog: string;
} {
  const home = mkdtempSync(join(tmpdir(), "memoree-purge-home-"));
  const pkg = mkdtempSync(join(tmpdir(), "memoree-purge-pkg-"));
  roots.push(home, pkg);
  mkdirSync(join(home, ".claude"), { recursive: true });
  const bin = join(home, "bin");
  const claudeState = join(home, "claude-state");
  const claudeLog = join(home, "claude-commands.log");
  const agyLog = join(home, "agy-commands.log");
  writeFakeClaude(bin, claudeState);
  writeFixturePkg(pkg);
  seedUserFiles(home);
  return {
    home,
    env: isolatedEnv(home, pkg, bin, claudeState, claudeLog, agyLog),
    claudeState,
    claudeLog,
  };
}

function runCli(env: NodeJS.ProcessEnv, args: string[]) {
  return spawnSync(process.execPath, ["--import", tsxLoader, cli, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf-8",
  });
}

describe("uninstall --purge (isolated HOME)", () => {
  it("default uninstall leaves ~/.memoree and plugin copies", () => {
    const { home, env, claudeState } = setupHarnessHome();
    const installed = runCli(env, ["install", "--no-embeddings"]);
    expect(installed.status).toBe(0);
    expect(existsSync(join(home, ".memoree", "memoree.sqlite3"))).toBe(true);
    expect(existsSync(join(home, ".codex", "memoree", "bundle", "session-start.js"))).toBe(true);

    const result = runCli(env, ["uninstall"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("plugin files kept");
    expect(existsSync(join(home, ".memoree", "memoree.sqlite3"))).toBe(true);
    expect(existsSync(join(home, ".local", "share", "memoree", "pkg"))).toBe(true);
    expect(existsSync(join(home, ".codex", "memoree"))).toBe(true);
    expect(existsSync(join(home, ".gemini", "config", "plugins", "memoree"))).toBe(true);
    expect(existsSync(join(claudeState, "marketplace"))).toBe(true);
    expect(existsSync(join(home, ".codex", "AGENTS.md"))).toBe(true);
    expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf-8")).toContain("My Codex instructions");
  }, 30_000);

  it("purge --yes removes Memoree files and keeps user content", () => {
    const { home, env, claudeState, claudeLog } = setupHarnessHome();
    expect(runCli(env, ["install", "--no-embeddings"]).status).toBe(0);

    writeFileSync(claudeLog, "");
    const result = runCli(env, ["uninstall", "--purge", "--yes"]);
    expect(result.status, `${result.stderr}${result.stdout}`).toBe(0);
    expect(existsSync(join(home, ".memoree"))).toBe(false);
    expect(existsSync(join(home, ".local", "share", "memoree"))).toBe(false);
    expect(existsSync(join(home, ".codex", "memoree"))).toBe(false);
    expect(existsSync(join(home, ".gemini", "config", "plugins", "memoree"))).toBe(false);
    expect(existsSync(join(home, ".agents", "skills", "memoree-memory"))).toBe(false);
    expect(existsSync(join(claudeState, "marketplace"))).toBe(false);
    expect(readFileSync(claudeLog, "utf-8")).toContain("plugin marketplace remove memoree");

    expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf-8")).toContain("My Codex instructions");
    expect(JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf-8")).hooks.Notification).toHaveLength(1);
    expect(readFileSync(join(home, ".codex", "user-notes.txt"), "utf-8")).toContain("user-notes");
    expect(JSON.parse(readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf-8")).mcpServers["user-server"]).toBeDefined();
    expect(JSON.parse(readFileSync(join(home, ".gemini", "config", "hooks.json"), "utf-8"))["other-plugin"]).toBeDefined();
    expect(existsSync(join(home, ".claude", "skills", "my-own", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(home, ".bashrc"), "utf-8")).toContain("pre-existing-dotfile");
  }, 30_000);

  it("non-TTY --purge without --yes exits nonzero and keeps ~/.memoree", () => {
    const { home, env } = setupHarnessHome();
    mkdirSync(join(home, ".memoree"), { recursive: true });
    writeFileSync(join(home, ".memoree", "keep"), "1");
    const result = runCli(env, ["uninstall", "--purge"]);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/requires --yes/);
    expect(existsSync(join(home, ".memoree", "keep"))).toBe(true);
  }, 15_000);
});
