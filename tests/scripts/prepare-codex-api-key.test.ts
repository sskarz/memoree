import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = new URL("../../scripts/prepare-codex-api-key.sh", import.meta.url).pathname;
let home: string | undefined;

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

function runPrepare(env: NodeJS.ProcessEnv) {
  home = mkdtempSync(join(tmpdir(), "prepare-codex-"));
  return execFileSync("bash", [script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      MEMOREE_SKIP_CODEX_LOGIN: "1",
      ...env,
    },
  });
}

describe("prepare-codex-api-key.sh", () => {
  it("skips when no Platform key is present", () => {
    const stdout = runPrepare({ OPENAI_API_KEY: "", CODEX_API_KEY: "" });
    expect(stdout).toMatch(/skipping/);
  });

  it("copies OPENAI_API_KEY into the live env as CODEX_API_KEY", () => {
    runPrepare({
      OPENAI_API_KEY: "sk-test-openai",
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    const live = readFileSync(join(home!, ".config/memoree-live.env"), "utf8");
    expect(live).toContain("export OPENAI_API_KEY=sk-test-openai");
    expect(live).toContain("export CODEX_API_KEY=sk-test-openai");
    expect(live).toContain("export ANTHROPIC_API_KEY=sk-ant-test");
  });

  it("keeps an explicit CODEX_API_KEY instead of overwriting it", () => {
    runPrepare({
      OPENAI_API_KEY: "sk-test-openai",
      CODEX_API_KEY: "sk-test-codex",
    });
    const live = readFileSync(join(home!, ".config/memoree-live.env"), "utf8");
    expect(live).toContain("export CODEX_API_KEY=sk-test-codex");
    expect(live).toContain("export OPENAI_API_KEY=sk-test-openai");
  });
});
