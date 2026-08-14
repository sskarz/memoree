import { tokenizePolicyCommand } from "../memory-path-utils.js";

export type CompatibilityBrokerParse =
  | { kind: "pass" }
  | { kind: "deny"; reason: string }
  | { kind: "run"; args: string[] };

const RULE_SUBCOMMANDS = new Set(["help", "--help", "-h", "add", "list", "edit", "done"]);
const GOAL_SUBCOMMANDS = new Set(["--help", "-h", "add", "list", "get", "done", "progress"]);
const KPI_SUBCOMMANDS = new Set(["--help", "-h", "add", "list", "bump"]);

function supported(args: string[]): boolean {
  const command = args[0];
  if (!command || command === "help" || command === "--help" || command === "-h" ||
      command === "version" || command === "--version" || command === "-v" ||
      command === "status" || command === "doctor" || command === "context") {
    return args.length <= 1;
  }
  if (command === "backend") {
    return args.length === 2 && (args[1] === "status" || args[1] === "check");
  }
  if (command === "rules") {
    return args.length === 1 || RULE_SUBCOMMANDS.has(args[1]);
  }
  if (command === "goal" || command === "goals") {
    return args.length === 1 || GOAL_SUBCOMMANDS.has(args[1]);
  }
  if (command === "kpi" || command === "kpis") {
    return args.length === 1 || KPI_SUBCOMMANDS.has(args[1]);
  }
  return false;
}

/** Parse only a directly-invoked, literal `memoree` command. */
export function parseCodexCompatibilityCommand(command: string): CompatibilityBrokerParse {
  const trimmed = command.trim();
  const direct = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*memoree(?:\s|$)/.test(trimmed);
  if (!direct) return { kind: "pass" };
  if (!/^memoree(?:\s|$)/.test(trimmed)) {
    return { kind: "deny", reason: "Memoree compatibility commands do not accept environment assignments." };
  }
  const tokens = tokenizePolicyCommand(trimmed);
  if (!tokens || tokens[0] !== "memoree" || tokens.includes(">")) {
    return { kind: "deny", reason: "Memoree compatibility commands must be one literal command without shell operators, redirects, or substitutions." };
  }
  const args = tokens.slice(1);
  return supported(args) ? { kind: "run", args } : { kind: "pass" };
}
