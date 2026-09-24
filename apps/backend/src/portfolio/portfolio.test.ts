/**
 * Pure-math unit tests for the portfolio engine (beads task ez8.2).
 *
 * No DB, no network — fake rows inline. Covers the equity-series math
 * (entry fill, drift, rebalance cadence 1/5/21, forward-fill, empty-prices
 * edge, returnPct), the ranking math (sharpe/vol/drawdown), and the
 * numeric-string → number parse helper.
 */

import { describe, expect, it } from "vitest";
import { computeEquitySeries } from "./valuation.js";
import type { BarsBySymbol, EngineBar, EnginePosition, EngineRun } from "./valuation.js";
import { computeRanking } from "./ranking.js";
import { parseNumeric, REBALANCE_CADENCE } from "./types.js";
import type { EquityPoint } from "./types.js";

const START = "2026-01-05";
const INITIAL_CAPITAL = 100000;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tradeDates(count: number, start = START): string[] {
  const dates: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < count; i += 1) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

function bars(symbol: string, closes: readonly number[], start = START): EngineBar[] {
  const dates = tradeDates(closes.length, start);
  return closes.map((close, i) => ({ tradeDate: dates[i], close }));
}

function makeRun(window: EngineRun["window"], initialCapital = INITIAL_CAPITAL): EngineRun {
  return { initialCapital, window };
}

/** Entry fill: shares = initialCapital × targetWeight / entryPrice. */
function makePosition(
  symbol: string,
  targetWeight: number,
  entryPrice: number,
  entryTradeDate = START,
  initialCapital = INITIAL_CAPITAL,
): EnginePosition {
  return {
    symbol,
    targetWeight,
    shares: (initialCapital * targetWeight) / entryPrice,
    entryTradeDate,
    entryPrice,
  };
}

function makeBars(...symbolBars: Array<[string, EngineBar[]]>): BarsBySymbol {
  return new Map(symbolBars);
}

function seriesFromTotals(totals: readonly number[], start = START): EquityPoint[] {
  const dates = tradeDates(totals.length, start);
  return totals.map((totalValue, i) => ({
    tradeDate: dates[i],
    cash: 0,
    holdingsValue: totalValue,
    totalValue,
    returnPct: 0,
  }));
}

// ---------------------------------------------------------------------------
// computeEquitySeries
// ---------------------------------------------------------------------------

