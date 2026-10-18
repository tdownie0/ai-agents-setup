/**
 * Pure-function tests for the eval read layer.
 *
 * No database is touched: every case exercises the exported pure functions in
 * `evalMetrics.ts` with synthetic rows, matching the established repo pattern
 * where the route layer's DB correctness comes from types + the shared
 * lifecycle verify.
 */

import { describe, expect, it } from "vitest";
import {
  BENCHMARK_METHOD,
  computeEqualWeightBenchmark,
  computeStreamEvalMetrics,
  sliceStreamEquity,
} from "./evalMetrics.js";
import type { EquityRow } from "./evalMetrics.js";

const row = (
  tradeDate: string,
  totalValue: string,
  overrides: Partial<EquityRow> = {},
): EquityRow => ({
  tradeDate,
  cash: "0",
  holdingsValue: totalValue,
  totalValue,
  roundSeq: 1,
  ...overrides,
});

describe("sliceStreamEquity", () => {
  const rows: EquityRow[] = [
    row("2026-01-02", "100"),
    row("2026-01-05", "110"),
    row("2026-01-06", "120"),
    row("2026-01-07", "130"),
  ];

  it("uses the last row at/before start as the baseline and excludes it from the series", () => {
    const sliced = sliceStreamEquity(rows, "2026-01-05", "2026-01-07");
    expect(sliced).not.toBeNull();
    expect(sliced?.baselineInsideWindow).toBe(false);
    // baseline is the row AT start (01-05, value 110), not an in-window row
    expect(sliced?.periodStartValue).toBe(110);
    expect(sliced?.periodEndValue).toBe(130);
    // series is (start, end] — 01-05 excluded, 01-07 included
    expect(sliced?.series.map((point) => point.tradeDate)).toEqual(["2026-01-06", "2026-01-07"]);
    expect(sliced?.series.map((point) => point.returnPct)).toEqual([
      ((120 - 110) / 110) * 100,
      ((130 - 110) / 110) * 100,
    ]);
  });

  it("falls back to the first in-window row as baseline when the stream started mid-window", () => {
    const startedLate = [row("2026-01-06", "120"), row("2026-01-07", "130")];
    const sliced = sliceStreamEquity(startedLate, "2026-01-05", "2026-01-07");
    expect(sliced?.baselineInsideWindow).toBe(true);
    expect(sliced?.periodStartValue).toBe(120);
    expect(sliced?.periodEndValue).toBe(130);
    expect(sliced?.series).toHaveLength(2);
    // return is measured from the mid-window baseline
    expect(sliced?.series[1]?.returnPct).toBe(((130 - 120) / 120) * 100);
  });

  it("treats a stream with no rows at all as no book in period", () => {
    expect(sliceStreamEquity([], "2026-01-05", "2026-01-07")).toBeNull();
  });

  it("treats a stream starting after end as no book in period", () => {
    expect(sliceStreamEquity([row("2026-01-08", "50")], "2026-01-05", "2026-01-07")).toBeNull();
  });

  it("treats a stream that ended before start as no book in period", () => {
    expect(sliceStreamEquity([row("2026-01-02", "50")], "2026-01-05", "2026-01-07")).toBeNull();
  });

  it("parses numeric-string rows into numbers", () => {
    const sliced = sliceStreamEquity(
      [row("2026-01-05", "110.5000", { cash: "10.2500" }), row("2026-01-06", "121.7500")],
      "2026-01-05",
      "2026-01-06",
    );
    expect(sliced?.periodStartValue).toBe(110.5);
    expect(sliced?.periodEndValue).toBe(121.75);
    // series[0] is the in-window row (2026-01-06); baseline cash is not in series
    expect(sliced?.series[0]?.cash).toBe(0);
  });

  it("includes a row exactly at end and excludes a row exactly at start", () => {
    const boundary = [row("2026-01-05", "100"), row("2026-01-07", "150")];
    const sliced = sliceStreamEquity(boundary, "2026-01-05", "2026-01-07");
    expect(sliced?.periodStartValue).toBe(100);
    expect(sliced?.periodEndValue).toBe(150);
    expect(sliced?.series.map((p) => p.tradeDate)).toEqual(["2026-01-07"]);
    expect(sliced?.series).toHaveLength(1);
  });
});

