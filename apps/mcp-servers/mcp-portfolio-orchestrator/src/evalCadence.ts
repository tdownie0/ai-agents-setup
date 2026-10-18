/**
 * Cadence and calendar helpers for the walk-forward replay.
 *
 * The cadence constant is MIRRORED from `apps/backend/src/portfolio/types.ts`
 * (`REBALANCE_CADENCE`) — the backend is not a dependency of this package, so it
 * cannot be imported. Keep the two in lockstep.
 *
 * Due-ness is read from the streams summary route rather than the per-stream
 * rounds route: one request returns every stream's `lastTradeDate`, which is
 * exactly the field the backend's `computeRosterDue` counts from, so the client
 * and the launch gate agree on which streams are due. A stream absent from the
 * summary has not folded yet, so its first round is always due.
 */

import type { AnalystWindow } from "@model_md/agent-orchestrator";
import type { AgentJob } from "./agents.js";
import type { BackendClient } from "./backendClient.js";

/** Mirror of `REBALANCE_CADENCE` in `apps/backend/src/portfolio/types.ts`. */
export const REBALANCE_CADENCE: Readonly<Record<AnalystWindow, number>> = {
  daily: 1,
  weekly: 5,
  monthly: 21,
};

const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface DatasetStatusWire {
  dataReady: boolean;
  symbols: number;
  symbolsWithData: number;
  asOfTradeDate: string | null;
}

export interface StreamSummaryWire {
  agentKey: string;
  lastTradeDate: string;
}

/** Parse a strict `YYYY-MM-DD` date, rejecting rollovers like `2026-02-30`. */
export function parseYmd(value: string): string | null {
  if (!YMD_PATTERN.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === value ? value : null;
}

/** The round id a replay mints for one trade date. */
export function buildEvalRoundId(simId: string, tradeDate: string): string {
  return `eval-${simId}-${tradeDate}`;
}

/**
 * Is `window` due at `asOfTradeDate` given the stream's last decision?
 *
 * Mirrors `isDecisionDue` + `computeRosterDue`: a first round (`null`) is always
 * due; otherwise the count is trading days in `(lastTradeDate, asOfTradeDate]`
 * from the price calendar, compared against the cadence.
 */
export function streamDueAt(
  window: AnalystWindow,
  lastTradeDate: string | null,
  asOfTradeDate: string,
  calendar: readonly string[],
): boolean {
  if (lastTradeDate === null) return true;
  const elapsed = calendar.filter((date) => date > lastTradeDate && date <= asOfTradeDate).length;
  return elapsed >= REBALANCE_CADENCE[window];
}

export async function fetchTradingDates(
  backend: BackendClient,
  start: string,
  end: string,
): Promise<string[]> {
  const query = `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  const res = await backend.get<{ tradeDates: string[] }>(`/api/portfolio/trading-dates${query}`);
  return res.tradeDates;
}

/** agentKey -> last decision date, for every stream that has materialized a book. */
export async function fetchStreamLastDates(
  backend: BackendClient,
  simId: string,
): Promise<Map<string, string | null>> {
  const streams = await backend.get<StreamSummaryWire[]>(
    `/api/portfolio/simulations/${encodeURIComponent(simId)}/streams`,
  );
  return new Map(streams.map((stream) => [stream.agentKey, stream.lastTradeDate]));
}

/** Earliest last decision across the selected streams, or `null` if none folded. */
export function earliestLastDate(
  jobs: readonly AgentJob[],
  streamLast: ReadonlyMap<string, string | null>,
): string | null {
  let earliest: string | null = null;
  for (const job of jobs) {
    const last = streamLast.get(job.agentKey);
    if (last === undefined || last === null) continue;
    if (earliest === null || last < earliest) earliest = last;
  }
  return earliest;
}
