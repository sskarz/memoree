/**
 * Agent-dispatched ModelCall for the engine's LLM steps (success-judge, proposer).
 * Generalises the former claude-only claude-model.ts so a Codex
 * user — possibly with no `claude` on the machine — still gets SkillOpt. Mirrors
 * the wiki worker's per-agent dispatch, but with NO-TOOLS args: the scorer feeds
 * UNTRUSTED transcript text into the prompt, so each agent runs in its safest
 * tool-free / read-only mode (claude `--tools ""`, codex `-s read-only`, ...) so
 * prompt-injected transcript text can't trigger tool use.
 *
 * Output: the downstream parsers (parseVerdict→extractJson, parseEdits) pull the
 * JSON out of arbitrary text (fence-stripping + first/last bracket), so each agent
 * only has to emit the JSON SOMEWHERE in stdout — no per-agent output schema needed.
 * claude's `--output-format json` wraps the text in {result}, so we unwrap it;
 * every other agent prints raw.
 *
 * Cost lands on the USER (their own agent). `spawnImpl` is injectable so the
 * per-agent argv + parsing are unit-tested with zero real CLI calls.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { findAgentBin, type Agent } from "./gate-runner.js";
import { SKILLOPT_ENV, modelEnvNames } from "./skillopt-env.js";

export type ModelCall = (systemPrompt: string, userPrompt: string) => Promise<string>;
export type ScorerRole = "judge" | "proposer"; // judge = cheap/fast, proposer = capable

type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;

interface AgentDispatch {
  /** argv for a no-tools text completion; `system` folded into the prompt when the CLI has no system flag. */
  buildArgs: (model: string | undefined, provider: string | undefined, system: string, user: string) => string[];
  /** extract the model's text from stdout (claude wraps in {result}; everyone else prints raw). */
  parse: (stdout: string) => string;
  /** default model per role; undefined => let the agent use its own configured default. */
  model: (role: ScorerRole) => string | undefined;
  provider?: string;
}

const fold = (system: string, user: string) => `${system}\n\n${user}`;

const DISPATCH: Record<Agent, AgentDispatch> = {
  claude_code: {
    // --tools "" = empty allow-list = NO tools (authoritative over built-ins AND MCP);
    // --strict-mcp-config ignores user MCP entirely. The verified-safe no-tools path.
    buildArgs: (model, _p, system, user) => [
      "-p", user, "--model", model ?? "sonnet", "--no-session-persistence",
      "--output-format", "json", "--system-prompt", system,
      "--tools", "", "--strict-mcp-config",
    ],
    parse: (out) => { try { return String((JSON.parse(out) as { result?: unknown }).result ?? ""); } catch { return out; } },
    model: (role) => (role === "judge" ? "haiku" : "sonnet"),
  },
  codex: {
    // `-s read-only`: model-generated shell commands can't write/exec — the safest
    // codex-exec mode for untrusted prompt text. --skip-git-repo-check: the detached
    // worker isn't in a trusted git dir. No system-prompt flag → fold into the prompt.
    buildArgs: (model, _p, system, user) => [
      "exec", "--skip-git-repo-check", "-s", "read-only",
      ...(model ? ["-m", model] : []), fold(system, user),
    ],
    parse: (out) => out,
    model: () => undefined, // codex uses its configured default model
  },
};

/** Per-agent, per-role env override: MEMOREE_SKILLOPT_<AGENT>_<ROLE>_MODEL, then _<AGENT>_MODEL. */
function envModel(agent: Agent, role: ScorerRole, env: NodeJS.ProcessEnv): string | undefined {
  const [specific, fallback] = modelEnvNames(agent, role);
  return env[specific] ?? env[fallback];
}

export function agentModel(opts: {
  agent: Agent;
  role: ScorerRole;
  model?: string;
  provider?: string;
  timeoutMs?: number;
  bin?: string;
  spawnImpl?: SpawnFn;
  env?: NodeJS.ProcessEnv;
}): ModelCall {
  const env = opts.env ?? process.env;
  const d = DISPATCH[opts.agent];
  const modelOverride = opts.model ?? envModel(opts.agent, opts.role, env);
  const providerOverride = opts.provider;
  const model = modelOverride ?? d.model(opts.role);
  const provider = providerOverride ?? d.provider;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const spawnFn = opts.spawnImpl ?? (nodeSpawn as unknown as SpawnFn);
  const bin = opts.bin ?? findAgentBin(opts.agent);
  return (system, user) => new Promise<string>((resolve, reject) => {
    const args = d.buildArgs(model, provider, system, user);
    // MEMOREE_CAPTURE=false: these calls aren't real sessions. MEMOREE_WIKI_WORKER=1:
    // the spawned agent skips this package's SessionStart hook (no context injection /
    // auto-pull / recursive firing). Inherit the (possibly caller-scoped) `env` so scoped
    // creds/config reach the child too, not just the global process.env.
    const child = spawnFn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, MEMOREE_CAPTURE: "false", MEMOREE_WIKI_WORKER: "1" },
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${opts.agent} timed out`)); }, timeoutMs);
    child.stdout?.on("data", (x) => { out += String(x); });
    child.stderr?.on("data", (x) => { err += String(x); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${opts.agent} exit ${code}: ${err.slice(0, 200)}`));
      const text = d.parse(out);
      // Some agents exit 0 with EMPTY stdout while swallowing a provider error —
      // A failed agent invocation may write the error to a dump file
      // and prints nothing. Treat empty as a failure so a misconfigured scorer
      // surfaces loudly (the caller catches → safe no-op: judge stays conservative,
      // proposer reports a failed call) instead of silently resolving "" into an
      // "unparseable verdict" / no edits forever.
      if (!text.trim()) return reject(new Error(`${opts.agent} returned empty output (exit 0) — misconfigured provider/model?`));
      resolve(text);
    });
  });
}

/**
 * Resolve which agent the worker should score on. Explicit override wins
 * (MEMOREE_SKILLOPT_AGENT, set by a per-agent trigger/installer), then the env
 * signatures we can detect reliably, then claude_code as the default.
 */
export function detectScorerAgent(env: NodeJS.ProcessEnv = process.env): Agent {
  const explicit = env[SKILLOPT_ENV.AGENT];
  if (explicit && (["claude_code", "codex"] as const).includes(explicit as Agent)) {
    return explicit as Agent;
  }
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT) return "claude_code";
  if (env.CODEX_HOME || env.CODEX_SESSION_ID) return "codex";
  return "claude_code";
}
