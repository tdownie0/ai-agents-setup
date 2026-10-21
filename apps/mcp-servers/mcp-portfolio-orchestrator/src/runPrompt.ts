/**
 * Blind, tool-less LLM completion inside the opencode_agent container.
 *
 * Used by the backend's process judge / prompt critic: a single `opencode run
 * --pure` against a restricted config (no tools, no MCP, no plugins) so the
 * model cannot inspect the repo or call anything — it only answers the prompt.
 * Each call gets its own XDG state/cache dirs under
 * /home/devuser/.local/state|.cache/prompts/<runKey> so concurrent prompts
 * never clobber each other, and OPENCODE_CONFIG points at the restricted
 * judge config instead of the agent's normal one.
 */

import { randomUUID } from "node:crypto";
import { parseAnalystOutput } from "@model_md/agent-orchestrator";
import { runDockerExec } from "./spawnViaDocker.js";
import type { ExecImpl } from "./spawnViaDocker.js";

export const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;

/** Appended to the user text on the retry when JSON was requested but missing. */
export const JSON_ONLY_SUFFIX = "\n\nIMPORTANT: Reply with ONLY a single JSON object and no prose.";

/**
 * Name of the tool-less agent defined in infra/opencode.judge.json.
 *
 * The judge uses a dedicated agent (no tools, `steps: 1`) so the model can only
 * answer in text. Two permission shapes MUST NOT appear in that config: the
 * opencode.ai free tier answers them with HTTP 403 "OpenCode's free tier can
 * only be used from within OpenCode":
 *   - `permission: { "*": "deny" }` — the wildcard also denies the
 *     session-level `question`/`plan_enter`/`plan_exit` permissions.
 *   - `permission: { read: "deny" }` — denying `read` alone trips the same gate.
 * Denying the remaining tools one by one is accepted.
 */
export const DEFAULT_JUDGE_AGENT = "judge";

export interface RunPromptInput {
  system: string;
  user: string;
  model?: string;
  timeoutMs?: number;
  expectJson?: boolean;
}

export interface RunPromptConfig {
  agentContainer: string;
  /** Restricted opencode config path as visible inside the agent container. */
  judgeConfigPath: string;
  /** Default model when input.model is omitted. */
  model: string;
  /** Default per-attempt timeout when input.timeoutMs is omitted. */
  timeoutMs: number;
  /** Agent to run from the judge config; defaults to the tool-less judge agent. */
  judgeAgent?: string;
  dockerHost?: string;
}

/** Per-call XDG dirs so concurrent prompts stay isolated. */
export function buildPromptStateDirs(runKey: string): { state: string; cache: string } {
  return {
    state: `/home/devuser/.local/state/prompts/${runKey}`,
    cache: `/home/devuser/.cache/prompts/${runKey}`,
  };
}

export function buildRunPromptArgs(opts: {
  agentContainer: string;
  judgeConfigPath: string;
  model: string;
  runKey: string;
  prompt: string;
  judgeAgent?: string;
}): string[] {
  const { state, cache } = buildPromptStateDirs(opts.runKey);
  return [
    "exec",
    "-e",
    `XDG_STATE_HOME=${state}`,
    "-e",
    `XDG_CACHE_HOME=${cache}`,
    "-e",
    `OPENCODE_CONFIG=${opts.judgeConfigPath}`,
    "-w",
    "/tmp",
    opts.agentContainer,
    "opencode",
    "run",
    "--pure",
    "--agent",
    opts.judgeAgent ?? DEFAULT_JUDGE_AGENT,
    "--format",
    "json",
    "-m",
    opts.model,
    opts.prompt,
  ];
}

/** True when the text contains at least one JSON object `{...}`. */
export function containsJsonObject(text: string): boolean {
  return /\{[\s\S]*\}/.test(text);
}

/**
 * Run ONE blind completion: exec opencode, extract the last text event, retry
 * once when the exec fails (exit code != 0) or the reply lacks a JSON object
 * (only when expectJson). Throws on failure — callers decide how to surface
 * the error. `exec` is injectable for tests.
 */
export async function runPromptWithExec(
  input: RunPromptInput,
  cfg: RunPromptConfig,
  exec: ExecImpl,
): Promise<{ text: string; attempts: number }> {
  const model = input.model ?? cfg.model;
  const timeoutMs = input.timeoutMs ?? cfg.timeoutMs;
  const expectJson = input.expectJson ?? true;
  const runKey = randomUUID();
  const maxAttempts = 2;

  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const user = attempt > 1 ? `${input.user}${JSON_ONLY_SUFFIX}` : input.user;
    const prompt = `${input.system}\n\n${user}`;

    let stdout: string;
    let stderr: string;
    let code: number | null;
    try {
      ({ stdout, stderr, code } = await exec(
        buildRunPromptArgs({
          agentContainer: cfg.agentContainer,
          judgeConfigPath: cfg.judgeConfigPath,
          model,
          runKey,
          prompt,
          judgeAgent: cfg.judgeAgent,
        }),
        { dockerHost: cfg.dockerHost, timeoutMs },
      ));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`run_prompt failed: ${detail}`);
    }

    const stderrSnippet = stderr.trim().slice(0, 500);

    if (code !== 0) {
      lastError = `docker exec exited with code ${code}${stderrSnippet ? `: ${stderrSnippet}` : ""}`;
      if (attempt === maxAttempts) break;
      continue;
    }

    let text: string;
    try {
      text = parseAnalystOutput(stdout);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === maxAttempts) break;
      continue;
    }

    if (expectJson && !containsJsonObject(text)) {
      lastError = "response contains no JSON object";
      if (attempt === maxAttempts) break;
      continue;
    }

    return { text, attempts: attempt };
  }

  throw new Error(`run_prompt failed after ${maxAttempts} attempts: ${lastError}`);
}

export async function runPrompt(
  input: RunPromptInput,
  cfg: RunPromptConfig,
): Promise<{ text: string; attempts: number }> {
  return runPromptWithExec(input, cfg, runDockerExec);
}
