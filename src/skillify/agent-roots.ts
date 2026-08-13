import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Return the Codex skills root when Codex is installed. Claude Code's
 * ~/.claude/skills directory is the canonical source, so it is never returned
 * as a fan-out target.
 */
export function detectAgentSkillsRoots(
  canonicalRoot: string,
  home: string = homedir(),
): string[] {
  if (!existsSync(join(home, ".codex"))) return [];
  const codexRoot = join(home, ".agents", "skills");
  return codexRoot === canonicalRoot ? [] : [codexRoot];
}
