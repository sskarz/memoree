/**
 * Single source of truth for the `memoree skillify ...` command list.
 *
 * Two parallel views of the same data live here:
 *
 *   1. `SKILLIFY_COMMANDS` — flat one-line-per-entry. Consumed by the
 *      Claude Code and Codex SessionStart inject blocks and bundle-scan
 *      tests that assert specific subcommand strings appear verbatim in the
 *      shipped JS. Kept as a literal array (not derived) so esbuild preserves
 *      every entry as a string literal in the bundle.
 *
 *   2. `SKILLIFY_SPEC` — hierarchical (subcommand → options → note). Consumed
 *      by `renderCliHelpBlock()` (used by `memoree --help` in src/cli/index.ts)
 *      and `renderSubcommandUsageBlock()` (used by `memoree skillify --help`
 *      in src/commands/skillify.ts). Modelling options/notes as structured
 *      data is what makes the 2-column / sub-block help layouts feasible
 *      from a single source.
 *
 * A self-drift test (tests/cli/skillify-spec-self-drift.test.ts) asserts the
 * two views agree: every (subcommand, option) pair in `SKILLIFY_SPEC` must
 * appear as a corresponding flat entry in `SKILLIFY_COMMANDS`, and vice
 * versa.
 *
 * Shipped SKILL.md files (Claude Code and Codex) remain hand-typed for
 * now — they need a build-step generator because Markdown can't import TS
 * at runtime. Tracked in issue #175.
 */

/** Flat one-entry-per-line shape consumed by SessionStart inject blocks. */
export interface SkillifyCommand {
  /** The full command form as it appears in the injection text. */
  cmd: string;
  /** One-line description, dash-separated from `cmd` in the rendered block. */
  desc: string;
}

export const SKILLIFY_COMMANDS: SkillifyCommand[] = [
  { cmd: "memoree skillify",                            desc: "show scope, team, install, per-project state" },
  { cmd: "memoree skillify pull",                       desc: "sync project skills from the org table to local FS" },
  { cmd: "memoree skillify pull --user <email>",        desc: "only skills authored by that user" },
  { cmd: "memoree skillify pull --users <a,b,c>",       desc: "only skills from those authors" },
  { cmd: "memoree skillify pull --all-users",           desc: 'explicit "no author filter" (default)' },
  { cmd: "memoree skillify pull --to <project|global>", desc: "install location (project=cwd/.claude/skills, global=~/.claude/skills)" },
  { cmd: "memoree skillify pull --dry-run",             desc: "preview without touching disk" },
  { cmd: "memoree skillify pull --force",               desc: "overwrite local files even if up-to-date (creates .bak)" },
  { cmd: "memoree skillify pull <skill-name>",          desc: "pull only that one skill (combines with --user)" },
  { cmd: "memoree skillify push <skill-name>",          desc: "upload a local skill to the org table (inverse of pull)" },
  { cmd: "memoree skillify push --from <project|global>", desc: "which local skills dir to read (default: project)" },
  { cmd: "memoree skillify push --dry-run",             desc: "preview without writing to the org table" },
  { cmd: "memoree skillify unpull",                     desc: "remove every skill previously installed by pull" },
  { cmd: "memoree skillify unpull --user <email>",      desc: "remove only that author's pulls" },
  { cmd: "memoree skillify unpull --not-mine",          desc: "remove all pulls except your own" },
  { cmd: "memoree skillify unpull --dry-run",           desc: "preview without touching disk" },
  { cmd: "memoree skillify scope <me|team|org>",        desc: "sharing scope for newly mined skills" },
  { cmd: "memoree skillify install <project|global>",   desc: "default install location for new skills" },
  { cmd: "memoree skillify promote <skill-name>",       desc: "move a project skill to the global location" },
  { cmd: "memoree skillify team add|remove|list <name>", desc: "manage team member list" },
  { cmd: "memoree skillify mine-local",                 desc: "one-shot: mine skills from local sessions (no auth needed)" },
  { cmd: "memoree skillify mine-local --n <num|all>",   desc: "how many sessions to mine (default: 8)" },
  { cmd: "memoree skillify mine-local --force",         desc: "re-run even if the manifest sentinel exists" },
  { cmd: "memoree skillify mine-local --dry-run",       desc: "stop before calling the LLM gate" },
  { cmd: "memoree skillify hygiene",                    desc: "curate the local skill shelf (merge, shrink, archive Memoree-managed skills)" },
  { cmd: "memoree skillify hygiene --dry-run",          desc: "print the hygiene plan without writing" },
  { cmd: "memoree skillify hygiene --force",            desc: "run even if the 24h quiet period has not elapsed" },
];

