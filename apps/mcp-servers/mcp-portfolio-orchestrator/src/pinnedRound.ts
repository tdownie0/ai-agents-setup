/**
 * One pinned round of a walk-forward replay: build the dataset for a single
 * as-of date, book the round, and run its due streams.
 *
 * This is the same flow as `start_agent_round`, factored out so the replay can
 * drive it once per due date. The launch gate is authoritative: only the streams
 * it leaves `pending` are spawned, and the admitted chain position is read back
 * from the launch response rather than assumed.
 */

import { datasetPathFor } from "./agents.js";
import type { AgentJob } from "./agents.js";
import type { BackendClient } from "./backendClient.js";
import { createBookLoader } from "./bookLoader.js";
import type { OrchestratorConfig } from "./config.js";
import { selectDueJobs } from "./jobs.js";
import type { RoundStore } from "./roundStore.js";
import { runAgents } from "./runner.js";
import type { DatasetWire, RoundBooking, RunAgentsDeps } from "./runner.js";

export interface PinnedRoundDeps {
  backend: BackendClient;
  store: RoundStore;
  config: OrchestratorConfig;
  /** Injectable for tests; defaults to the real docker exec spawner. */
  spawn?: NonNullable<RunAgentsDeps["spawn"]>;
}

export interface EvalRoundSummary {
  roundId: string;
  asOfTradeDate: string;
  status: string;
  insertedRuns: number;
  totalRuns: number;
}

export interface LaunchInput {
  roundId: string;
  asOfTradeDate: string;
  simId: string;
  jobs: readonly AgentJob[];
  cfg: OrchestratorConfig;
  deps: PinnedRoundDeps;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function launchPinnedRound(input: LaunchInput): Promise<EvalRoundSummary> {
  const { roundId, asOfTradeDate, simId, jobs, cfg, deps } = input;
  const { backend, store } = deps;

  await backend.post(`/api/portfolio/rounds/${encodeURIComponent(roundId)}/dataset`, {
    asOfTradeDate,
  });
  const dataset = await backend.get<DatasetWire>(
    `/api/portfolio/rounds/${encodeURIComponent(roundId)}/dataset`,
  );
  const datasetPath = datasetPathFor(cfg.worktreeSlug, roundId);

  const launched = await store.startRound({
    roundId,
    agents: jobs.map((job) => ({ agentKey: job.agentKey, personaKey: job.personaKey })),
    maxParallel: cfg.maxParallel,
    capital: cfg.capital,
    asOfTradeDate: dataset.asOfTradeDate,
    datasetPath,
    simulationId: simId,
  });
  const job = launched.job;
  if (job === null) {
    throw new Error(
      `launch response for ${roundId} carried no job row, so the admitted round_seq is unknown`,
    );
  }
  const booking: RoundBooking = { simulationId: job.simulationId, roundSeq: job.roundSeq };
  const admitted = selectDueJobs(jobs, launched.agents);

  const latestCloseBySymbol = new Map(
    dataset.universe.flatMap((entry) =>
      entry.hasData && entry.latestClose !== null
        ? [[entry.symbol, entry.latestClose] as const]
        : [],
    ),
  );
  const bookFor = createBookLoader({
    backend,
    simulationId: simId,
    capital: cfg.capital,
    latestCloseBySymbol,
    asOfTradeDate: dataset.asOfTradeDate,
  });

  try {
    await runAgents(roundId, admitted, dataset, {
      store,
      backend,
      config: cfg,
      bookFor,
      booking,
      spawn: deps.spawn,
    });
  } catch (err) {
    await store.setRoundStatus(roundId, "error", messageOf(err)).catch(() => undefined);
    throw err;
  }

  const state = await store.getRound(roundId);
  const inserted = state.agents.filter((agent) => agent.status === "inserted");
  return {
    roundId,
    asOfTradeDate: dataset.asOfTradeDate,
    status: state.job?.status ?? "error",
    insertedRuns: inserted.length,
    totalRuns: state.agents.length,
  };
}
