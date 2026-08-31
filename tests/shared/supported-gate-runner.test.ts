import { describe, expect, it } from "vitest";
import { buildArgs, findAgentBin, runGate, type Agent } from "../../src/skillify/gate-runner.js";

describe("supported gate runner", () => {
  it.each(["claude_code", "codex", "antigravity"] as Agent[])("resolves a fallback path for %s", agent => {
    expect(findAgentBin(agent)).toMatch(/[/\\]/);
  });

  it("builds Claude Code, Codex, and Antigravity invocations", () => {
    expect(buildArgs("claude_code", "prompt", { agent: "claude_code", prompt: "prompt" }))
      .toEqual(expect.arrayContaining(["-p", "prompt", "haiku"]));
    expect(buildArgs("codex", "prompt", { agent: "codex", prompt: "prompt" }))
      .toEqual(expect.arrayContaining(["exec", "prompt"]));
    expect(buildArgs("antigravity", "prompt", { agent: "antigravity", prompt: "prompt" }))
      .toEqual(expect.arrayContaining(["-p", "prompt", "--dangerously-skip-permissions"]));
  });

  it("returns a structured error for a missing binary", () => {
    expect(runGate({ agent: "codex", prompt: "prompt", bin: "/missing/memoree-codex" }))
      .toMatchObject({ errored: true, stdout: "" });
  });
});
