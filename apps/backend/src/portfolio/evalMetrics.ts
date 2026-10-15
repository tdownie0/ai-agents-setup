/**
 * Eval-metrics read layer (beads task cpn.2).
 *
 * Pure scoring math for the portfolio eval harness: slice a materialized chain
 * equity curve to an arbitrary `[start, end]` window, rank the slice, and score
 * an equal-weight buy-and-hold benchmark over the same window. No DB access, no
 * `process.env` — the route layer loads rows and parses numeric strings at the
 * edge, exactly like `ranking.ts` / `valuation.ts`.
 *
 * Nothing here is persisted: metrics are computed on read from the materialized
 * ledger, consistent with the repo's no-snapshot-table philosophy
 * (FEATURE_README §11.2).
 */

import { computeRanking } from "./ranking.js";
import { parseNumeric } from "./types.js";
import type { EquityPoint } from "./types.js";

/**
 * The `portfolio_equity_daily` columns the slice needs. Numeric columns arrive
 * from postgres-js as strings; `string | number` keeps the pure module usable
 * with synthetic fixtures while staying assignable from the DB row type.
 */
export interface EquityRow {
  tradeDate: string;
  cash: string | number;
  holdingsValue: string | number;
  totalValue: string | number;
  roundSeq: number | null;
}

/** One stream's equity curve sliced to a window, with its period baseline. */
export interface SlicedStream {
  /** `totalValue` of the baseline row (last row ≤ start, or the first row inside the window). */
  periodStartValue: number;
  /** `totalValue` of the last row inside the window. */
  periodEndValue: number;
  /** Rows with `tradeDate` in `(start, end]`, ascending, `returnPct` measured from `periodStartValue`. */
  series: EquityPoint[];
  /** `true` when the stream had no row ≤ start, so its first in-window row is the baseline. */
  baselineInsideWindow: boolean;
}

/**
 * Slice one stream's ascending equity rows to `(start, end]`.
 *
 * The baseline is the last row at or before `start`; a stream that began inside
 * the window has no such row, so its first in-window row serves as the baseline
 * and `baselineInsideWindow` is set. Returns `null` when the stream has no book
 * in the period (no rows in `(start, end]`), which the route reports as
 * "no book in period" rather than a fabricated flat 0%.
 */
export function sliceStreamEquity(
  equityRows: readonly EquityRow[],
  start: string,
  end: string,
): SlicedStream | null {
  const inWindow = equityRows.filter((row) => row.tradeDate > start && row.tradeDate <= end);
  if (inWindow.length === 0) return null;

  const before = equityRows.filter((row) => row.tradeDate <= start);
  const baseline = before[before.length - 1];
  const baselineInsideWindow = baseline === undefined;
  const startRow = baseline ?? inWindow[0];
  const periodStartValue = parseNumeric(startRow.totalValue);
  const periodEndValue = parseNumeric(inWindow[inWindow.length - 1].totalValue);

  const series: EquityPoint[] = inWindow.map((row) => {
    const totalValue = parseNumeric(row.totalValue);
    return {
      tradeDate: row.tradeDate,
      cash: parseNumeric(row.cash),
      holdingsValue: parseNumeric(row.holdingsValue),
      totalValue,
      returnPct:
        periodStartValue === 0 ? 0 : ((totalValue - periodStartValue) / periodStartValue) * 100,
    };
  });

  return { periodStartValue, periodEndValue, series, baselineInsideWindow };
}

/** One stream's window metrics; every field is `null` when the stream has no book in the period. */
export interface StreamEvalMetrics {
  totalReturnPct: number | null;
  annualizedVolPct: number | null;
  sharpe: number | null;
  maxDrawdownPct: number | null;
}

const finiteOrNull = (value: number): number | null => (Number.isFinite(value) ? value : null);

