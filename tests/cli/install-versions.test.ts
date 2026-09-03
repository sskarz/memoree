import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatVersionReport, hookStampVersion, collectVersionReport, pathCliVersion, VERSION_PROBE_ENV } from "../../src/cli/install-versions.js";

type ExecFile = typeof execFileSync;

describe("formatVersionReport", () => {
  it("prints hook, PATH CLI, and active Claude plugin as distinct fields", () => {
    const text = formatVersionReport({
      hook: "0.7.153",
      pathCli: "0.7.145",
      claudeActive: "0.7.153",
    });
    expect(text).toMatch(/^memoree \d+\.\d+\.\d+/m);
    expect(text).toContain("hook stamp:     0.7.153");
    expect(text).toContain("PATH CLI:       0.7.145 ≠ hook stamp");
    expect(text).toContain("npx -y @sskarz/memoree install");
    expect(text).toContain("Claude plugin:  0.7.153 (active)");
  });

  it("omits the leftover-install warning when PATH matches the hook", () => {
    const text = formatVersionReport({
      hook: "0.7.153",
      pathCli: "0.7.153",
      claudeActive: null,
    });
    expect(text).toContain("PATH CLI:       0.7.153");
    expect(text).not.toContain("leftover npm -g");
  });

  it("says PATH CLI is missing when the binary is not on PATH", () => {
    const text = formatVersionReport({ hook: "0.7.153", pathCli: null, claudeActive: null });
    expect(text).toContain("PATH CLI:       (not on PATH)");
  });
});

describe("pathCliVersion", () => {
  it("returns null while the probe env is set (breaks recursion)", () => {
    const prev = process.env[VERSION_PROBE_ENV];
    process.env[VERSION_PROBE_ENV] = "1";
    try {
      expect(pathCliVersion(vi.fn() as never)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env[VERSION_PROBE_ENV];
      else process.env[VERSION_PROBE_ENV] = prev;
    }
  });

  it("parses the first semver from PATH memoree --version", () => {
    const execFile = vi.fn((_file: string, _args: string[], opts?: { env?: NodeJS.ProcessEnv; timeout?: number }) => {
      expect(opts?.env?.[VERSION_PROBE_ENV]).toBe("1");
      expect(opts?.timeout).toBe(3_000);
      return "memoree 0.7.145\n";
    });
    expect(pathCliVersion(execFile as unknown as ExecFile)).toBe("0.7.145");
  });

  it("returns null when PATH memoree cannot be executed", () => {
    const execFile = vi.fn(() => { throw new Error("not found"); });
    expect(pathCliVersion(execFile as never)).toBeNull();
  });
});

describe("hookStampVersion", () => {
  it("reads .memoree_version from the Codex plugin copy", () => {
    const home = mkdtempSync(join(tmpdir(), "memoree-hook-stamp-"));
    try {
      mkdirSync(join(home, ".codex", "memoree"), { recursive: true });
      writeFileSync(join(home, ".codex", "memoree", ".memoree_version"), "0.7.153\n");
      expect(hookStampVersion(home)).toBe("0.7.153");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns null when no plugin stamps exist", () => {
    const home = mkdtempSync(join(tmpdir(), "memoree-hook-stamp-empty-"));
    try {
      expect(hookStampVersion(home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("collectVersionReport", () => {
  it("reads the active Claude plugin from a fake home manifest", () => {
    const home = mkdtempSync(join(tmpdir(), "memoree-version-report-"));
    try {
      mkdirSync(join(home, ".codex", "memoree"), { recursive: true });
      writeFileSync(join(home, ".codex", "memoree", ".memoree_version"), "0.7.153");
      mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
      writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
        plugins: { "memoree@memoree": [{ version: "0.7.153" }] },
      }));
      const execFile = vi.fn(() => "0.7.145\n");
      const report = collectVersionReport(home, execFile as unknown as ExecFile);
      expect(report.hook).toBe("0.7.153");
      expect(report.pathCli).toBe("0.7.145");
      expect(report.claudeActive).toBe("0.7.153");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
