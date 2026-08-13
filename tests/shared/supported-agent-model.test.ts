import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { agentModel, detectScorerAgent } from "../../src/skillify/agent-model.js";

function fakeSpawn(stdout: string, code = 0) {
  const calls: Array<{ args: string[]; env: Record<string, unknown> }> = [];
  const spawnImpl = (_bin: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ args, env: options.env as Record<string, unknown> });
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill(): void };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => { child.stdout.emit("data", stdout); child.emit("close", code); });
    return child as never;
  };
  return { calls, spawnImpl };
}

describe("supported agent model dispatch", () => {
  it("runs Claude Code without tools and unwraps JSON output", async () => {
    const fake = fakeSpawn(JSON.stringify({ result: "ok" }));
    const output = await agentModel({ agent: "claude_code", role: "judge", bin: "/x/claude", spawnImpl: fake.spawnImpl })("S", "U");
    expect(fake.calls[0].args).toContain("--strict-mcp-config");
    expect(fake.calls[0].args[fake.calls[0].args.indexOf("--tools") + 1]).toBe("");
    expect(fake.calls[0].env.MEMOREE_CAPTURE).toBe("false");
    expect(output).toBe("ok");
  });

  it("runs Codex in a read-only sandbox and honors model overrides", async () => {
    const fake = fakeSpawn("ok");
    await agentModel({
      agent: "codex",
      role: "judge",
      bin: "/x/codex",
      spawnImpl: fake.spawnImpl,
      env: { MEMOREE_SKILLOPT_CODEX_JUDGE_MODEL: "o3" } as NodeJS.ProcessEnv,
    })("S", "U");
    expect(fake.calls[0].args).toContain("read-only");
    expect(fake.calls[0].args).toContain("o3");
    expect(fake.calls[0].args.at(-1)).toBe("S\n\nU");
  });

  it("detects only supported scorer agents", () => {
    expect(detectScorerAgent({ MEMOREE_SKILLOPT_AGENT: "codex" } as never)).toBe("codex");
    expect(detectScorerAgent({ MEMOREE_SKILLOPT_AGENT: "unsupported", CLAUDECODE: "1" } as never)).toBe("claude_code");
  });
});
