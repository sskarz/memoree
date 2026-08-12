import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isMemoreePluginEnabled } from "../../src/utils/plugin-state.js";
import { setFakeHome, clearFakeHome } from "./fake-home.js";

// isMemoreePluginEnabled reads homedir() at call time, so patching
// process.env.HOME redirects it to a temp directory on each invocation.

function writeSettings(dir: string, content: object) {
  const claudeDir = join(dir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(content));
}

describe("isMemoreePluginEnabled", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "plugin-state-test-"));
    originalHome = process.env.HOME;
    setFakeHome(tmpDir);
  });

  afterEach(() => {
    clearFakeHome();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true when settings.json does not exist", () => {
    expect(isMemoreePluginEnabled()).toBe(true);
  });

  it("returns true when enabledPlugins does not mention memoree", () => {
    writeSettings(tmpDir, { enabledPlugins: { "other@plugin": true } });
    expect(isMemoreePluginEnabled()).toBe(true);
  });

  it("returns true when enabledPlugins[memoree@memoree] is true", () => {
    writeSettings(tmpDir, { enabledPlugins: { "memoree@memoree": true } });
    expect(isMemoreePluginEnabled()).toBe(true);
  });

  it("returns false when enabledPlugins[memoree@memoree] is false", () => {
    writeSettings(tmpDir, { enabledPlugins: { "memoree@memoree": false } });
    expect(isMemoreePluginEnabled()).toBe(false);
  });

  it("returns true (fail-open) when settings.json is corrupt", () => {
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude", "settings.json"), "{ not valid json }");
    expect(isMemoreePluginEnabled()).toBe(true);
  });
});
