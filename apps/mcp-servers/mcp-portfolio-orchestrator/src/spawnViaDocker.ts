/**
 * Analyst subagent spawner over `docker exec opencode_agent`.
 *
 * Mirrors the orchestrator's spawnAnalyst semantics exactly (same prompt
 * builder, same parse/validate pipeline, same one-retry-with-correction-hint
 * loop) but runs the analyst inside the shared opencode_agent container:
 *   docker exec -e XDG_STATE_HOME=... -e XDG_CACHE_HOME=... -w <workdir>
 *     opencode_agent opencode run --format json "<prompt>"
 *
 * Each subagent gets its own XDG state/cache dirs under
 * /home/devuser/.local/state|.cache/agents/<roundId>/<agentKey> so parallel
 * analysts never clobber each other's session state.
 */

import { spawn } from "node:child_process";
import {
  buildAnalystPrompt,
  DEFAULT_AGENT_TIMEOUT_MS,
  extractJsonFromText,
  formatFailureHint,
  parseAnalystOutput,
  SpawnAnalystError,
  validateEnvelope,
} from "@model_md/agent-orchestrator";
import type {
  AnalystPersona,
  AnalystWindow,
  DecisionEnvelope,
  DecisionHolding,
  SpawnAnalystResult,
  ValidateEnvelopeOptions,
} from "@model_md/agent-orchestrator";

export interface SpawnViaDockerOptions extends ValidateEnvelopeOptions {
  persona: AnalystPersona;
  /** The rebalance window this run is assigned; injected into the prompt. */
  window: AnalystWindow;
  agentKey: string;
  roundId: string;
  /** Dataset path AS VISIBLE INSIDE the agent container. */
  datasetPath: string;
  asOfTradeDate: string;
  /**
   * Total value the target weights apply to (cash + open positions at
   * asOfTradeDate). Not `initialCapital`: from round 2 on the weights apply to
   * a marked-up book, so the capital the stream started with is a different
   * number. Mirrors `SpawnAnalystOptions` in the orchestrator library.
   */
  portfolioValue: number;
  /** The stream's carried book. Empty on a stream's first round. */
  holdings?: readonly DecisionHolding[];
  /**
   * Chain position and cash split for the prompt. Omitting these makes
   * `buildAnalystPrompt` fall back to `roundSeq=1`, which the booking
   * cross-check on the run insert then rejects for any chained round past the
   * first — so they must come from the launch booking, never be assumed.
   */
  roundSeq?: number;
  /**
   * The simulation the launch booked this round under (from the booking row,
   * not the body). Must be forwarded to the prompt: without it the prompt falls
   * back to `sim-baseline` and the backend's anti-drift check rejects every
   * envelope against the booked simulation. Undefined means a standalone round.
   */
  simulationId?: string;
  priorRoundId?: string | null;
  cash?: number;
  holdingsValue?: number;
  replicateOf?: string;
  /** The AI CLI container holding the opencode binary (default opencode_agent). */
  agentContainer: string;
  /** Workdir inside the container, e.g. /app/worktrees/<slug>. */
  workdir: string;
  dockerHost?: string;
  timeoutMs?: number;
}

/** Per-subagent XDG dirs so concurrent analysts stay isolated. */
export function buildAgentStateDirs(
  roundId: string,
  agentKey: string,
): { state: string; cache: string } {
  return {
    state: `/home/devuser/.local/state/agents/${roundId}/${agentKey}`,
    cache: `/home/devuser/.cache/agents/${roundId}/${agentKey}`,
  };
}

export function buildDockerExecArgs(opts: {
  agentContainer: string;
  workdir: string;
  roundId: string;
  agentKey: string;
  prompt: string;
}): string[] {
  const { state, cache } = buildAgentStateDirs(opts.roundId, opts.agentKey);
  return [
    "exec",
    "-e",
    `XDG_STATE_HOME=${state}`,
    "-e",
    `XDG_CACHE_HOME=${cache}`,
    "-w",
    opts.workdir,
    opts.agentContainer,
    "opencode",
    "run",
    "--format",
    "json",
    opts.prompt,
  ];
}