describe("computeStreamEvalMetrics", () => {
  it("returns all-null metrics when the stream has no book in the period", () => {
    expect(computeStreamEvalMetrics(null)).toEqual({
      totalReturnPct: null,
      annualizedVolPct: null,
      sharpe: null,
      maxDrawdownPct: null,
    });
  });

  it("returns a real return but null risk metrics for a single-point series", () => {
    const sliced = sliceStreamEquity([row("2026-01-06", "120")], "2026-01-05", "2026-01-07");
    const metrics = computeStreamEvalMetrics(sliced);
    expect(metrics.totalReturnPct).toBe(0);
    expect(metrics.annualizedVolPct).toBeNull();
    expect(metrics.sharpe).toBeNull();
    expect(metrics.maxDrawdownPct).toBe(0);
  });

  it("measures the return against the injected period-start basis", () => {
    const rows = [
      row("2026-01-02", "100"),
      row("2026-01-05", "200"),
      row("2026-01-06", "240"),
      row("2026-01-07", "300"),
    ];
    const sliced = sliceStreamEquity(rows, "2026-01-05", "2026-01-07");
    const metrics = computeStreamEvalMetrics(sliced);
    // basis = 200 (row at start), end = 300 → +50%, not +200% from 100
    expect(metrics.totalReturnPct).toBe(50);
    expect(metrics.annualizedVolPct).not.toBeNull();
    expect(metrics.sharpe).not.toBeNull();
    expect(metrics.maxDrawdownPct).toBe(0);
  });

  it("reports a flat risk profile as 0 (not null) when there are at least two points", () => {
    // baseline (01-05) sits at start and is excluded from the (start, end] series,
    // so both 01-06 and 01-07 must be inside the window to yield 2 series points
    const rows = [row("2026-01-05", "100"), row("2026-01-06", "100"), row("2026-01-07", "100")];
    const sliced = sliceStreamEquity(rows, "2026-01-05", "2026-01-07");
    expect(sliced?.series).toHaveLength(2);
    const metrics = computeStreamEvalMetrics(sliced);
    expect(metrics.totalReturnPct).toBe(0);
    expect(metrics.annualizedVolPct).toBe(0);
    expect(metrics.sharpe).toBe(0);
  });
});

describe("computeEqualWeightBenchmark", () => {
  it("averages per-symbol total returns from string adjClose values", () => {
    const bars = new Map([
      [
        "AAA",
        [
          { tradeDate: "2026-01-02", adjClose: "100.0000" },
          { tradeDate: "2026-01-07", adjClose: "110.0000" },
        ],
      ],
      [
        "BBB",
        [
          { tradeDate: "2026-01-02", adjClose: "50.0000" },
          { tradeDate: "2026-01-07", adjClose: "45.0000" },
        ],
      ],
    ]);
    const result = computeEqualWeightBenchmark(bars, "2026-01-02", "2026-01-07");
    // AAA +10%, BBB −10% → mean 0
    expect(result.returnPct).toBeCloseTo(0, 10);
    expect(result.symbolsUsed).toBe(2);
    expect(result.method).toBe(BENCHMARK_METHOD);
    expect(result.method).toBe("equal-weight buy-and-hold on adjClose");
  });

  it("uses the first bar at/after start, not a bar before it", () => {
    const bars = new Map([
      [
        "AAA",
        [
          { tradeDate: "2026-01-01", adjClose: "90.0000" },
          { tradeDate: "2026-01-02", adjClose: "100.0000" },
          { tradeDate: "2026-01-07", adjClose: "110.0000" },
        ],
      ],
    ]);
    const result = computeEqualWeightBenchmark(bars, "2026-01-02", "2026-01-07");
    expect(result.returnPct).toBeCloseTo(110 / 100 - 1, 10);
    expect(result.symbolsUsed).toBe(1);
  });

  it("skips symbols missing either endpoint", () => {
    const bars = new Map([
      // qualifies
      [
        "AAA",
        [
          { tradeDate: "2026-01-02", adjClose: "100.0000" },
          { tradeDate: "2026-01-07", adjClose: "110.0000" },
        ],
      ],
      // only a bar before start → no bar at/after start
      ["BBB", [{ tradeDate: "2026-01-01", adjClose: "50.0000" }]],
      // only a bar after end → no bar at/before end
      ["CCC", [{ tradeDate: "2026-01-08", adjClose: "50.0000" }]],
      // first endpoint has a null adjClose → unusable
      [
        "DDD",
        [
          { tradeDate: "2026-01-02", adjClose: null },
          { tradeDate: "2026-01-07", adjClose: "60.0000" },
        ],
      ],
    ]);
    const result = computeEqualWeightBenchmark(bars, "2026-01-02", "2026-01-07");
    expect(result.returnPct).toBeCloseTo(0.1, 10);
    expect(result.symbolsUsed).toBe(1);
  });

  it("returns null when no symbol qualifies", () => {
    const bars = new Map([
      ["BBB", [{ tradeDate: "2026-01-01", adjClose: "50.0000" }]],
      ["CCC", [{ tradeDate: "2026-01-08", adjClose: "50.0000" }]],
    ]);
    expect(computeEqualWeightBenchmark(bars, "2026-01-02", "2026-01-07")).toEqual({
      returnPct: null,
      symbolsUsed: 0,
      method: BENCHMARK_METHOD,
    });
  });

  it("returns null for an empty symbol map", () => {
    const result = computeEqualWeightBenchmark(new Map(), "2026-01-02", "2026-01-07");
    expect(result.returnPct).toBeNull();
    expect(result.symbolsUsed).toBe(0);
  });

  it("skips symbols with a non-positive adjClose endpoint", () => {
    const bars = new Map([
      [
        "AAA",
        [
          { tradeDate: "2026-01-02", adjClose: "0.0000" },
          { tradeDate: "2026-01-07", adjClose: "110.0000" },
        ],
      ],
      [
        "BBB",
        [
          { tradeDate: "2026-01-02", adjClose: "100.0000" },
          { tradeDate: "2026-01-07", adjClose: "105.0000" },
        ],
      ],
    ]);
    const result = computeEqualWeightBenchmark(bars, "2026-01-02", "2026-01-07");
    expect(result.symbolsUsed).toBe(1);
    expect(result.returnPct).toBeCloseTo(0.05, 10);
  });
});
