import { describe, expect, it } from "vitest";
import {
  activeAgentProcesses,
  assertNoActiveAgentSessions,
  runtimePaths,
} from "../../scripts/runtime-manager.mjs";

describe("runtime manager safety", () => {
  it("detects Claude Code and Codex sessions without matching unrelated commands", () => {
    const processes = [
      " 101 /usr/local/bin/claude",
      " 102 /opt/codex exec --full-auto",
      " 106 node /opt/node_modules/@anthropic-ai/claude-code/dist/cli.js -p hello",
      " 103 node scripts/runtime-manager.mjs promote",
      " 104 code README.md",
      " 105 /Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper",
    ].join("\n");
    expect(activeAgentProcesses(processes, 999)).toEqual([
      "101 /usr/local/bin/claude",
      "102 /opt/codex exec --full-auto",
      "106 node /opt/node_modules/@anthropic-ai/claude-code/dist/cli.js -p hello",
    ]);
  });

  it("ignores persistent IDE app servers but still detects interactive Codex commands", () => {
    const processes = [
      " 201 /Users/test/.cursor/extensions/openai.chatgpt/bin/codex -c features.code_mode_host=true app-server --analytics-default-enabled",
      " 202 /Applications/Codex.app/Contents/Resources/codex app-server",
      " 203 /Applications/Codex.app/Contents/Resources/codex -c model=fast exec --ephemeral hello",
      " 204 node /usr/local/bin/codex resume 1234",
    ].join("\n");

    expect(activeAgentProcesses(processes, 999)).toEqual([
      "203 /Applications/Codex.app/Contents/Resources/codex -c model=fast exec --ephemeral hello",
      "204 node /usr/local/bin/codex resume 1234",
    ]);
  });

  it("refuses active sessions and never attempts to terminate them", () => {
    expect(() => assertNoActiveAgentSessions({
      processList: " 77 /usr/bin/codex\n",
      currentPid: 99,
    })).toThrow(/No processes were terminated/);
  });

  it("supports isolated test paths without changing production defaults", () => {
    const paths = runtimePaths({
      MEMOREE_RUNTIME_DIR: "/tmp/memoree-runtime-test",
      MEMOREE_RUNTIME_METADATA: "/tmp/memoree-runtime-state.json",
      MEMOREE_DEV_REPOSITORY: "/tmp/memoree-dev",
    });
    expect(paths).toEqual({
      runtimeDir: "/tmp/memoree-runtime-test",
      metadataPath: "/tmp/memoree-runtime-state.json",
      repository: "/tmp/memoree-dev",
    });
  });
});