export interface DockerExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Spawn `docker ...`, collect stdout/stderr, enforce a timeout. */
export function runDockerExec(
  args: readonly string[],
  opts: { dockerHost?: string; timeoutMs?: number },
): Promise<DockerExecResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    const env = opts.dockerHost ? { ...process.env, DOCKER_HOST: opts.dockerHost } : process.env;
    const child = spawn("docker", [...args], {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(() =>
        rejectPromise(
          new SpawnAnalystError(
            `docker exec timed out after ${Math.round(timeoutMs / 1000)}s`,
            1,
            stderr,
          ),
        ),
      );
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      settle(() =>
        rejectPromise(
          new SpawnAnalystError(
            `Failed to spawn "docker": ${err.message}. Is the docker CLI available?`,
            1,
            "",
          ),
        ),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      settle(() => resolvePromise({ stdout, stderr, code }));
    });
  });
}

export type ExecImpl = (
  args: readonly string[],
  opts: { dockerHost?: string; timeoutMs: number },
) => Promise<DockerExecResult>;

/**
 * Run ONE analyst inside the agent container: exec opencode, parse +
 * validate the envelope, retry once with a correction hint on failure.
 * `exec` is injectable for tests.
 */
export async function spawnAnalystWithExec(
  opts: SpawnViaDockerOptions,
  exec: ExecImpl,
): Promise<SpawnAnalystResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const maxAttempts = 2;

  let lastFailure: unknown = null;
  let lastStderr = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const prompt = buildAnalystPrompt({
      persona: opts.persona,
      window: opts.window,
      agentKey: opts.agentKey,
      roundId: opts.roundId,
      datasetPath: opts.datasetPath,
      asOfTradeDate: opts.asOfTradeDate,
      portfolioValue: opts.portfolioValue,
      holdings: opts.holdings,
      roundSeq: opts.roundSeq,
      simulationId: opts.simulationId,
      priorRoundId: opts.priorRoundId,
      cash: opts.cash,
      holdingsValue: opts.holdingsValue,
      replicateOf: opts.replicateOf,
      correctionHint:
        attempt > 1 && lastFailure !== null ? formatFailureHint(lastFailure) : undefined,
    });

    const result = await exec(
      buildDockerExecArgs({
        agentContainer: opts.agentContainer,
        workdir: opts.workdir,
        roundId: opts.roundId,
        agentKey: opts.agentKey,
        prompt,
      }),
      { dockerHost: opts.dockerHost, timeoutMs },
    );
    lastStderr = result.stderr;

    if (result.code !== 0) {
      lastFailure = new Error(
        `docker exec exited with code ${result.code}${result.stderr ? `: ${result.stderr.trim().slice(0, 500)}` : ""}`,
      );
      if (attempt === maxAttempts) {
        throw new SpawnAnalystError(
          `Analyst "${opts.agentKey}" failed after ${maxAttempts} attempts: ${(lastFailure as Error).message}`,
          maxAttempts,
          lastStderr,
        );
      }
      continue;
    }

    try {
      const text = parseAnalystOutput(result.stdout);
      const parsed = extractJsonFromText(text);
      const envelope = validateEnvelope(parsed, {
        universe: opts.universe,
        symbolsWithPrice: opts.symbolsWithPrice,
        heldSymbols: opts.heldSymbols,
        expectedWindow: opts.window,
      });
      return { envelope, rawOutput: result.stdout, attempts: attempt };
    } catch (err) {
      lastFailure = err;
      if (attempt === maxAttempts) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new SpawnAnalystError(
          `Analyst "${opts.agentKey}" failed after ${maxAttempts} attempts: ${detail}`,
          maxAttempts,
          lastStderr,
        );
      }
    }
  }

  throw new SpawnAnalystError(
    `Analyst "${opts.agentKey}" failed unexpectedly`,
    maxAttempts,
    lastStderr,
  );
}

export async function spawnAnalystViaDocker(
  opts: SpawnViaDockerOptions,
): Promise<SpawnAnalystResult> {
  return spawnAnalystWithExec(opts, runDockerExec);
}

export type { DecisionEnvelope };
