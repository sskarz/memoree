import { describe, expect, it, vi } from "vitest";
import { Bash } from "just-bash";
import { parseCodexCompatibilityCommand } from "../../src/hooks/codex/compatibility-broker.js";
import { processCodexPreToolUse } from "../../src/hooks/codex/pre-tool-use.js";

function input(command: string) {
  return {
    session_id: "s",
    tool_name: "shell",
    tool_use_id: "t",
    tool_input: { command },
    cwd: "/tmp",
    hook_event_name: "pre_tool_use",
    model: "test",
  };
}

describe("Codex compatibility broker parser", () => {
  it.each([
    "memoree --help",
    "memoree --version",
    "memoree status",
    "memoree doctor",
    "memoree backend status",
    "memoree backend check",
    "memoree context",
    "memoree rules list --status all",
    "memoree rules add 'one literal rule'",
    "memoree rules edit rule-id \"new text\"",
    "memoree rules done rule-id",
    "memoree goal add 'ship safely'",
    "memoree goal list --mine",
    "memoree goal get goal-id",
    "memoree goal progress goal-id in_progress",
    "memoree goal done goal-id",
    "memoree kpi add goal-id tests 10 cases 'Test count'",
    "memoree kpi list goal-id",
    "memoree kpi bump goal-id tests -1",
  ])("accepts documented direct command: %s", command => {
    expect(parseCodexCompatibilityCommand(command).kind).toBe("run");
  });

  it("parses quoting into literal argv", () => {
    expect(parseCodexCompatibilityCommand("memoree goal add 'text with spaces'")).toEqual({
      kind: "run",
      args: ["goal", "add", "text with spaces"],
    });
  });

  it.each([
    "memoree rules list; touch /tmp/pwn",
    "memoree rules list && whoami",
    "memoree rules list > /tmp/out",
    "memoree rules add $(whoami)",
    "memoree rules add `whoami`",
    "MEMOREE_TABLE=x memoree rules list",
    "memoree rules add 'unterminated",
  ])("denies broker injection syntax: %s", command => {
    expect(parseCodexCompatibilityCommand(command).kind).toBe("deny");
  });

  it.each([
    "memoree install",
    "memoree uninstall",
    "memoree backend use sqlite",
    "memoree embeddings status",
    "memoree graph build",
    "memoree memory flush",
    "memoree sessions prune",
    "memoree skillify",
  ])("passes administrative command through for ordinary approval: %s", command => {
    expect(parseCodexCompatibilityCommand(command)).toEqual({ kind: "pass" });
  });
});

describe("Codex compatibility broker execution", () => {
  it("passes a literal argv array and preserves stdout, stderr, and status", async () => {
    const run = vi.fn(() => ({ status: 7, stdout: "partial\n", stderr: "failed\n" }));
    const decision = await processCodexPreToolUse(input("memoree rules list --status all"), {
      runCompatibilityCommandFn: run,
      logFn: vi.fn(),
    });
    expect(run).toHaveBeenCalledWith(["rules", "list", "--status", "all"]);
    expect(decision.action).toBe("allow");
    expect(decision.replacementCommand).not.toContain("rules list");
    const result = await new Bash().exec(decision.replacementCommand!);
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("partial\n");
    expect(result.stderr).toBe("failed\n");
  });

  it("caps broker output without exposing executable user fragments", async () => {
    const decision = await processCodexPreToolUse(input("memoree context"), {
      runCompatibilityCommandFn: vi.fn(() => ({ status: 0, stdout: "x".repeat(20_000), stderr: "" })),
      logFn: vi.fn(),
    });
    expect(Buffer.byteLength(decision.output ?? "", "utf-8")).toBeLessThanOrEqual(8 * 1024);
    expect(decision.replacementCommand).not.toContain("memoree context");
  });

  it("blocks malformed direct commands and passes unsupported administration", async () => {
    expect((await processCodexPreToolUse(input("memoree rules list; whoami"))).action).toBe("block");
    expect((await processCodexPreToolUse(input("memoree embeddings status"))).action).toBe("pass");
  });
});
