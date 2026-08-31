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
  it("initializes only ~/.memoree and registers the local Claude plugin", () => {
    const root = mkdtempSync(join(tmpdir(), "memoree-onboarding-"));
    roots.push(root);
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
    const cli = join(repoRoot, "src", "cli", "index.ts");
    const installOutput = execFileSync(process.execPath, ["--import", tsxLoader, cli, "install", "--no-embeddings"], {
      cwd: repoRoot,
      env,
      encoding: "utf-8",
    });
    expect(installOutput).toContain(`Database: ${join(root, ".memoree", "memoree.sqlite3")}`);
    expect(installOutput).toContain("memoree docs sync");
    expect(existsSync(join(root, ".memoree", "config.json"))).toBe(true);
    expect(existsSync(join(root, ".memoree", "memoree.sqlite3"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, ".memoree", "config.json"), "utf-8"))).toMatchObject({
      storage: { provider: "sqlite", sqlitePath: join(root, ".memoree", "memoree.sqlite3") },
      embeddings: { enabled: false },
    });
    expect(existsSync(join(root, ".codex"))).toBe(false);

    const commands = readFileSync(commandLog, "utf-8").trim().split("\n");
    expect(commands).toEqual([
      "--version",
      "plugin marketplace list",
      `plugin marketplace add ${repoRoot}`,
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
});