describe("computeEquitySeries", () => {
  it("values the entry day at initial capital with zero return", () => {
    const run = makeRun("weekly");
    const positions = [makePosition("AAPL", 0.5, 100), makePosition("MSFT", 0.5, 200)];
    const barsBySymbol = makeBars(
      ["AAPL", bars("AAPL", [100, 110])],
      ["MSFT", bars("MSFT", [200, 190])],
    );

    const series = computeEquitySeries(run, positions, barsBySymbol);

    expect(series).toHaveLength(2);
    const entry = series[0];
    expect(entry?.tradeDate).toBe(START);
    expect(entry?.cash).toBeCloseTo(0, 6);
    expect(entry?.holdingsValue).toBeCloseTo(INITIAL_CAPITAL, 6);
    expect(entry?.totalValue).toBeCloseTo(INITIAL_CAPITAL, 6);
    expect(entry?.returnPct).toBeCloseTo(0, 6);
  });

  it("drifts between rebalances with fixed shares and fixed cash", () => {
    const run = makeRun("weekly");
    const positions = [makePosition("AAPL", 0.5, 100), makePosition("MSFT", 0.5, 200)];
    const barsBySymbol = makeBars(
      ["AAPL", bars("AAPL", [100, 110])],
      ["MSFT", bars("MSFT", [200, 190])],
    );

    const series = computeEquitySeries(run, positions, barsBySymbol);
    const day1 = series[1];

    // AAPL +10%, MSFT −5% → 0.5×1.10 + 0.5×0.95 = 1.025 → +2.5%.
    expect(day1?.holdingsValue).toBeCloseTo(500 * 110 + 250 * 190, 6);
    expect(day1?.totalValue).toBeCloseTo(102500, 6);
    expect(day1?.returnPct).toBeCloseTo(2.5, 6);
    // Cash is untouched between rebalances.
    expect(day1?.cash).toBeCloseTo(0, 6);
  });

  it("daily rebalance resets weights exactly and preserves total", () => {
    const run = makeRun("daily");
    const positions = [makePosition("AAPL", 0.5, 100), makePosition("MSFT", 0.5, 200)];
    const barsBySymbol = makeBars(
      ["AAPL", bars("AAPL", [100, 110, 120])],
      ["MSFT", bars("MSFT", [200, 190, 200])],
    );

    const series = computeEquitySeries(run, positions, barsBySymbol);
    expect(series).toHaveLength(3);

    // Day 1 is a boundary: total = 102500, rebalance at closes 110 / 190.
    const aaplShares = (102500 * 0.5) / 110;
    const msftShares = (102500 * 0.5) / 190;
    // Rebalanced holdings at the boundary close equal the pre-rebalance total.
    expect(aaplShares * 110 + msftShares * 190).toBeCloseTo(102500, 6);
    // Day 2 reflects the rebalanced shares, not the original 500 / 250.
    expect(series[2]?.holdingsValue).toBeCloseTo(aaplShares * 120 + msftShares * 200, 6);
    expect(series[2]?.holdingsValue).not.toBeCloseTo(500 * 120 + 250 * 200, 6);
  });

  it("fires the weekly rebalance on the 5th trading day", () => {
    const run = makeRun("weekly");
    const positions = [makePosition("AAPL", 0.5, 100), makePosition("MSFT", 0.5, 200)];
    // Days 0-3 flat; day 5 (index 4) is the boundary; day 6 (index 5) drifts.
    const barsBySymbol = makeBars(
      ["AAPL", bars("AAPL", [100, 100, 100, 100, 120, 110])],
      ["MSFT", bars("MSFT", [200, 200, 200, 200, 160, 190])],
    );

    const series = computeEquitySeries(run, positions, barsBySymbol);
    expect(series).toHaveLength(6);

    // Boundary day: total = 500×120 + 250×160 = 100000.
    expect(series[4]?.totalValue).toBeCloseTo(100000, 6);
    // Next day uses rebalanced shares.
    const aaplShares = (100000 * 0.5) / 120;
    const msftShares = (100000 * 0.5) / 160;
    expect(series[5]?.holdingsValue).toBeCloseTo(aaplShares * 110 + msftShares * 190, 6);
    expect(series[5]?.holdingsValue).not.toBeCloseTo(500 * 110 + 250 * 190, 6);
  });

  it("fires the monthly rebalance on the 21st trading day", () => {
    const run = makeRun("monthly");
    const positions = [makePosition("AAPL", 0.5, 100), makePosition("MSFT", 0.5, 200)];
    const closesA = Array.from({ length: 23 }, (_, i) => (i === 20 ? 120 : i === 21 ? 110 : 100));
    const closesM = Array.from({ length: 23 }, (_, i) => (i === 20 ? 160 : i === 21 ? 190 : 200));
    const barsBySymbol = makeBars(["AAPL", bars("AAPL", closesA)], ["MSFT", bars("MSFT", closesM)]);

    const series = computeEquitySeries(run, positions, barsBySymbol);
    expect(series).toHaveLength(23);

    // Boundary at index 20: total = 500×120 + 250×160 = 100000.
    expect(series[20]?.totalValue).toBeCloseTo(100000, 6);
    const aaplShares = (100000 * 0.5) / 120;
    const msftShares = (100000 * 0.5) / 160;
    expect(series[21]?.holdingsValue).toBeCloseTo(aaplShares * 110 + msftShares * 190, 6);
  });

  it("forward-fills a halted symbol's last close", () => {
    const run = makeRun("weekly");
    const positions = [makePosition("AAPL", 0.5, 100), makePosition("MSFT", 0.5, 200)];
    const dates = tradeDates(4);
    const msftBars: EngineBar[] = [
      { tradeDate: dates[0], close: 200 },
      { tradeDate: dates[1], close: 200 },
      { tradeDate: dates[3], close: 200 },
    ];
    const barsBySymbol = makeBars(["AAPL", bars("AAPL", [100, 100, 100, 100])], ["MSFT", msftBars]);

    const series = computeEquitySeries(run, positions, barsBySymbol);
    expect(series).toHaveLength(4);
    // Day 3 (index 2): MSFT has no bar → holds its day-2 close (200).
    expect(series[2]?.holdingsValue).toBeCloseTo(500 * 100 + 250 * 200, 6);
  });

  it("treats a symbol with no bars at all as zero value", () => {
    const run = makeRun("weekly");
    const positions = [makePosition("AAPL", 0.5, 100), makePosition("MSFT", 0.5, 200)];
    const barsBySymbol = makeBars(["AAPL", bars("AAPL", [100, 110])]);

    const series = computeEquitySeries(run, positions, barsBySymbol);
    expect(series[1]?.holdingsValue).toBeCloseTo(500 * 110, 6);
  });

  it("returns an entry-day-only series when there are no prices", () => {
    const run = makeRun("weekly");
    const positions = [makePosition("AAPL", 0.5, 100), makePosition("MSFT", 0.5, 200)];

    const series = computeEquitySeries(run, positions, new Map());

    expect(series).toHaveLength(1);
    expect(series[0]?.tradeDate).toBe(START);
    expect(series[0]?.totalValue).toBeCloseTo(INITIAL_CAPITAL, 6);
    expect(series[0]?.returnPct).toBeCloseTo(0, 6);
  });

  it("computes returnPct relative to initial capital", () => {
    const run = makeRun("weekly");
    const positions = [makePosition("AAPL", 0.5, 100), makePosition("MSFT", 0.5, 200)];
    const barsBySymbol = makeBars(
      ["AAPL", bars("AAPL", [100, 110, 121])],
      ["MSFT", bars("MSFT", [200, 190, 209])],
    );

    const series = computeEquitySeries(run, positions, barsBySymbol);
    // AAPL +21%, MSFT +4.5% → 0.5×1.21 + 0.5×1.045 = 1.1275 → +12.75%.
    expect(series[2]?.totalValue).toBeCloseTo(112750, 6);
    expect(series[2]?.returnPct).toBeCloseTo(12.75, 6);
  });

  it("returns an empty series when positions carry no entry trade date", () => {
    const run = makeRun("weekly");
    const positions: EnginePosition[] = [
      { symbol: "AAPL", targetWeight: 1, shares: 1000, entryTradeDate: "", entryPrice: 100 },
    ];
    const barsBySymbol = makeBars(["AAPL", bars("AAPL", [100, 110])]);

    expect(computeEquitySeries(run, positions, barsBySymbol)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeRanking
// ---------------------------------------------------------------------------

describe("computeRanking", () => {
  it("reports positive sharpe and zero drawdown on a rising series", () => {
    const ranking = computeRanking(seriesFromTotals([100, 101, 102, 103, 104]));

    expect(ranking.asOfTradeDate).toBe(tradeDates(5)[4]);
    expect(ranking.currentValue).toBe(104);
    expect(ranking.totalReturnPct).toBeCloseTo(4, 6);
    expect(ranking.sharpe).toBeGreaterThan(0);
    expect(ranking.annualizedVolPct).toBeGreaterThan(0);
    expect(ranking.maxDrawdownPct).toBe(0);
  });

  it("reports a negative max drawdown on a sawtooth series", () => {
    const ranking = computeRanking(seriesFromTotals([100, 120, 90, 130, 80]));

    // Peak 130 → trough 80: (80 − 130) / 130 × 100.
    expect(ranking.maxDrawdownPct).toBeCloseTo(-38.461538, 4);
    expect(ranking.maxDrawdownPct).toBeLessThan(0);
  });

  it("returns zero sharpe and volatility on a flat series", () => {
    const ranking = computeRanking(seriesFromTotals([100, 100, 100, 100]));

    expect(ranking.sharpe).toBe(0);
    expect(ranking.annualizedVolPct).toBe(0);
    expect(ranking.totalReturnPct).toBe(0);
  });

  it("returns zero sharpe with fewer than two points", () => {
    const ranking = computeRanking(seriesFromTotals([100]));

    expect(ranking.sharpe).toBe(0);
    expect(ranking.annualizedVolPct).toBe(0);
    expect(ranking.totalReturnPct).toBe(0);
  });

  it("returns a zeroed ranking for an empty series", () => {
    const ranking = computeRanking([]);

    expect(ranking.asOfTradeDate).toBe("");
    expect(ranking.currentValue).toBe(0);
    expect(ranking.totalReturnPct).toBe(0);
    expect(ranking.sharpe).toBe(0);
    expect(ranking.maxDrawdownPct).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseNumeric + cadence
// ---------------------------------------------------------------------------

describe("parseNumeric", () => {
  it("parses numeric strings to numbers", () => {
    expect(parseNumeric("123.45")).toBe(123.45);
    expect(parseNumeric("0")).toBe(0);
    expect(parseNumeric("100000.00")).toBe(100000);
    expect(parseNumeric("0.500000")).toBe(0.5);
  });

  it("passes numbers through unchanged", () => {
    expect(parseNumeric(42)).toBe(42);
    expect(parseNumeric(0)).toBe(0);
  });

  it("maps null, undefined and non-finite values to 0", () => {
    expect(parseNumeric(null)).toBe(0);
    expect(parseNumeric(undefined)).toBe(0);
    expect(parseNumeric("abc")).toBe(0);
    expect(parseNumeric("NaN")).toBe(0);
  });
});

describe("REBALANCE_CADENCE", () => {
  it("defines the shared 1/5/21 trading-day cadence", () => {
    expect(REBALANCE_CADENCE).toEqual({ daily: 1, weekly: 5, monthly: 21 });
  });
});
