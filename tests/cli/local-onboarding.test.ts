import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const repoRoot = resolve(import.meta.dirname, "../..");
const tsxLoader = join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local-first onboarding", () => {
  it("initializes ~/.memoree, stages a durable plugin copy, and registers Claude from that copy", () => {
    const root = mkdtempSync(join(tmpdir(), "memoree-onboarding-"));
    roots.push(root);
    mkdirSync(join(root, ".claude"));
    const staged = join(root, ".local", "share", "memoree", "pkg");
    const bin = join(root, "bin");
    const commandLog = join(root, "claude-commands.log");
    const pluginState = join(root, "plugin-installed");
    mkdirSync(bin);
    const claude = join(bin, "claude");
    writeFileSync(claude, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CLAUDE_LOG"
if [ "$1" = "--version" ]; then echo "claude 1.0"; exit 0; fi
if [ "$1 $2" = "plugin list" ]; then
  if [ -f "$FAKE_CLAUDE_STATE" ]; then echo "memoree@memoree enabled"; fi
  exit 0
fi
if [ "$1 $2 $3" = "plugin marketplace list" ]; then exit 0; fi
if [ "$1 $2" = "plugin install" ]; then touch "$FAKE_CLAUDE_STATE"; fi
exit 0
`);
    chmodSync(claude, 0o755);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_CLAUDE_LOG: commandLog,
      FAKE_CLAUDE_STATE: pluginState,
      MEMOREE_EMBEDDINGS: "false",
    };
    delete env.MEMOREE_CONFIG_PATH;
    delete env.MEMOREE_BACKEND;
    delete env.MEMOREE_SQLITE_PATH;
    delete env.MEMOREE_PKG_HOME;
    delete env.MEMOREE_PACKAGE_ROOT;
    const cli = join(repoRoot, "src", "cli", "index.ts");
    const installOutput = execFileSync(process.execPath, ["--import", tsxLoader, cli, "install", "--no-embeddings"], {
      cwd: repoRoot,
      env,
      encoding: "utf-8",
    });
    expect(installOutput).toContain(`Database: ${join(root, ".memoree", "memoree.sqlite3")}`);
    expect(installOutput).toContain(`Staged plugin: ${staged}`);
    expect(installOutput).toContain("npx @sskarz/memoree doctor");
    expect(installOutput).toContain("memoree docs sync");
    expect(existsSync(join(root, ".memoree", "config.json"))).toBe(true);
    expect(existsSync(join(root, ".memoree", "memoree.sqlite3"))).toBe(true);
    expect(existsSync(join(staged, ".claude-plugin", "marketplace.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, ".memoree", "config.json"), "utf-8"))).toMatchObject({
      storage: { provider: "sqlite", sqlitePath: join(root, ".memoree", "memoree.sqlite3") },
      embeddings: { enabled: false },
    });
    expect(existsSync(join(root, ".codex"))).toBe(false);

    const commands = readFileSync(commandLog, "utf-8").trim().split("\n");
    expect(commands).toEqual([
      "--version",
      "--version",
      "plugin marketplace list",
      `plugin marketplace add ${staged}`,
      "plugin list",
      "plugin install memoree@memoree --scope user",
      "plugin enable memoree@memoree --scope user",
    ]);

    const doctor = spawnSync(process.execPath, ["--import", tsxLoader, cli, "doctor"], {
      cwd: repoRoot,
      env,
      encoding: "utf-8",
    });
    const doctorOutput = `${doctor.stdout ?? ""}${doctor.stderr ?? ""}`;
    expect(doctorOutput).toContain("ok  database:");
    expect(doctorOutput).toContain("ok  schema:");
    expect(doctorOutput).toContain("ok  plugin:");
    const hookBundle = join(repoRoot, "harnesses", "claude-code", "bundle");
    const hooksBuilt = ["session-start.js", "capture.js", "recall.js", "session-end.js"]
      .every(file => existsSync(join(hookBundle, file)));
    if (hooksBuilt) {
      expect(doctorOutput).toContain("ok  hook bundles:");
      expect(doctor.status).toBe(0);
    } else {
      expect(doctorOutput).toContain("FAIL  hook bundles:");
      expect(doctor.status).toBe(1);
    }
  }, 30_000);

  it("installs Codex only when ~/.codex is present and claude is not on PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "memoree-onboarding-codex-"));
    roots.push(root);
    mkdirSync(join(root, ".codex"));
    const fixture = mkdtempSync(join(tmpdir(), "memoree-pkg-fixture-"));
    roots.push(fixture);
    mkdirSync(join(fixture, ".claude-plugin"), { recursive: true });
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "memoree" }) + "\n");
    writeFileSync(join(fixture, ".claude-plugin", "marketplace.json"), JSON.stringify({
      name: "memoree",
      plugins: [{ name: "memoree", source: "./harnesses/claude-code" }],
    }) + "\n");
    mkdirSync(join(fixture, "harnesses", "codex", "bundle"), { recursive: true });
    mkdirSync(join(fixture, "harnesses", "codex", "skills", "memoree-memory"), { recursive: true });
    writeFileSync(join(fixture, "harnesses", "codex", "bundle", "session-start.js"), "export {}\n");
    writeFileSync(join(fixture, "harnesses", "codex", "bundle", "capture.js"), "export {}\n");
    writeFileSync(join(fixture, "harnesses", "codex", "skills", "memoree-memory", "SKILL.md"), "# Memoree\n");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      PATH: "/usr/bin:/bin",
      MEMOREE_EMBEDDINGS: "false",
      MEMOREE_PACKAGE_ROOT: fixture,
    };
    delete env.MEMOREE_CONFIG_PATH;
    delete env.MEMOREE_BACKEND;
    delete env.MEMOREE_SQLITE_PATH;
    delete env.MEMOREE_PKG_HOME;
    const cli = join(repoRoot, "src", "cli", "index.ts");
    const output = execFileSync(process.execPath, ["--import", tsxLoader, cli, "install", "--no-embeddings"], {
      cwd: repoRoot,
      env,
      encoding: "utf-8",
    });
    expect(output).toContain("Harnesses: codex");
    expect(output).toContain("open /hooks and trust Memoree");
    expect(existsSync(join(root, ".codex", "memoree", "bundle", "session-start.js"))).toBe(true);
    expect(existsSync(join(root, ".claude"))).toBe(false);
  }, 30_000);

  it("fails closed when neither Claude Code nor Codex is detected", () => {
    const root = mkdtempSync(join(tmpdir(), "memoree-onboarding-none-"));
    roots.push(root);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      PATH: "/usr/bin:/bin",
      MEMOREE_EMBEDDINGS: "false",
    };
    delete env.MEMOREE_CONFIG_PATH;
    delete env.MEMOREE_BACKEND;
    delete env.MEMOREE_SQLITE_PATH;
    const cli = join(repoRoot, "src", "cli", "index.ts");
    const result = spawnSync(process.execPath, ["--import", tsxLoader, cli, "install", "--no-embeddings"], {
      cwd: repoRoot,
      env,
      encoding: "utf-8",
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).toMatch(/No Claude Code or Codex installation found/);
  }, 30_000);
});
