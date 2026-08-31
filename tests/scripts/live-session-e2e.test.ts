import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("live session e2e harness", () => {
  const source = readFileSync(new URL("../../scripts/live-session-e2e.mjs", import.meta.url), "utf8");

  it("runs Claude without --bare so plugin hooks fire unaided", () => {
    expect(source).toContain("claude");
    expect(source).toContain("--permission-mode");
    expect(source).not.toMatch(/["']--bare["']/);
    expect(source).not.toContain("--tools\", \"\"");
  });

  it("persists Codex sessions so Stop/wiki can capture", () => {
    expect(source).toContain("codex");
    expect(source).toContain("--dangerously-bypass-hook-trust");
    expect(source).not.toMatch(/["']--ephemeral["']/);
  });

  it("is wired as npm run live:e2e", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["live:e2e"]).toBe("node scripts/live-session-e2e.mjs");
  });

  it("keeps Memoree state on isolated HOME/DB paths", () => {
    expect(source).toContain("MEMOREE_SQLITE_PATH");
    expect(source).toContain("createValidationWorkspace");
    expect(source).toContain("inspectCaptureDatabase");
    expect(source).toContain("removeValidationWorkspace");
  });

  it("maps OPENAI_API_KEY onto CODEX_API_KEY for isolated Codex exec", () => {
    expect(source).toContain("authenticatedCodexEnvironment");
    expect(source).toContain("prepareCodexAuthentication");
  });
});
