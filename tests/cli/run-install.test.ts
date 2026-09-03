import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { initializeStorage, installPlatform, runInstall } from "../../src/cli/run-install.js";
import type { InstallRuntime } from "../../src/cli/run-install.js";
import type { PlatformId } from "../../src/cli/util.js";

function runtime(overrides: Partial<InstallRuntime> = {}): Partial<InstallRuntime> {
  return {
    stagePackage: () => "/durable/pkg",
    packageRootForInstall: () => "/npx/extract",
    detectPlatforms: () => [{ id: "claude", markerDir: "/home/.claude" }],
    claudeCliAvailable: () => true,
    codexBundleExists: () => true,
    antigravityBundleExists: () => true,
    installClaude: vi.fn(),
    installCodex: vi.fn(),
    installAntigravity: vi.fn(),
    initializeStorage: async () => "/home/.memoree/memoree.sqlite3",
    installEmbeddings: vi.fn(),
    preloadEmbeddingModel: async () => undefined,
    writeUserConfig: vi.fn(),
    docsHintShown: () => true,
    docsInstallLines: () => ["Docs hint"],
    markDocsHintShown: vi.fn(),
    log: () => undefined,
    warn: () => undefined,
    ...overrides,
  };
}

describe("runInstall", () => {
  it("stages first, then wires every detected harness from the durable copy", async () => {
    const installClaude = vi.fn();
    const installCodex = vi.fn();
    const deps = runtime({
      detectPlatforms: () => [
        { id: "claude", markerDir: "/home/.claude" },
        { id: "codex", markerDir: "/home/.codex" },
      ],
      installClaude,
      installCodex,
    });
    const result = await runInstall(["--all"], deps);
    expect(result.stagedRoot).toBe("/durable/pkg");
    expect(result.wired).toEqual<PlatformId[]>(["claude", "codex"]);
    expect(installClaude).toHaveBeenCalledWith({ source: "/durable/pkg" });
    expect(installCodex).toHaveBeenCalledWith({ packageRoot: "/durable/pkg" });
    expect(installClaude.mock.invocationCallOrder[0]).toBeLessThan(installCodex.mock.invocationCallOrder[0]);
  });

  it("installs Codex when Claude is absent", async () => {
    const installClaude = vi.fn();
    const installCodex = vi.fn();
    const result = await runInstall(["--no-embeddings"], runtime({
      detectPlatforms: () => [{ id: "codex", markerDir: "/home/.codex" }],
      installClaude,
      installCodex,
    }));
    expect(result.wired).toEqual(["codex"]);
    expect(installClaude).not.toHaveBeenCalled();
    expect(installCodex).toHaveBeenCalledOnce();
  });

  it("skips Claude when the CLI is missing and still wires Codex", async () => {
    const warns: string[] = [];
    const installClaude = vi.fn();
    const result = await runInstall(["--no-embeddings"], runtime({
      detectPlatforms: () => [
        { id: "claude", markerDir: "/home/.claude" },
        { id: "codex", markerDir: "/home/.codex" },
      ],
      claudeCliAvailable: () => false,
      installClaude,
      warn: line => { warns.push(line); },
    }));
    expect(result.wired).toEqual(["codex"]);
    expect(installClaude).not.toHaveBeenCalled();
    expect(warns.some(line => line.includes("claude CLI not found"))).toBe(true);
  });

  it("throws when no harness marker is present", async () => {
    await expect(runInstall(["--no-embeddings"], runtime({
      detectPlatforms: () => [],
    }))).rejects.toThrow(/No Claude Code, Codex, or Antigravity installation found/);
  });

  it("throws when every detected harness is skipped", async () => {
    await expect(runInstall(["--no-embeddings"], runtime({
      detectPlatforms: () => [{ id: "claude", markerDir: "/home/.claude" }],
      claudeCliAvailable: () => false,
    }))).rejects.toThrow(/Failed to wire any harness/);
  });

  it("skips Codex when the staged bundle is missing", async () => {
    const installCodex = vi.fn();
    const result = await runInstall(["--no-embeddings"], runtime({
      detectPlatforms: () => [
        { id: "claude", markerDir: "/home/.claude" },
        { id: "codex", markerDir: "/home/.codex" },
      ],
      codexBundleExists: () => false,
      installCodex,
    }));
    expect(result.wired).toEqual(["claude"]);
    expect(installCodex).not.toHaveBeenCalled();
  });

  it("does not preload embeddings when --no-embeddings is set", async () => {
    const installEmbeddings = vi.fn();
    const preloadEmbeddingModel = vi.fn(async () => undefined);
    const writeUserConfig = vi.fn();
    await runInstall(["--no-embeddings"], runtime({
      installEmbeddings,
      preloadEmbeddingModel,
      writeUserConfig,
    }));
    expect(writeUserConfig).toHaveBeenCalledWith({ embeddings: { enabled: false } });
    expect(installEmbeddings).not.toHaveBeenCalled();
    expect(preloadEmbeddingModel).not.toHaveBeenCalled();
  });

  it("installs embeddings by default", async () => {
    const installEmbeddings = vi.fn();
    const preloadEmbeddingModel = vi.fn(async () => undefined);
    const writeUserConfig = vi.fn();
    const result = await runInstall([], runtime({
      installEmbeddings,
      preloadEmbeddingModel,
      writeUserConfig,
    }));
    expect(result.embeddingsEnabled).toBe(true);
    expect(writeUserConfig).toHaveBeenCalledWith({ embeddings: { enabled: true } });
    expect(installEmbeddings).toHaveBeenCalledTimes(2);
    expect(installEmbeddings).toHaveBeenCalledWith({ quietNoInstalls: true });
    expect(preloadEmbeddingModel).toHaveBeenCalledOnce();
  });

  it("relinks embeddings after harness wiring so a new Claude cache version is linked", async () => {
    const installEmbeddings = vi.fn();
    const installClaude = vi.fn();
    const preloadEmbeddingModel = vi.fn(async () => undefined);
    await runInstall([], runtime({
      installEmbeddings,
      installClaude,
      preloadEmbeddingModel,
    }));
    expect(installEmbeddings).toHaveBeenCalledTimes(2);
    expect(installEmbeddings.mock.invocationCallOrder[0]).toBeLessThan(installClaude.mock.invocationCallOrder[0]);
    expect(installClaude.mock.invocationCallOrder[0]).toBeLessThan(installEmbeddings.mock.invocationCallOrder[1]);
  });

  it("wraps embedding preload failures", async () => {
    await expect(runInstall([], runtime({
      preloadEmbeddingModel: async () => { throw new Error("no model"); },
    }))).rejects.toThrow(/Embedding initialization failed: no model/);
  });

  it("prints docs hint once and Codex trust next-steps", async () => {
    const logs: string[] = [];
    const markDocsHintShown = vi.fn();
    await runInstall(["--no-embeddings"], runtime({
      detectPlatforms: () => [
        { id: "claude", markerDir: "/home/.claude" },
        { id: "codex", markerDir: "/home/.codex" },
      ],
      docsHintShown: () => false,
      docsInstallLines: () => ["Docs (optional)"],
      markDocsHintShown,
      log: line => { logs.push(line); },
    }));
    expect(logs).toContain("Docs (optional)");
    expect(logs).toContain("Restart Claude Code to activate Memoree.");
    expect(logs).toContain("Restart Codex, then open /hooks and trust Memoree so its hooks can run.");
    expect(logs).toContain("Then run `npx @sskarz/memoree doctor`.");
    expect(markDocsHintShown).toHaveBeenCalledOnce();
  });

  it("installs Antigravity when it is the only detected harness", async () => {
    const installAntigravity = vi.fn();
    const result = await runInstall(["--no-embeddings"], runtime({
      detectPlatforms: () => [{ id: "antigravity", markerDir: "/home/.gemini" }],
      installAntigravity,
    }));
    expect(result.wired).toEqual(["antigravity"]);
    expect(installAntigravity).toHaveBeenCalledWith({ packageRoot: "/durable/pkg" });
  });

  it("skips Antigravity when the staged bundle is missing", async () => {
    const installAntigravity = vi.fn();
    const result = await runInstall(["--no-embeddings"], runtime({
      detectPlatforms: () => [
        { id: "claude", markerDir: "/home/.claude" },
        { id: "antigravity", markerDir: "/home/.gemini" },
      ],
      antigravityBundleExists: () => false,
      installAntigravity,
    }));
    expect(result.wired).toEqual(["claude"]);
    expect(installAntigravity).not.toHaveBeenCalled();
  });

  it("prints Antigravity restart next-steps", async () => {
    const logs: string[] = [];
    await runInstall(["--no-embeddings"], runtime({
      detectPlatforms: () => [{ id: "antigravity", markerDir: "/home/.gemini" }],
      docsHintShown: () => true,
      log: line => { logs.push(line); },
    }));
    expect(logs).toContain("Restart Antigravity (IDE and/or `agy`) so Memoree MCP tools and hooks load.");
  });
});

describe("installPlatform", () => {
  it("stages then installs Claude from the durable copy", () => {
    const installClaude = vi.fn();
    const installCodex = vi.fn();
    installPlatform("claude", runtime({ installClaude, installCodex }));
    expect(installClaude).toHaveBeenCalledWith({ source: "/durable/pkg" });
    expect(installCodex).not.toHaveBeenCalled();
  });

  it("stages then installs Codex from the durable copy", () => {
    const installCodex = vi.fn();
    installPlatform("codex", runtime({ installCodex }));
    expect(installCodex).toHaveBeenCalledWith({ packageRoot: "/durable/pkg" });
  });

  it("stages then installs Antigravity from the durable copy", () => {
    const installAntigravity = vi.fn();
    installPlatform("antigravity", runtime({ installAntigravity }));
    expect(installAntigravity).toHaveBeenCalledWith({ packageRoot: "/durable/pkg" });
  });
});

describe("initializeStorage", () => {
  it("creates an isolated sqlite database from the test env", async () => {
    const location = await initializeStorage();
    expect(location).toMatch(/memoree\.sqlite3$/);
    expect(existsSync(location)).toBe(true);
  });
});
