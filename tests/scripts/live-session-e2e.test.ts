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

  it("requires Antigravity to use MCP read/write/grep unaided", () => {
    expect(source).toContain("antigravityLivePrompt");
    expect(source).toContain("assertAntigravityLiveUsedMcp");
    expect(source).toContain("agyLiveId");
    expect(source).toContain("waitForCapture(databasePath, agyId");
  });

  it("proves Claude↔Codex↔Antigravity retrieve in the same isolated project", () => {
    expect(source).toContain("claudeLanternRecallPrompt");
    expect(source).toContain("catGraphQueryPrompt");
    expect(source).toContain("antigravityCrossAgentReadPrompt");
    expect(source).toContain("live Claude Codex-lantern recall");
    expect(source).toContain("live Codex graph query/store");
    expect(source).toContain("live Antigravity harbor-kite recall");
    expect(source).toContain("live Antigravity lantern recall");
    expect(source).toContain("live Claude Antigravity recall");
    expect(source).toContain("live Codex Antigravity recall");
    expect(source).toContain("Claude↔Codex↔Antigravity share");
  });

  it("pins unaided Claude and Codex turns to the cheap live models", () => {
    expect(source).toContain("claudeLiveCliArgs(");
    expect(source).toContain("codexExecLiveArgs(");
    expect(source).not.toMatch(/run\("claude",\s*\[/);
    expect(source).not.toMatch(/runCodex\(\[/);
    expect(source).toContain("live models:");
    expect(source).toContain("grepRecallPrompt(");
    expect(source.match(/grepRecallPrompt\("harbor kite", "~\/\.memoree\/memory\/"\)/g)).toHaveLength(2);
    expect(source).not.toMatch(/do not say none/i);
  });

  it("is wired as npm run live:e2e", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["live:e2e"]).toBe("node scripts/live-session-e2e.mjs");
  });

  it("retries the unaided Claude capture for every cheap-model attempt", () => {
    expect(source).toContain("claudeLiveAttempts");
    expect(source).toMatch(/attempt === claudeLiveAttempts - 1/);
    expect(source).not.toMatch(/if \(attempt === 1\) throw/);
  });

  it("does not glue the harbor-kite UUID to a trailing period (capture redaction)", () => {
    expect(source).not.toMatch(/\$\{harborId\}\./);
    expect(source).toContain("Harbor kite identifier:");
  });

  it("keeps Memoree state on isolated HOME/DB paths", () => {
    expect(source).toContain("MEMOREE_SQLITE_PATH");
    expect(source).toContain("createValidationWorkspace");
    expect(source).toContain("inspectCaptureDatabase");
    expect(source).toContain("removeValidationWorkspace");
  });
});
