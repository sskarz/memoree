import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearFakeHome, setFakeHome } from "../shared/fake-home.js";

const execFileSyncMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: (...args: unknown[]) => execFileSyncMock(...args) };
});

let fakeHome: string;
let fixtureRoot: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "memoree-supported-home-"));
  fixtureRoot = mkdtempSync(join(tmpdir(), "memoree-supported-runtime-"));
  setFakeHome(fakeHome);
  mkdirSync(join(fakeHome, ".claude"), { recursive: true });
  mkdirSync(join(fakeHome, ".codex"), { recursive: true });
  mkdirSync(join(fixtureRoot, "harnesses", "codex", "bundle"), { recursive: true });
  mkdirSync(join(fixtureRoot, "harnesses", "codex", "skills", "memoree-memory"), { recursive: true });
  writeFileSync(join(fixtureRoot, "harnesses", "codex", "bundle", "capture.js"), "capture-v1");
  writeFileSync(join(fixtureRoot, "harnesses", "codex", "skills", "memoree-memory", "SKILL.md"), "# Memoree");
  execFileSyncMock.mockReset();
  execFileSyncMock.mockReturnValue("");
  vi.resetModules();
});

afterEach(() => {
  clearFakeHome();
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("Claude Code and Codex install parity", () => {
  it("installs, upgrades, and uninstalls Codex idempotently while preserving user hooks", async () => {
    const module = await import("../../src/cli/install-codex.js");
    const hooksPath = join(fakeHome, ".codex", "hooks.json");
    writeFileSync(hooksPath, JSON.stringify({
      hooks: { Notification: [{ hooks: [{ type: "command", command: "/usr/local/bin/user-hook" }] }] },
    }));

    module.installCodex({ packageRoot: fixtureRoot });
    module.installCodex({ packageRoot: fixtureRoot });
    let hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
    expect(hooks.hooks.PostToolUse).toHaveLength(1);
    expect(hooks.hooks.Notification[0].hooks[0].command).toBe("/usr/local/bin/user-hook");
    expect(existsSync(join(fakeHome, ".agents", "skills", "memoree-memory"))).toBe(true);

    writeFileSync(join(fixtureRoot, "harnesses", "codex", "bundle", "capture.js"), "capture-v2");
    module.installCodex({ packageRoot: fixtureRoot });
    expect(readFileSync(join(fakeHome, ".codex", "memoree", "bundle", "capture.js"), "utf8"))
      .toBe("capture-v2");

    module.uninstallCodex();
    hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
    expect(hooks.hooks.Notification).toHaveLength(1);
    expect(hooks.hooks.PostToolUse).toBeUndefined();
    expect(existsSync(join(fakeHome, ".agents", "skills", "memoree-memory"))).toBe(false);
  });

  it("keeps the matching Claude marketplace, updates an installed plugin, and enables it", async () => {
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args.join(" ") === "plugin marketplace list") {
        return `Configured marketplaces:\n  ❯ memoree\n    Source: Directory (${fixtureRoot})\n`;
      }
      if (args.join(" ") === "plugin list") return "memoree@memoree\n";
      return "";
    });
    const { installClaude } = await import("../../src/cli/install-claude.js");
    installClaude({ source: fixtureRoot });
    const calls = execFileSyncMock.mock.calls.map(call => (call[1] as string[]).join(" "));
    expect(calls).toContain("plugin update memoree@memoree --scope user");
    expect(calls).toContain("plugin enable memoree@memoree --scope user");
    expect(calls.some(call => call.startsWith("plugin marketplace add"))).toBe(false);
  });

  it("repoints a stale Claude marketplace before updating the plugin", async () => {
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args.join(" ") === "plugin marketplace list") {
        return "  ❯ memoree\n    Source: Directory (/old/development/checkout)\n";
      }
      if (args.join(" ") === "plugin list") return "memoree@memoree\n";
      return "";
    });
    const { installClaude } = await import("../../src/cli/install-claude.js");
    installClaude({ source: fixtureRoot });
    const calls = execFileSyncMock.mock.calls.map(call => (call[1] as string[]).join(" "));
    expect(calls).toContain("plugin marketplace remove memoree");
    expect(calls).toContain(`plugin marketplace add ${fixtureRoot}`);
    expect(calls).toContain("plugin update memoree@memoree --scope user");
  });
});