/**
 * Rank a sliced stream with `computeRanking`, injecting the period-start value as
 * the basis so the return is measured over the window rather than the chain.
 *
 * `computeRanking` returns `0` (not `null`) for volatility/Sharpe when it has too
 * few points to estimate a stdev, so a series shorter than 2 points is surfaced
 * as `null` here — "not enough data" is a different fact from "genuinely zero
 * vol". A `null` slice (no book in period) yields all-null metrics.
 */
export function computeStreamEvalMetrics(sliced: SlicedStream | null): StreamEvalMetrics {
  if (sliced === null) {
    return { totalReturnPct: null, annualizedVolPct: null, sharpe: null, maxDrawdownPct: null };
  }
  const ranking = computeRanking({
    equitySeries: sliced.series,
    basisCapital: sliced.periodStartValue,
  });
  const enoughForRisk = sliced.series.length >= 2;
  return {
    totalReturnPct: finiteOrNull(ranking.totalReturnPct),
    annualizedVolPct: enoughForRisk ? finiteOrNull(ranking.annualizedVolPct) : null,
    sharpe: enoughForRisk ? finiteOrNull(ranking.sharpe) : null,
    maxDrawdownPct: finiteOrNull(ranking.maxDrawdownPct),
  };
}

/** One symbol's daily bar for the benchmark (`adjClose` is a numeric string at the edge). */
export interface BenchmarkBar {
  tradeDate: string;
  adjClose: string | number | null;
}

/** Bars keyed by symbol, oldest-first. */
export type BenchmarkBarsBySymbol = ReadonlyMap<string, readonly BenchmarkBar[]>;

/** The equal-weight buy-and-hold benchmark over a window. */
export interface BenchmarkResult {
  /**
   * Mean per-symbol total return (`adjClose(last) / adjClose(first) − 1`) across
   * symbols with both endpoints; `null` when none qualify. This is a FRACTION
   * (0.05 = +5%), per the spec's explicit formula, despite the `Pct` suffix.
   */
  returnPct: number | null;
  /** Symbols that had a bar at/after `start` AND at/before `end` with a usable `adjClose`. */
  symbolsUsed: number;
  method: "equal-weight buy-and-hold on adjClose";
}

export const BENCHMARK_METHOD = "equal-weight buy-and-hold on adjClose" as const;

/**
 * Equal-weight buy-and-hold benchmark over `[start, end]`.
 *
 * Per symbol: total return = `adjClose(last bar ≤ end) / adjClose(first bar ≥ start) − 1`.
 * A symbol missing either endpoint (or with a non-positive `adjClose`) is skipped.
 * The benchmark is the mean of the qualifying symbols' returns, or `null` when
 * none qualify. `adjClose` arrives as a numeric string and is parsed with
 * `parseNumeric`, matching the rest of the wire edge.
 */
export function computeEqualWeightBenchmark(
  barsBySymbol: BenchmarkBarsBySymbol,
  start: string,
  end: string,
): BenchmarkResult {
  const returns: number[] = [];
  for (const bars of barsBySymbol.values()) {
    let first: BenchmarkBar | undefined;
    let last: BenchmarkBar | undefined;
    for (const bar of bars) {
      if (first === undefined && bar.tradeDate >= start) first = bar;
      if (bar.tradeDate <= end) last = bar;
    }
    if (first === undefined || last === undefined) continue;
    if (first.tradeDate > last.tradeDate) continue;
    const firstAdj = parseNumeric(first.adjClose);
    const lastAdj = parseNumeric(last.adjClose);
    if (firstAdj <= 0 || lastAdj <= 0) continue;
    returns.push(lastAdj / firstAdj - 1);
  }
  if (returns.length === 0) {
    return { returnPct: null, symbolsUsed: 0, method: BENCHMARK_METHOD };
  }
  const mean = returns.reduce((acc, value) => acc + value, 0) / returns.length;
  return { returnPct: mean, symbolsUsed: returns.length, method: BENCHMARK_METHOD };
}
