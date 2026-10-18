/**
 * Walk-forward as-of replay driver (`run_eval_period`).
 *
 * Replays a carryover simulation over a historical window: for each trade date
 * in `[start, end]`, recompute which selected persona x window streams are due
 * (rebalance cadence in trading days), skip dates where none are due, and on a
 * due date launch a pinned round (`asOfTradeDate` = that date) with the same
 * flow as `start_agent_round`. Rounds are launched SEQUENTIALLY and each is
 * fully awaited before the next date is evaluated, because the chain fold is
 * forward-only: a later date's due-ness depends on the marks the earlier round
 * just wrote.
 *
 * The walk STOPS at the first refused date (a 409 from the launch gate, or any
 * other error) and reports the blocking date, code, hint, and next step: the
 * fold is forward-only, so continuing past a refusal would book later rounds on
 * a chain that never advanced.
 *
 * Cadence/calendar helpers live in `evalCadence.ts`; the single-round launch
 * flow lives in `pinnedRound.ts`.
 */

import { isValidRoundId, parseWindows, resolveAgents } from "./agents.js";
import type { AgentJob } from "./agents.js";
import { BackendError, isRecord } from "./backendClient.js";
import type { OrchestratorConfig } from "./config.js";
import {
  buildEvalRoundId,
  earliestLastDate,
  fetchStreamLastDates,
  fetchTradingDates,
  parseYmd,
  streamDueAt,
} from "./evalCadence.js";
import type { DatasetStatusWire } from "./evalCadence.js";
import { launchPinnedRound } from "./pinnedRound.js";
import type { EvalRoundSummary, PinnedRoundDeps } from "./pinnedRound.js";
import { RERUN_ACTIONS } from "./rerunActions.js";

export type EvalPeriodDeps = PinnedRoundDeps;
export type { EvalRoundSummary } from "./pinnedRound.js";
export { buildEvalRoundId, parseYmd, streamDueAt } from "./evalCadence.js";

export interface EvalPeriodInput {
  simId: string;
  start: string;
  end: string;
  agents?: string;
  windows?: string;
  maxParallel?: number;
  capital?: number;
}

export interface EvalPeriodSuccess {
  ok: true;
  simId: string;
  start: string;
  end: string;
  rounds: EvalRoundSummary[];
  skippedDates: string[];
}

export interface EvalPeriodStop {
  ok: false;
  simId: string;
  start: string;
  end: string;
  rounds: EvalRoundSummary[];
  skippedDates: string[];
  /** The date whose launch was refused; `null` when the run never started. */
  stoppedAt: string | null;
  code: string | null;
  error: string;
  hint: string | null;
  nextStep: string | null;
  detail: unknown;
}

export type EvalPeriodResult = EvalPeriodSuccess | EvalPeriodStop;

interface FailureDetail {
  code: string | null;
  hint: string | null;
  nextStep: string | null;
  detail: unknown;
}

const NO_FAILURE: FailureDetail = { code: null, hint: null, nextStep: null, detail: null };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stopResult(
  base: Omit<EvalPeriodSuccess, "ok">,
  stoppedAt: string | null,
  error: string,
  failure: Partial<FailureDetail> = {},
): EvalPeriodStop {
  return { ok: false, ...base, stoppedAt, error, ...NO_FAILURE, ...failure };
}

/** Turn a thrown error into the actionable fields a refusal should carry. */
function describeFailure(err: unknown): FailureDetail {
  if (err instanceof BackendError && err.status === 409 && isRecord(err.payload)) {
    const code = typeof err.payload.code === "string" ? err.payload.code : null;
    return {
      code,
      hint: typeof err.payload.hint === "string" ? err.payload.hint : null,
      nextStep: code !== null ? (RERUN_ACTIONS[code] ?? null) : null,
      detail: err.payload.detail ?? null,
    };
  }
  return NO_FAILURE;
}

