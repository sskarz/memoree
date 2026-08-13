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
] as const;

export const MEMORY_SANDBOXED_COMMAND_LIST = MEMORY_SANDBOXED_COMMANDS.join(", ");

export const MEMORY_COMMAND_GUIDANCE =
  `Supported sandboxed commands: ${MEMORY_SANDBOXED_COMMAND_LIST}. ` +
  "Reading and searching use cat, ls, grep, head, tail, wc, and find; writing is limited to echo, printf, and tee with narrowly validated redirects. " +
  "Use jq only for content known to be JSON; rendered session files ending in .jsonl are human-readable transcript views and are not guaranteed JSON. " +
  "sed and awk are unavailable because their scripting features expand the security surface. " +
  "Interpreters, network clients, command substitution, and command-executing find options such as -exec are denied.";
