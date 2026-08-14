export const MEMORY_SANDBOXED_COMMANDS = [
  "cat",
  "ls",
  "grep",
  "head",
  "tail",
  "wc",
  "find",
  "jq",
  "echo",
  "printf",
  "tee",
  "mv",
  "rm",
] as const;

export const MEMORY_SANDBOXED_COMMAND_LIST = MEMORY_SANDBOXED_COMMANDS.join(", ");

export const MEMORY_COMMAND_GUIDANCE =
  `Supported sandboxed commands: ${MEMORY_SANDBOXED_COMMAND_LIST}. ` +
  "Reading and searching use cat, ls, grep, head, tail, wc, and find; writing is limited to echo, printf, and tee with narrowly validated redirects. " +
  "mv is limited to one rule-to-rule or goal-to-goal move with the same ID; rm is limited to one rule or goal file and performs a lifecycle transition, not a hard delete. " +
  "Use jq only for content known to be JSON; rendered session files ending in .jsonl are human-readable transcript views and are not guaranteed JSON. " +
  "Compound commands, shell substitutions, unsupported flags, globs for mv/rm, paths outside this virtual filesystem, interpreters, network clients, and command-executing find options such as -exec are denied.";