export async function runEvalPeriod(
  input: EvalPeriodInput,
  deps: EvalPeriodDeps,
): Promise<EvalPeriodResult> {
  const { simId, start, end } = input;
  const rounds: EvalRoundSummary[] = [];
  const skippedDates: string[] = [];
  const base = (): Omit<EvalPeriodSuccess, "ok"> => ({ simId, start, end, rounds, skippedDates });

  const startDate = parseYmd(start);
  if (startDate === null) {
    return stopResult(
      base(),
      null,
      `start must be a YYYY-MM-DD date, got ${JSON.stringify(start)}`,
    );
  }
  const endDate = parseYmd(end);
  if (endDate === null) {
    return stopResult(base(), null, `end must be a YYYY-MM-DD date, got ${JSON.stringify(end)}`);
  }
  if (endDate < startDate) {
    return stopResult(base(), null, `end (${end}) must not be before start (${start})`);
  }

  let jobs: AgentJob[];
  try {
    jobs = resolveAgents(input.agents, parseWindows(input.windows));
  } catch (err) {
    return stopResult(base(), null, messageOf(err));
  }

  const cfg: OrchestratorConfig = {
    ...deps.config,
    maxParallel: input.maxParallel ?? deps.config.maxParallel,
    capital: input.capital ?? deps.config.capital,
  };

  let candidates: string[];
  try {
    candidates = await fetchTradingDates(deps.backend, startDate, endDate);
  } catch (err) {
    return stopResult(base(), null, messageOf(err));
  }

  // Validate every round id we might mint BEFORE any launch: a bad simId would
  // otherwise fail mid-window, after earlier dates had already folded.
  for (const date of candidates) {
    const roundId = buildEvalRoundId(simId, date);
    if (!isValidRoundId(roundId)) {
      return stopResult(
        base(),
        null,
        `round id ${JSON.stringify(roundId)} is invalid; simId must match /^sim-[a-z0-9][a-z0-9-]{0,46}$/`,
      );
    }
  }

  if (candidates.length === 0) return { ok: true, ...base() };

  try {
    const status = await deps.backend.get<DatasetStatusWire>("/api/portfolio/dataset-status");
    if (!status.dataReady) {
      return stopResult(
        base(),
        null,
        `Dataset not ready: ${status.symbolsWithData}/${status.symbols} universe symbols have price data${
          status.asOfTradeDate !== null ? ` as of ${status.asOfTradeDate}` : ""
        }.`,
        {
          hint: "Run market-data ingestion first (POST /api/market-data/ingest), then retry this tool.",
        },
      );
    }
  } catch (err) {
    return stopResult(base(), null, messageOf(err));
  }

  let streamLast: Map<string, string | null>;
  let calendar: string[];
  try {
    streamLast = await fetchStreamLastDates(deps.backend, simId);
    const earliest = earliestLastDate(jobs, streamLast);
    // A stream whose last decision predates the window needs the calendar from
    // that decision, not from `start`, or its elapsed count would read short.
    calendar =
      earliest !== null && earliest < startDate
        ? await fetchTradingDates(deps.backend, earliest, endDate)
        : candidates;
  } catch (err) {
    return stopResult(base(), null, messageOf(err));
  }

  for (const date of candidates) {
    const due = jobs.filter((job) =>
      streamDueAt(job.window, streamLast.get(job.agentKey) ?? null, date, calendar),
    );
    if (due.length === 0) {
      skippedDates.push(date);
      continue;
    }

    const roundId = buildEvalRoundId(simId, date);
    try {
      rounds.push(
        await launchPinnedRound({ roundId, asOfTradeDate: date, simId, jobs, cfg, deps }),
      );
    } catch (err) {
      return stopResult(base(), date, messageOf(err), describeFailure(err));
    }

    // Refresh stream state after the fold so the next date counts from the new
    // marks rather than the pre-round snapshot.
    try {
      streamLast = await fetchStreamLastDates(deps.backend, simId);
    } catch (err) {
      return stopResult(base(), date, messageOf(err));
    }
  }

  return { ok: true, ...base() };
}