/** A single flag-style option attached to a subcommand. */
export interface SkillifyOption {
  flag: string;
  desc: string;
}

/** A skillify subcommand with structured options + optional extra note. */
export interface SkillifySubcommand {
  /** Full command without positional args, e.g. "memoree skillify pull". */
  cmd: string;
  /** Optional positional args appended to `cmd` in renderings, e.g. "<skill-name>". */
  args?: string;
  /** One-line summary. */
  desc: string;
  /** Flag-style options. */
  options?: SkillifyOption[];
  /** Optional extra paragraph rendered only by `renderCliHelpBlock`. */
  note?: string;
}

/**
 * Hierarchical view consumed by the two CLI help renderers. Self-drift
 * test ensures every (sub.cmd + option.flag) pair has a matching flat
 * entry in `SKILLIFY_COMMANDS` above.
 */
export const SKILLIFY_SPEC: SkillifySubcommand[] = [
  {
    cmd: "memoree skillify",
    desc: "show scope, team, install, per-project state",
  },
  {
    cmd: "memoree skillify pull",
    desc: "sync project skills from the org table to local FS",
    options: [
      { flag: "--user <email>",          desc: "only skills authored by that user" },
      { flag: "--users <a,b,c>",         desc: "only skills from those authors" },
      { flag: "--all-users",             desc: 'explicit "no author filter" (default)' },
      { flag: "--to <project|global>",   desc: "install location (project=cwd/.claude/skills, global=~/.claude/skills)" },
      { flag: "--dry-run",               desc: "preview without touching disk" },
      { flag: "--force",                 desc: "overwrite local files even if up-to-date (creates .bak)" },
      { flag: "<skill-name>",            desc: "pull only that one skill (combines with --user)" },
    ],
    note: "every agent's SessionStart hook auto-runs 'pull --all-users --to global' on every session. File writes are idempotent (skipped when local is at-or-newer than remote). Disable via MEMOREE_AUTOPULL_DISABLED=1.",
  },
  {
    cmd: "memoree skillify push",
    args: "<skill-name>",
    desc: "upload a local skill to the org table (inverse of pull)",
    options: [
      { flag: "--from <project|global>", desc: "which local skills dir to read (default: project)" },
      { flag: "--dry-run",               desc: "preview without writing to the org table" },
    ],
    note: "the manual counterpart to mining — push a skill Claude wrote locally straight to the org table (append-only: re-pushing an existing skill lands a new version). Authorship/lineage is preserved; you're added as a contributor.",
  },
  {
    cmd: "memoree skillify unpull",
    desc: "remove every skill previously installed by pull",
    options: [
      { flag: "--user <email>",          desc: "remove only that author's pulls" },
      { flag: "--not-mine",              desc: "remove all pulls except your own" },
      { flag: "--dry-run",               desc: "preview without touching disk" },
    ],
  },
  {
    cmd: "memoree skillify scope",
    args: "<me|team|org>",
    desc: "sharing scope for newly mined skills",
  },
  {
    cmd: "memoree skillify install",
    args: "<project|global>",
    desc: "default install location for new skills",
  },
  {
    cmd: "memoree skillify promote",
    args: "<skill-name>",
    desc: "move a project skill to the global location",
  },
  {
    cmd: "memoree skillify team add|remove|list",
    args: "<name>",
    desc: "manage team member list",
  },
  {
    cmd: "memoree skillify mine-local",
    desc: "one-shot: mine skills from local sessions (no auth needed)",
    options: [
      { flag: "--n <num|all>",           desc: "how many sessions to mine (default: 8)" },
      { flag: "--force",                 desc: "re-run even if the manifest sentinel exists" },
      { flag: "--dry-run",               desc: "stop before calling the LLM gate" },
    ],
  },
  {
    cmd: "memoree skillify hygiene",
    desc: "curate the local skill shelf (merge, shrink, archive Memoree-managed skills)",
    options: [
      { flag: "--dry-run", desc: "print the hygiene plan without writing" },
      { flag: "--force",   desc: "run even if the 24h quiet period has not elapsed" },
    ],
    note: "only skills with Memoree frontmatter (created_by_agent or source_sessions) are in scope. Hand-written SKILL.md files are never deleted. SessionStart may spawn this at most once per 24h.",
  },
];

