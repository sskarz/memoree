import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Bash } from "just-bash";
import { CODEX_AGENTS_BLOCK } from "../../src/cli/install-codex.js";
import { buildUnsupportedGuidance } from "../../src/hooks/codex/pre-tool-use.js";
import { MEMORY_RETRY_GUIDANCE } from "../../src/hooks/pre-tool-use.js";
import { CLAUDE_MEMORY_CONTEXT } from "../../src/hooks/session-start.js";
import {
  MEMORY_COMMAND_GUIDANCE,
  MEMORY_SANDBOXED_COMMAND_LIST,
} from "../../src/hooks/shared/memory-command-contract.js";
import {
  safeFailureReplacement,
  safeStdoutReplacement,
} from "../../src/hooks/shared/shell-replacement.js";

const repoRoot = process.cwd();

describe("Memoree public sandboxed-command contract", () => {
  it("uses one curated command list and identical guidance across every user-facing surface", () => {
    expect(MEMORY_SANDBOXED_COMMAND_LIST).toBe(
      "cat, ls, grep, head, tail, wc, find, jq, echo, printf, tee, mv, rm",
    );

    const surfaces = [
      CODEX_AGENTS_BLOCK,
      CLAUDE_MEMORY_CONTEXT,
      MEMORY_RETRY_GUIDANCE,
      buildUnsupportedGuidance(),
      readFileSync(join(repoRoot, "harnesses/codex/skills/memoree-memory/SKILL.md"), "utf8"),
      readFileSync(join(repoRoot, "harnesses/claude-code/skills/memoree-memory/SKILL.md"), "utf8"),
    ];

    for (const surface of surfaces) {
      expect(surface).toContain(MEMORY_COMMAND_GUIDANCE);
      expect(surface).toContain("not guaranteed JSON");
      expect(surface).toContain("Compound commands");
    }
  });

  it("runs jq on known JSON and fails normally on a rendered transcript view", async () => {
    const shell = new Bash({
      files: {
        "/memory/valid.json": JSON.stringify({ items: [1, 2, 3] }),
        "/memory/sessions/rendered.jsonl": "[user] hello\n[assistant] hi\n",
      },
    });

    const valid = await shell.exec("cat /memory/valid.json | jq '.items | length'");
    expect(valid.exitCode).toBe(0);
    expect(valid.stdout.trim()).toBe("3");
    expect(valid.stderr).toBe("");

    const invalid = await shell.exec("cat /memory/sessions/rendered.jsonl | jq '.items'");
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).not.toBe("");
  });

  it("builds literal success and bounded nonzero failure replacements", () => {
    expect(safeStdoutReplacement("it's 100% `$HOME`")).toBe(
      `printf '%s\\n' 'it'\\''s 100% \`$HOME\`'`,
    );
    expect(safeFailureReplacement("", null)).toBe("exit 1");
    expect(safeFailureReplacement("", 0)).toBe("exit 1");
    expect(safeFailureReplacement("", 126)).toBe("exit 126");
    expect(safeFailureReplacement("bad\n", 2, "partial\n")).toBe(
      "printf '%s' 'partial\n'; printf '%s' 'bad\n' >&2; exit 2",
    );
  });
});
