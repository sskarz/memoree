import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

import { installClaude, uninstallClaude } from "../../src/cli/install-claude.js";

function commands(): string[] {
  return execFileSyncMock.mock.calls.map(([, args]) => (args as string[]).join(" "));
}

const currentMarketplace = () => `  ❯ memoree\n    Source: Directory (${process.cwd()})\n`;

beforeEach(() => {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
    if (args.join(" ") === "plugin marketplace list") return "";
    if (args.join(" ") === "plugin list") return "";
    return "ok";
  });
});

describe("local Claude Code installation", () => {
  it("registers the checkout and installs the user-scoped plugin in order", () => {
    installClaude();
    expect(commands()).toEqual([
      "--version",
      "plugin marketplace list",
      `plugin marketplace add ${process.cwd()}`,
      "plugin list",
      "plugin install memoree@memoree --scope user",
      "plugin enable memoree@memoree --scope user",
    ]);
  });

  it("is idempotent when marketplace and plugin are already present", () => {
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      if (args.join(" ") === "plugin marketplace list") return currentMarketplace();
      if (args.join(" ") === "plugin list") return "memoree@memoree enabled";
      return "ok";
    });
    installClaude();
    expect(commands()).toEqual([
      "--version",
      "plugin marketplace list",
      "plugin list",
      "plugin update memoree@memoree --scope user",
      "plugin enable memoree@memoree --scope user",
    ]);
  });

  it("treats Claude's already-enabled response as idempotent success", () => {
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const command = args.join(" ");
      if (args[0] === "--version") return "ok";
      if (command === "plugin marketplace list") return currentMarketplace();
      if (command === "plugin list") return "memoree@memoree enabled";
      if (command === "plugin enable memoree@memoree --scope user") {
        throw Object.assign(new Error("failed"), {
          stderr: 'Failed to enable plugin "memoree@memoree": Plugin "memoree@memoree" is already enabled at user scope',
        });
      }
      return "ok";
    });

    expect(() => installClaude()).not.toThrow();
  });

  it("fails with recovery guidance when Claude Code is absent", () => {
    execFileSyncMock.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(() => installClaude()).toThrow(/Claude Code CLI/);
  });

  it("fails when local marketplace registration fails", () => {
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === "--version") return "ok";
      if (args.join(" ") === "plugin marketplace list") return "";
      throw Object.assign(new Error("failed"), { stderr: "bad marketplace" });
    });
    expect(() => installClaude()).toThrow(/Failed to register local marketplace/);
  });

  it("fails when the plugin cannot be installed", () => {
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const command = args.join(" ");
      if (args[0] === "--version" || command === "plugin marketplace add " + process.cwd()) return "ok";
      if (command === "plugin marketplace list" || command === "plugin list") return "";
      if (command.startsWith("plugin install")) throw Object.assign(new Error("failed"), { stderr: "bad install" });
      return "ok";
    });
    expect(() => installClaude()).toThrow(/Failed to install Memoree plugin/);
  });

  it("fails when the installed plugin cannot be enabled", () => {
    execFileSyncMock.mockImplementation((_bin: string, args: string[]) => {
      const command = args.join(" ");
      if (args[0] === "--version") return "ok";
      if (command === "plugin marketplace list") return currentMarketplace();
      if (command === "plugin list") return "memoree@memoree disabled";
      if (command.startsWith("plugin enable")) throw Object.assign(new Error("failed"), { stderr: "bad enable" });
      return "ok";
    });
    expect(() => installClaude()).toThrow(/Failed to enable Memoree plugin/);
  });

  it("removes only the user-scoped local plugin", () => {
    uninstallClaude();
    expect(commands()).toEqual([
      "--version",
      "plugin disable memoree@memoree --scope user",
      "plugin uninstall memoree@memoree --scope user",
    ]);
  });
});
