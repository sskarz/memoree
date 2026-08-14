import { describe, expect, it, vi } from "vitest";
import { processCodexPreToolUse } from "../../src/hooks/codex/pre-tool-use.js";

const config = {
  userName: "alice", orgId: "local", orgName: "local", workspaceId: "default",
  storage: { kind: "sqlite" }, rulesTableName: "memoree_rules",
  goalsTableName: "memoree_goals", kpisTableName: "memoree_kpis",
} as any;

function input(command: string) {
  return {
    session_id: "s", tool_name: "shell", tool_use_id: "t",
    tool_input: { command }, cwd: "/tmp", hook_event_name: "pre_tool_use", model: "test",
  };
}

describe("Codex structured VFS routing", () => {
  it.each([
    "cat ~/.memoree/memory/identity.json",
    "cat ~/.memoree/memory/rules.md",
    "cat ~/.memoree/memory/goals.md",
    "cat ~/.memoree/memory/goal/alice/opened/g.md",
    "grep -r ship ~/.memoree/memory/",
    "find ~/.memoree/memory/ -name '*.md'",
    "ls ~/.memoree/memory/",
  ])("routes before generic fast paths: %s", async command => {
    const runVfsShellFn = vi.fn(() => ({ status: 0, stdout: "structured result", stderr: "" }));
    const compiled = vi.fn(async () => "wrong");
    const decision = await processCodexPreToolUse(input(command), {
      config, createApi: vi.fn(() => ({ query: vi.fn() })) as any,
      runVfsShellFn, executeCompiledBashCommandFn: compiled as any, logFn: vi.fn(),
    });
    expect(decision.action).toBe("allow");
    expect(decision.output).toContain("structured result");
    expect(runVfsShellFn).toHaveBeenCalled();
    expect(compiled).not.toHaveBeenCalled();
  });

  it("returns a missing structured path as an ordinary nonzero command failure", async () => {
    const decision = await processCodexPreToolUse(input("cat ~/.memoree/memory/rules/active/missing.md"), {
      config, createApi: vi.fn(() => ({ query: vi.fn() })) as any,
      runVfsShellFn: vi.fn(() => ({ status: 1, stdout: "", stderr: "missing: No such file or directory\n" })),
      logFn: vi.fn(),
    });
    expect(decision.action).toBe("allow");
    expect(decision.replacementCommand).toContain("exit 1");
    expect(decision.output).not.toContain("denied");
  });

  it.each([
    "mv ~/.memoree/memory/rules/active/r.md ~/.memoree/memory/rules/done/r.md",
    "mv ~/.memoree/memory/goal/alice/opened/g.md ~/.memoree/memory/goal/bob/in_progress/g.md",
    "rm ~/.memoree/memory/rules/active/r.md",
    "rm ~/.memoree/memory/goal/alice/opened/g.md",
  ])("handles a narrow mutation without exposing it to the host: %s", async command => {
    const decision = await processCodexPreToolUse(input(command), {
      config, createApi: vi.fn(() => ({ query: vi.fn() })) as any,
      runVfsShellFn: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })), logFn: vi.fn(),
    });
    expect(decision.action).toBe("allow");
    expect(decision.replacementCommand).not.toContain(".memoree");
    expect(decision.replacementCommand).not.toContain("rules/active");
    expect(decision.replacementCommand).not.toContain("goal/alice");
  });

  it.each([
    "rm -rf ~/.memoree/memory/rules",
    "rm ~/.memoree/memory/kpi/g/k.md",
    "rm ~/.memoree/memory/rules/active/*.md",
    "mv ~/.memoree/memory/rules/active/a.md ~/.memoree/memory/rules/done/b.md",
    "mv ~/.memoree/memory/goal/alice/opened/g.md ~/.memoree/memory/kpi/g/k.md",
    "cat ~/.memoree/memory/rules.md /etc/passwd",
  ])("blocks unsafe mutation syntax: %s", async command => {
    expect((await processCodexPreToolUse(input(command), { config, logFn: vi.fn() })).action).toBe("block");
  });
});
