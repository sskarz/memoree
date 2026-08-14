import { describe, expect, it, vi } from "vitest";
import { processPreToolUse } from "../../src/hooks/pre-tool-use.js";

const config = {
  userName: "alice", orgId: "local", orgName: "local", workspaceId: "default",
  storage: { kind: "sqlite" }, rulesTableName: "memoree_rules",
  goalsTableName: "memoree_goals", kpisTableName: "memoree_kpis",
} as any;

function input(command: string) {
  return { session_id: "s", tool_name: "Bash", tool_use_id: "t", tool_input: { command }, cwd: "/tmp" };
}

describe("Claude structured VFS routing", () => {
  it("routes goal reads and root searches through the authoritative shell", async () => {
    for (const command of [
      "cat ~/.memoree/memory/goal/alice/opened/g.md",
      "grep -r ship ~/.memoree/memory/",
      "ls ~/.memoree/memory/",
    ]) {
      const compiled = vi.fn(async () => "wrong");
      const decision = await processPreToolUse(input(command), {
        config, createApi: vi.fn(() => ({ query: vi.fn() })) as any,
        runVfsShellFn: vi.fn(() => ({ status: 0, stdout: "structured", stderr: "" })),
        executeCompiledBashCommandFn: compiled as any, logFn: vi.fn(),
      });
      expect(decision?.command).toContain("structured");
      expect(compiled).not.toHaveBeenCalled();
    }
  });

  it("preserves normal failure status and hides the executable fragment", async () => {
    const decision = await processPreToolUse(input("rm ~/.memoree/memory/goal/alice/opened/g.md"), {
      config, createApi: vi.fn(() => ({ query: vi.fn() })) as any,
      runVfsShellFn: vi.fn(() => ({ status: 5, stdout: "", stderr: "database locked\n" })), logFn: vi.fn(),
    });
    expect(decision?.command).toContain("database locked");
    expect(decision?.command).toContain("exit 5");
    expect(decision?.command).not.toContain("goal/alice");
  });

  it.each([
    "rm -r ~/.memoree/memory/goal/alice",
    "rm ~/.memoree/memory/kpi/g/k.md",
    "mv ~/.memoree/memory/goal/alice/opened/a.md ~/.memoree/memory/goal/alice/closed/b.md",
    "cat ~/.memoree/memory/rules.md /etc/passwd",
  ])("denies unsafe mutation syntax: %s", async command => {
    const decision = await processPreToolUse(input(command), { config, logFn: vi.fn() });
    expect(decision?.command).toContain("RETRY REQUIRED");
  });
});
