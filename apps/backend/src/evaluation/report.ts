/**
 * Eval comparison report service (beads task model_md-worktree-feat-portfolio-sim-ijg).
 *
 * `GET /portfolio/evals/report` — aggregate judge scores + deterministic
 * stream metrics per (personaKey, promptSetVersion) over a date range ×
 * replicates, with low-n warnings, so prompt versions passed as separate
 * simulations can be compared side by side.
 *
 * This module only loads rows and sequences the read; every statistic lives
 * in `reportAggregates.ts` (pure) and every metric in `portfolio/evalMetrics.ts`
 * (pure). Same db-access shape as `judgeBatch.ts`: a `DbClient` param, one
 * INNER JOIN to `round_jobs` for the decide date (runs link rounds by value, R6).
 */

import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { agentPortfolioState, agentRuns, roundJobs, runEvalScores } from "@model_md/database";
import type { DbClient } from "@model_md/market-data";
import { loadEquityByState } from "../portfolio/carryoverStore.js";
import { PROCESS_JUDGE_KEY } from "./rubric.js";
import {
  assembleEvalReport,
  computeWindowSamples,
  neededStateKeys,
  stateKey,
} from "./reportAggregates.js";
import type {
  EvalReport,
  RawReportRunRow,
  ReportRunRow,
  ReportScoreRow,
  ReportStateRow,
} from "./reportAggregates.js";

export type { EvalReport } from "./reportAggregates.js";

export interface EvalReportOpts {
  /** 1..10 simulations — replicates are separate sims; one sim per prompt version for cross-version comparison. */
  simIds: string[];
  /** Inclusive lower decide-date bound; absent = min `as_of_trade_date` among matched runs. */
  start?: string;
  /** Inclusive upper decide-date bound; absent = max `as_of_trade_date` among matched runs. */
  end?: string;
  /** Defaults to the locked "process" judge key. */
  judgeKey?: string;
}

async function loadReportRuns(
  client: DbClient,
  simIds: readonly string[],
  start: string | undefined,
  end: string | undefined,
): Promise<RawReportRunRow[]> {
  const conditions: SQL[] = [inArray(agentRuns.simulationId, [...simIds])];
  if (start !== undefined) conditions.push(gte(roundJobs.asOfTradeDate, start));
  if (end !== undefined) conditions.push(lte(roundJobs.asOfTradeDate, end));
  return client
    .select({
      id: agentRuns.id,
      simulationId: agentRuns.simulationId,
      agentKey: agentRuns.agentKey,
      window: agentRuns.window,
      promptSetVersion: agentRuns.promptSetVersion,
      promptHash: agentRuns.promptHash,
      asOfTradeDate: roundJobs.asOfTradeDate,
    })
    .from(agentRuns)
    .innerJoin(roundJobs, eq(agentRuns.roundId, roundJobs.roundId))
    .where(and(...conditions))
    .orderBy(asc(agentRuns.id));
}

async function loadReportScores(
  client: DbClient,
  runIds: readonly number[],
  judgeKey: string,
): Promise<ReportScoreRow[]> {
  if (runIds.length === 0) return [];
  return client
    .select({
      agentRunId: runEvalScores.agentRunId,
      judgeVersion: runEvalScores.judgeVersion,
      judgeModel: runEvalScores.judgeModel,
      scores: runEvalScores.scores,
    })
    .from(runEvalScores)
    .where(
      and(eq(runEvalScores.judgeKey, judgeKey), inArray(runEvalScores.agentRunId, [...runIds])),
    )
    .orderBy(asc(runEvalScores.agentRunId), asc(runEvalScores.judgeVersion));
}

async function loadReportStates(
  client: DbClient,
  simIds: readonly string[],
): Promise<ReportStateRow[]> {
  return client
    .select({
      id: agentPortfolioState.id,
      simulationId: agentPortfolioState.simulationId,
      personaKey: agentPortfolioState.personaKey,
      window: agentPortfolioState.window,
    })
    .from(agentPortfolioState)
    .where(inArray(agentPortfolioState.simulationId, [...simIds]))
    .orderBy(asc(agentPortfolioState.simulationId), asc(agentPortfolioState.personaKey));
}

/**
 * Drop runs the report cannot place: the sim filter already guarantees a sim
 * match, but a round without `as_of_trade_date` has no position in any range
 * (same rule the judge batch applies) and a NULL `simulation_id` cannot count
 * as a replicate. The columns are nullable in the schema, so the narrowing
 * happens once here rather than at every downstream use.
 */
function placeableRuns(rows: readonly RawReportRunRow[]): ReportRunRow[] {
  return rows.filter(
    (row): row is ReportRunRow => row.simulationId !== null && row.asOfTradeDate !== null,
  );
}

function effectiveBounds(
  runs: readonly ReportRunRow[],
  start: string | undefined,
  end: string | undefined,
): { start: string | null; end: string | null } {
  const dates = [...new Set(runs.map((run) => run.asOfTradeDate))].sort();
  return {
    start: start ?? dates[0] ?? null,
    end: end ?? dates[dates.length - 1] ?? null,
  };
}

export async function buildEvalReport(client: DbClient, opts: EvalReportOpts): Promise<EvalReport> {
  const judgeKey = opts.judgeKey?.trim() || PROCESS_JUDGE_KEY;
  const runs = placeableRuns(await loadReportRuns(client, opts.simIds, opts.start, opts.end));
  const bounds = effectiveBounds(runs, opts.start, opts.end);

  if (runs.length === 0 || bounds.start === null || bounds.end === null) {
    return {
      start: bounds.start,
      end: bounds.end,
      judgeKey,
      simIds: [...opts.simIds],
      groups: [],
      warnings: [],
    };
  }

  const [scoreRows, states] = await Promise.all([
    loadReportScores(
      client,
      runs.map((run) => run.id),
      judgeKey,
    ),
    loadReportStates(client, opts.simIds),
  ]);
  const needed = neededStateKeys(runs);
  const matchedStates = states.filter((state) =>
    needed.has(stateKey(state.simulationId, state.personaKey, state.window)),
  );
  const equityByState = await loadEquityByState(
    client,
    matchedStates.map((state) => state.id),
  );
  const samples = computeWindowSamples(matchedStates, equityByState, bounds.start, bounds.end);

  return assembleEvalReport({
    simIds: opts.simIds,
    judgeKey,
    start: bounds.start,
    end: bounds.end,
    runs,
    scoreRows,
    samples,
  });
}
