import { homedir } from "node:os";
import { join } from "node:path";
import { classifyPath, decomposeGoalPath, decomposeRulePath } from "../shell/goal-paths.js";

export const MEMORY_PATH = join(homedir(), ".memoree", "memory");
export const TILDE_PATH = "~/.memoree/memory";
export const HOME_VAR_PATH = "$HOME/.memoree/memory";

export const SAFE_BUILTINS = new Set([
  "cat", "ls", "grep", "head", "tail", "wc", "find", "jq",
  "echo", "printf", "tee", "mv", "rm",
]);

// A quoted heredoc (`<<'EOF'` / `<<"EOF"`) disables shell expansion, so its
// body is inert literal data — a goal/KPI description, not commands. Drop the
// body and its closing delimiter so they are never validated as command stages
// or tripped over by the substitution guard. Unquoted heredocs keep their body
// (bash would expand it), so they still fall through to full validation.
function stripHeredocBodies(cmd: string): string {
  if (!cmd.includes("<<")) return cmd;
  const lines = cmd.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    kept.push(line);
    const heredoc = line.match(/<<-?\s*(['"])([A-Za-z_]\w*)\1/);
    if (!heredoc) continue;
    const delimiter = heredoc[2];
    const stripTabs = line.includes("<<-");
    while (i + 1 < lines.length) {
      const body = lines[++i];
      const probe = stripTabs ? body.replace(/^\t+/, "") : body;
      if (probe === delimiter) break;
    }
  }
  return kept.join("\n");
}

export function isSafe(cmd: string): boolean {
  if (/(?:^|\s)\d+>/.test(cmd)) return false;
  const tokens = tokenizePolicyCommand(cmd);
  if (!tokens || tokens.length === 0 || !SAFE_BUILTINS.has(tokens[0])) return false;
  const [program, ...args] = tokens;
  const isPath = (value: string): boolean =>
    value.startsWith("/") && !value.split("/").includes("..") && !value.includes("\0");
  const noRedirect = !args.includes(">");

  if (program === "cat") return noRedirect && args.length > 0 && args.every(isPath);
  if (program === "ls") {
    return noRedirect && args.every(arg => isPath(arg) || /^-[al]+$/.test(arg));
  }
  if (program === "head" || program === "tail") {
    if (!noRedirect || args.length === 0 || !isPath(args.at(-1)!)) return false;
    const flags = args.slice(0, -1);
    return flags.length === 0 ||
      (flags.length === 1 && /^-\d+$/.test(flags[0])) ||
      (flags.length === 2 && flags[0] === "-n" && /^\d+$/.test(flags[1]));
  }
  if (program === "wc") {
    return noRedirect && args.length >= 2 && args[0] === "-l" && args.slice(1).every(isPath);
  }
  if (program === "grep") {
    if (!noRedirect || args.length < 2) return false;
    let i = 0;
    while (i < args.length && args[i].startsWith("-")) {
      if (!/^-([rRinlcvwFEHh]+)$/.test(args[i])) return false;
      i++;
    }
    if (i >= args.length - 1) return false;
    return args.slice(i + 1).every(isPath);
  }
  if (program === "find") {
    if (!noRedirect || args.length < 3 || !isPath(args[0])) return false;
    let i = 1;
    if (args[i] === "-type") {
      if (args[i + 1] !== "f") return false;
      i += 2;
    }
    return args.length === i + 2 && args[i] === "-name" && args[i + 1].length > 0;
  }
  if (program === "jq") {
    return noRedirect && args.length === 2 && isPath(args[1]);
  }
  if (program === "echo" || program === "printf") {
    const redirect = args.indexOf(">");
    return redirect > 0 && redirect === args.length - 2 && isPath(args[redirect + 1]);
  }
  if (program === "tee") {
    return noRedirect && (args.length === 1 || (args.length === 2 && args[0] === "-a")) && isPath(args.at(-1)!);
  }
  if (program === "rm") {
    return noRedirect && args.length === 1 && !/[?*\[]/.test(args[0]) &&
      (classifyPath(args[0]) === "rule" || classifyPath(args[0]) === "goal");
  }
  if (program === "mv") {
    if (!noRedirect || args.length !== 2 || args.some(arg => /[?*\[]/.test(arg))) return false;
    const fromKind = classifyPath(args[0]);
    const toKind = classifyPath(args[1]);
    if (fromKind === "rule" && toKind === "rule") {
      return decomposeRulePath(args[0]).rule_id === decomposeRulePath(args[1]).rule_id;
    }
    if (fromKind === "goal" && toKind === "goal") {
      return decomposeGoalPath(args[0]).goal_id === decomposeGoalPath(args[1]).goal_id;
    }
    return false;
  }
  return false;
}

/** Tokenize one literal command while rejecting every shell execution feature. */
export function tokenizePolicyCommand(cmd: string): string[] | null {
  if (!cmd.trim() || /\r|\n|\$\(|`|<\(|\$\{|\$'/.test(cmd)) return null;
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  const push = () => {
    if (current.length > 0) tokens.push(current);
    current = "";
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") { quote = ch; continue; }
    if (/\s/.test(ch)) { push(); continue; }
    if (ch === ">") {
      if (cmd[i + 1] === ">") return null;
      push();
      tokens.push(">");
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "<") return null;
    current += ch;
  }
  if (quote || escaped) return null;
  push();
  return tokens;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A mount prefix only counts when it is the mount root or a descendant — i.e.
// followed by `/`, end-of-string, or a non-path character. Matching it as a
// bare substring false-positives on siblings like `~/.memoree/memory-backup/x`
// and on literals like `grep "~/.memoree/memory" README.md`.
const MEMORY_BOUNDARY = "(?![A-Za-z0-9._-])";
const MEMORY_PREFIX_RE = new RegExp(
  "(?:" + [MEMORY_PATH, TILDE_PATH, HOME_VAR_PATH].map(escapeRe).join("|") + ")" + MEMORY_BOUNDARY,
);

export function touchesMemory(p: string): boolean {
  return MEMORY_PREFIX_RE.test(p);
}

export function rewritePaths(cmd: string): string {
  // Consume a trailing slash if present, otherwise require a boundary so a
  // sibling like `memory-backup` is left untouched.
  const tail = "(?:\\/|" + MEMORY_BOUNDARY + ")";
  return cmd
    .replace(new RegExp(escapeRe(MEMORY_PATH) + tail, "g"), "/")
    .replace(new RegExp(escapeRe(TILDE_PATH) + tail, "g"), "/")
    .replace(new RegExp('"' + escapeRe(HOME_VAR_PATH) + tail + '"', "g"), '"/"')
    .replace(new RegExp(escapeRe(HOME_VAR_PATH) + tail, "g"), "/");
}

export function shouldRouteThroughStructuredVfs(rewrittenCommand: string): boolean {
  const tokens = tokenizePolicyCommand(rewrittenCommand);
  if (!tokens || tokens.length === 0) return false;
  const structured = (token: string): boolean =>
    token === "/identity.json" || token === "/rules.md" || token === "/goals.md" ||
    token === "/rules" || token.startsWith("/rules/") ||
    token === "/goal" || token.startsWith("/goal/") ||
    token === "/kpi" || token.startsWith("/kpi/");
  if (tokens.some(structured)) return true;
  return (tokens[0] === "ls" || tokens[0] === "find" || tokens[0] === "grep") &&
    tokens.includes("/");
}

export function commandTouchesOutsideMemoryPath(command: string): boolean {
  const tokens = tokenizePolicyCommand(command);
  if (!tokens || tokens.length === 0) return false;
  const [program, ...args] = tokens;
  let candidates: string[] = [];
  if (program === "cat" || program === "mv" || program === "rm") candidates = args;
  else if (program === "ls") candidates = args.filter(arg => !arg.startsWith("-"));
  else if (program === "head" || program === "tail" || program === "jq" || program === "tee") candidates = args.slice(-1);
  else if (program === "wc") candidates = args.slice(1);
  else if (program === "find") candidates = args.slice(0, 1);
  else if (program === "grep") candidates = args.slice(-1);
  else if (program === "echo" || program === "printf") {
    const redirect = args.indexOf(">");
    if (redirect >= 0) candidates = args.slice(redirect + 1);
  }
  return candidates.some(token =>
    (token.startsWith("/") || token.startsWith("~") || token.startsWith("$HOME")) && !touchesMemory(token),
  );
}

// Split a bash command into pipe/chain stages, each an argv array, respecting
// quotes and escapes. `>`/`>>` are emitted as their own tokens.
export function parseBashTokens(cmd: string): string[][] {
  const stages: string[][] = [];
  let currentStage: string[] = [];
  let currentToken = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  const pushToken = () => {
    if (currentToken.length > 0) { currentStage.push(currentToken); currentToken = ""; }
  };
  const pushStage = () => {
    pushToken();
    if (currentStage.length > 0) { stages.push(currentStage); currentStage = []; }
  };

  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i];

    if (escape) { currentToken += char; escape = false; continue; } // prev char was `\`
    // Backslash is literal inside single quotes (bash semantics) — treating it
    // as an escape there would swallow the closing quote and hide a following
    // `; cmd …` stage inside the quoted token.
    if (char === "\\" && !inSingle) { escape = true; currentToken += char; continue; }
    if (char === "'" && !inDouble) { inSingle = !inSingle; currentToken += char; continue; } // keep quotes
    if (char === '"' && !inSingle) { inDouble = !inDouble; currentToken += char; continue; }

    if (!inSingle && !inDouble) { // separators only act outside quotes
      if (char === "\n" || char === ";") { pushStage(); continue; }
      if (char === "|") { if (cmd[i + 1] === "|") i++; pushStage(); continue; } // `|` / `||`
      if (char === "&" && cmd[i + 1] === "&") { i++; pushStage(); continue; }   // `&&`
      if (char === ">") { // own token, so `>file` (no space) is detectable
        pushToken();
        if (cmd[i + 1] === ">") { currentStage.push(">>"); i++; } else currentStage.push(">");
        continue;
      }
      if (char === "<") { // own token, so `<file` (no space) is detectable;
        pushToken();      // `<<`/`<<<` (heredoc/herestring) lump into one token
        let run = "<";    // so only a lone `<` reads a file path
        while (cmd[i + 1] === "<" && run.length < 3) { run += "<"; i++; }
        currentStage.push(run);
        continue;
      }
      if (/\s/.test(char)) { pushToken(); continue; }
    }

    currentToken += char;
  }

  pushStage();
  return stages;
}

// echo/printf print their args; `claude -p` takes a natural-language prompt —
// a memory path in their arguments is inert text (the #87 false positive).
// Interpreters (python/node/ruby/…) and fetchers (curl) are deliberately NOT
// here: they execute/read their args, so a memory path is a real interaction.
const PASSTHROUGH_COMMANDS = new Set(["echo", "printf", "claude"]);

export function bashTouchesMemory(cmd: string): boolean {
  // Substitutions — $(), backticks, <(…) — run on the host no matter whose
  // argv they sit in, and isSafe() (which rejects them) only runs AFTER this
  // function returns true. So they get no carve-out: any memory mention next
  // to one is intercepted and lands on the guidance/deny path downstream.
  if (/\$\(|`|<\(/.test(cmd) && touchesMemory(cmd)) return true;

  const stages = parseBashTokens(stripHeredocBodies(cmd));

  for (const stage of stages) {
    if (stage.length === 0) continue;
    const program = stage[0].replace(/^["']|["']$/g, "");

    // A redirection on a memory path is a real interaction regardless of the
    // command: `>`/`>>` writes (the documented `echo '<content>' > '<path>'`
    // path), `<` reads (`claude -p 'summarize' < '<path>'`) — always intercept.
    for (let i = 0; i < stage.length; i++) {
      if ((stage[i] === ">" || stage[i] === ">>" || stage[i] === "<")
          && i + 1 < stage.length && touchesMemory(stage[i + 1])) {
        return true;
      }
    }

    // echo/printf/claude with the path as inert text → skip this stage
    // (substitution smuggling is already handled above).
    if (PASSTHROUGH_COMMANDS.has(program)) {
      continue;
    }

    // Default (builtins, interpreters, fetchers, anything else): a memory path
    // in ANY token is a real interaction → intercept. getShellCommand()/isSafe()
    // decide route-to-VFS vs retry-guidance downstream.
    for (const token of stage) {
      if (touchesMemory(token)) return true;
    }
  }
  return false;
}
