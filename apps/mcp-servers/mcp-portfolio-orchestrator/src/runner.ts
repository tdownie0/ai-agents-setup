/**
 * Round runner: executes one round's analyst pool, persisting every state
 * transition to the feature backend as it happens.
 *
 * Split out of `index.ts` so the execution logic is testable without an MCP
 * transport, and so the tool handler stays a thin control-plane shim.
 *
 * Every write goes through `RoundStore`, so progress survives the throwaway
 * per-call container the docker MCP gateway creates: if the client disconnects
 * mid-round, the work still completes and `get_round_status` still reports it.
 */

import { getPersona } from "@model_md/agent-orchestrator";
import { datasetPathFor } from "./agents.js";
import type { AgentJob } from "./agents.js";
import type { BackendClient } from "./backendClient.js";
import { runPool } from "./jobs.js";
import type { RoundStore } from "./roundStore.js";
import { deriveFinalStatus } from "./roundStore.js";
import { spawnAnalystViaDocker } from "./spawnViaDocker.js";
import type { OrchestratorConfig } from "./config.js";

export interface DatasetWire {
  schemaVersion: number;
  roundId: string;
  asOfTradeDate: string;
  generatedAt: string;
  universe: Array<{ symbol: string; hasData: boolean; latestClose: number | null }>;
}

export interface InsertRunWire {
  ok: boolean;
  agentRunId: number;
  positionsInserted: number;
}

export interface RunAgentsDeps {
  store: RoundStore;
  backend: BackendClient;
  config: OrchestratorConfig;
  /** Injectable for tests; defaults to the real docker exec spawner. */
  spawn?: typeof spawnAnalystViaDocker;
}

const nowIso = (): string => new Date().toISOString();

export async function runAgents(
  roundId: string,
  jobs: readonly AgentJob[],
  dataset: DatasetWire,
  deps: RunAgentsDeps,
): Promise<void> {
  const { store, backend, config } = deps;
  const spawn = deps.spawn ?? spawnAnalystViaDocker;

  await store.setRoundStatus(roundId, "running");

  const datasetPath = datasetPathFor(config.worktreeSlug, roundId);
  const universe = dataset.universe.map((entry) => entry.symbol);
  const symbolsWithPrice = new Set(
    dataset.universe
      .filter((entry) => entry.hasData && entry.latestClose !== null)
      .map((entry) => entry.symbol),
  );

  await runPool(jobs, config.maxParallel, async (job) => {
    await runOneAgent(roundId, job, {
      store,
      backend,
      config,
      spawn,
      dataset,
      datasetPath,
      universe,
      symbolsWithPrice,
    });
  });

  const state = await store.getRound(roundId);
  await store.setRoundStatus(roundId, deriveFinalStatus(state.agents));
}

interface RunOneContext {
  store: RoundStore;
  backend: BackendClient;
  config: OrchestratorConfig;
  spawn: typeof spawnAnalystViaDocker;
  dataset: DatasetWire;
  datasetPath: string;
  universe: string[];
  symbolsWithPrice: Set<string>;
}

async function runOneAgent(
  roundId: string,
  job: AgentJob,
  ctx: RunOneContext,
): Promise<void> {
  const { store, backend, config, spawn, dataset, datasetPath, universe, symbolsWithPrice } = ctx;

  try {
    await store.setAgentProgress(roundId, job.agentKey, {
      status: "running",
      startedAt: nowIso(),
    });
  } catch (err) {
    // A progress write failure must not abort the round: the analyst work and
    // the run insert are still worth attempting, and the round status will
    // record the shortfall via deriveFinalStatus.
    void err;
  }

  try {
    const persona = getPersona(job.personaKey);
    const spawned = await spawn({
      persona,
      agentKey: job.agentKey,
      roundId,
      datasetPath,
      asOfTradeDate: dataset.asOfTradeDate,
      initialCapital: config.capital,
      agentContainer: config.agentContainer,
      workdir: `/app/worktrees/${config.worktreeSlug}`,
      dockerHost: config.dockerHost,
      timeoutMs: config.timeoutMs,
      universe,
      symbolsWithPrice,
    });
    const inserted = await backend.post<InsertRunWire>("/api/portfolio/runs", {
      envelope: spawned.envelope,
    });
    await store.setAgentProgress(roundId, job.agentKey, {
      status: "inserted",
      runId: inserted.agentRunId,
      picks: spawned.envelope.picks.length,
      attempts: spawned.attempts,
      completedAt: nowIso(),
    });
  } catch (err) {
    await store.setAgentProgress(roundId, job.agentKey, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      completedAt: nowIso(),
    }).catch(() => undefined);
  }
}