/**
 * Render the command list as a dash-bulleted block suitable for embedding
 * in a SessionStart context literal. Padding width is computed from the
 * longest `cmd` so the dashes line up across rows.
 */
export function renderSkillifyCommands(): string {
  const maxLen = Math.max(...SKILLIFY_COMMANDS.map(c => c.cmd.length));
  return SKILLIFY_COMMANDS
    .map(c => `- ${c.cmd.padEnd(maxLen + 2)} — ${c.desc}`)
    .join("\n");
}

/**
 * Render the block consumed by `memoree --help` (src/cli/index.ts).
 * 2-column layout: command on the left, description on the right; options
 * folded inline as `Options: --x, --y, --z.`; optional `note` follows as a
 * wrapped paragraph at the same indent.
 *
 * Callers prepend their own section header (e.g. "Skill management ...").
 */
export function renderCliHelpBlock(): string {
  const INDENT = "  ";
  const CMD_COL_WIDTH = 42;
  const lines: string[] = [];
  for (const sub of SKILLIFY_SPEC) {
    const left = sub.args ? `${sub.cmd} ${sub.args}` : sub.cmd;
    // padEnd does nothing if `left` already exceeds CMD_COL_WIDTH, which
    // glues the description onto the command. Always force at least two
    // spaces between left and right columns so long entries stay readable.
    const padded = left.length >= CMD_COL_WIDTH ? `${left}  ` : left.padEnd(CMD_COL_WIDTH);
    lines.push(`${INDENT}${padded}${capitalize(sub.desc)}.`);
    if (sub.options && sub.options.length > 0) {
      const optsList = sub.options.map(o => o.flag).join(", ");
      lines.push(`${INDENT}${" ".repeat(CMD_COL_WIDTH)}Options: ${optsList}.`);
    }
    if (sub.note) {
      const noteWrapped = wrapAt(`Note: ${sub.note}`, 72);
      for (const noteLine of noteWrapped) {
        lines.push(`${INDENT}${" ".repeat(CMD_COL_WIDTH)}${noteLine}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Render the block consumed by `memoree skillify --help` (the `usage()`
 * function in src/commands/skillify.ts). Indented per subcommand with each
 * option on its own indented sub-line.
 *
 * Callers prepend "Usage:" themselves.
 */
export function renderSubcommandUsageBlock(): string {
  const INDENT = "  ";
  const SUB_INDENT = "    ";
  const FLAG_INDENT = "      ";
  const CMD_COL_WIDTH = 44;
  const FLAG_COL_WIDTH = 26;
  const lines: string[] = [];
  for (const sub of SKILLIFY_SPEC) {
    const left = sub.args ? `${sub.cmd} ${sub.args}` : sub.cmd;
    // Same gap-protection as in renderCliHelpBlock — long entries (e.g.
    // "memoree skillify team add|remove|list <name>") must still have a
    // visible separation from their description.
    const padded = left.length >= CMD_COL_WIDTH ? `${left}  ` : left.padEnd(CMD_COL_WIDTH);
    lines.push(`${INDENT}${padded}${sub.desc}`);
    if (sub.options && sub.options.length > 0) {
      const tail = sub.cmd.split(" ").slice(-1)[0];
      lines.push(`${SUB_INDENT}Options for ${tail}:`);
      for (const opt of sub.options) {
        const flagPadded = opt.flag.length >= FLAG_COL_WIDTH ? `${opt.flag}  ` : opt.flag.padEnd(FLAG_COL_WIDTH);
        lines.push(`${FLAG_INDENT}${flagPadded}${opt.desc}`);
      }
    }
  }
  return lines.join("\n");
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function wrapAt(s: string, max: number): string[] {
  const words = s.split(/\s+/);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur.length === 0) {
      cur = w;
    } else if (cur.length + 1 + w.length > max) {
      out.push(cur);
      cur = w;
    } else {
      cur += " " + w;
    }
  }
  if (cur) out.push(cur);
  return out;
}
