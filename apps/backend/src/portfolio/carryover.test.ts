/**
 * Pure-math unit tests for the carryover fold (beads task 800.3, W3).
 *
 * No DB, no network — inline fixtures, same discipline as `portfolio.test.ts`.
 * Covers the fold's four outcomes (full liquidation, partial trim, zero-delta
 * hold, fresh buy), the shares-weighted cost basis, the chain equity series
 * (drift with fixed shares, no cadence re-snap, trade-date dedup, contiguity),
 * the pure replay helper, the advisory cadence signal, and the ranking basis
 * overload.
 */

import { describe, expect, it } from "vitest";
import {
  applyDecision,
  computeChainEquitySeries,
  isDecisionDue,
  replaySegmentChain,
  type ApplyDecisionInput,
  type EngineSegment,
  type OpeningBook,
} from "./carryover.js";
import { computeRanking } from "./ranking.js";
import type { BarsBySymbol, EngineBar } from "./valuation.js";

const START = "2026-01-05";
const BASIS = 100000;

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

function makeBars(...symbolBars: Array<[string, EngineBar[]]>): BarsBySymbol {
  return new Map(symbolBars);
}

function book(overrides: Partial<OpeningBook> = {}): OpeningBook {
  return {
    cash: 0,
    shares: new Map(),
    costBasis: new Map(),
    targetWeights: new Map(),
    ...overrides,
  };
}

/** A single-name all-AAPL book at a 100 basis, the common chain fixture. */
function aaplBook(shares: number): OpeningBook {
  return book({
    shares: new Map([["AAPL", shares]]),
    costBasis: new Map([["AAPL", 100]]),
    targetWeights: new Map([["AAPL", 1]]),
  });
}

function decision(overrides: Partial<ApplyDecisionInput> = {}): ApplyDecisionInput {
  return {
    openingBook: book(),
    basisCapital: BASIS,
    targets: [],
    prices: {},
    asOfTradeDate: START,
    ...overrides,
  };
}

/** One-segment chain fixture: `[symbol, closes]` bars plus a decision. */
function segment(overrides: Partial<EngineSegment> = {}): EngineSegment {
  return {
    roundId: "r1",
    roundSeq: 0,
    openTradeDate: START,
    decideTradeDate: START,
    basisCapital: BASIS,
    window: "daily",
    openingBook: book({ cash: BASIS }),
    decisions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// applyDecision
// ---------------------------------------------------------------------------

describe("applyDecision", () => {
  it("opens a fresh book from cash into the target weights", () => {
    const result = applyDecision(
      decision({
        openingBook: book({ cash: BASIS }),
        targets: [
          { symbol: "AAPL", targetWeight: 0.5 },
          { symbol: "MSFT", targetWeight: 0.5 },
        ],
        prices: { AAPL: 100, MSFT: 200 },
      }),
    );

    expect(result.totalValue).toBeCloseTo(BASIS, 6);
    expect(result.nextBook.shares.get("AAPL")).toBeCloseTo(500, 6);
    expect(result.nextBook.shares.get("MSFT")).toBeCloseTo(250, 6);
    expect(result.nextBook.cash).toBeCloseTo(0, 6);
    // A fresh lot's unit cost is its fill price.
    expect(result.nextBook.costBasis.get("AAPL")).toBeCloseTo(100, 6);
    expect(result.nextBook.costBasis.get("MSFT")).toBeCloseTo(200, 6);
    expect(result.fills.map((f) => f.side)).toEqual(["buy", "buy"]);
    expect(result.realizedPnl).toBe(0);
  });

  it("liquidates a line fully on targetWeight 0 and routes proceeds to cash", () => {
    const openingBook = book({
      cash: 0,
      shares: new Map([
        ["AAPL", 500],
        ["MSFT", 250],
      ]),
      costBasis: new Map([
        ["AAPL", 80],
        ["MSFT", 200],
      ]),
      targetWeights: new Map([
        ["AAPL", 0.5],
        ["MSFT", 0.5],
      ]),
    });

    const result = applyDecision(
      decision({
        openingBook,
        targets: [
          { symbol: "AAPL", targetWeight: 0 },
          { symbol: "MSFT", targetWeight: 0.5 },
        ],
        prices: { AAPL: 120, MSFT: 200 },
      }),
    );

    // Mark: 500×120 + 250×200 = 110000. MSFT holds its 0.5 target exactly.
    expect(result.totalValue).toBeCloseTo(110000, 6);
    // AAPL is gone from the book entirely — no zero-share lot left behind.
    expect(result.nextBook.shares.has("AAPL")).toBe(false);
    expect(result.nextBook.costBasis.has("AAPL")).toBe(false);
    expect(result.nextBook.targetWeights.has("AAPL")).toBe(false);
    // MSFT's 0.5 target absorbs 55000 of the 110000 mark, leaving 55000 cash.
    expect(result.nextBook.shares.get("MSFT")).toBeCloseTo(275, 6);
    expect(result.nextBook.cash).toBeCloseTo(55000, 6);
    // Realized P&L = 500 × (120 − 80).
    expect(result.realizedPnl).toBeCloseTo(20000, 6);
    const aaplFill = result.fills.find((f) => f.symbol === "AAPL");
    expect(aaplFill?.side).toBe("sell");
    expect(aaplFill?.shares).toBeCloseTo(500, 6);
    expect(aaplFill?.realizedPnl).toBeCloseTo(20000, 6);
    const msftFill = result.fills.find((f) => f.symbol === "MSFT");
    expect(msftFill?.side).toBe("buy");
    expect(msftFill?.realizedPnl).toBe(0);
  });

  it("trims partially and keeps the per-share cost basis untouched", () => {
    // 1000 AAPL @ basis 50 = 50000 of a 100000 book (the other 50000 is cash).
    const openingBook = book({
      cash: 50000,
      shares: new Map([["AAPL", 1000]]),
      costBasis: new Map([["AAPL", 50]]),
      targetWeights: new Map([["AAPL", 0.5]]),
    });

    const result = applyDecision(
      decision({
        openingBook,
        targets: [{ symbol: "AAPL", targetWeight: 0.25 }],
        prices: { AAPL: 100 },
      }),
    );

    expect(result.totalValue).toBeCloseTo(150000, 6);
    // 0.25 × 150000 / 100 = 375 shares: 625 sold, 375 retained.
    expect(result.nextBook.shares.get("AAPL")).toBeCloseTo(375, 6);
    expect(result.nextBook.costBasis.get("AAPL")).toBeCloseTo(50, 6);
    expect(result.nextBook.cash).toBeCloseTo(50000 + 62500, 6);
    const fill = result.fills[0];
    expect(fill?.side).toBe("sell");
    expect(fill?.shares).toBeCloseTo(625, 6);
    expect(result.realizedPnl).toBeCloseTo(625 * 50, 6);
  });

  it("blends the cost basis shares-weighted when a held line is added to", () => {
    const openingBook = book({
      cash: 0,
      shares: new Map([
        ["AAPL", 100],
        ["MSFT", 100],
      ]),
      costBasis: new Map([
        ["AAPL", 50],
        ["MSFT", 100],
      ]),
      targetWeights: new Map([
        ["AAPL", 0.5],
        ["MSFT", 0.5],
      ]),
    });

    const result = applyDecision(
      decision({
        openingBook,
        targets: [
          { symbol: "AAPL", targetWeight: 0.75 },
          { symbol: "MSFT", targetWeight: 0.25 },
        ],
        prices: { AAPL: 100, MSFT: 100 },
      }),
    );

    expect(result.totalValue).toBeCloseTo(20000, 6);
    // AAPL 0.75 of 20000 / 100 = 150 shares: 50 bought on top of 100 held.
    expect(result.nextBook.shares.get("AAPL")).toBeCloseTo(150, 6);
    // (100 retained × 50) + (50 bought × 100) = 10000 over 150 shares.
    expect(result.nextBook.costBasis.get("AAPL")).toBeCloseTo(10000 / 150, 6);
    const aaplFill = result.fills.find((f) => f.symbol === "AAPL");
    expect(aaplFill?.side).toBe("buy");
    expect(aaplFill?.shares).toBeCloseTo(50, 6);
    // MSFT is trimmed, so its unit cost is untouched and it realizes nothing.
    expect(result.nextBook.costBasis.get("MSFT")).toBeCloseTo(100, 6);
    expect(result.realizedPnl).toBe(0);
  });

  it("treats a zero-delta line as a hold with no trade and no realized P&L", () => {
    const openingBook = book({
      cash: 0,
      shares: new Map([["AAPL", 500]]),
      costBasis: new Map([["AAPL", 90]]),
      targetWeights: new Map([["AAPL", 1]]),
    });

    const result = applyDecision(
      decision({
        openingBook,
        targets: [{ symbol: "AAPL", targetWeight: 1 }],
        prices: { AAPL: 100 },
      }),
    );

    const fill = result.fills[0];
    expect(fill?.side).toBe("hold");
    expect(fill?.shares).toBe(0);
    expect(fill?.realizedPnl).toBe(0);
    expect(result.realizedPnl).toBe(0);
    // The book is byte-identical: no re-size, no basis drift, no cash churn.
    // Note the 10 unrealized gain per share is NOT realized by a hold.
    expect(result.nextBook.shares.get("AAPL")).toBe(500);
    expect(result.nextBook.costBasis.get("AAPL")).toBe(90);
    expect(result.nextBook.cash).toBe(0);
  });

  it("preserves total value at the decision close", () => {
    const openingBook = book({
      cash: 1000,
      shares: new Map([["AAPL", 100]]),
      costBasis: new Map([["AAPL", 50]]),
      targetWeights: new Map([["AAPL", 1]]),
    });

    const result = applyDecision(
      decision({
        openingBook,
        targets: [
          { symbol: "AAPL", targetWeight: 0.3 },
          { symbol: "MSFT", targetWeight: 0.7 },
        ],
        prices: { AAPL: 100, MSFT: 10 },
      }),
    );

    // 1000 + 100×100 = 11000 marked, and the new book is worth exactly that.
    const holdings = [...result.nextBook.shares].reduce(
      (acc, [symbol, shares]) =>
        acc + shares * (result.fills.find((f) => f.symbol === symbol)?.price ?? 0),
      0,
    );
    expect(result.nextBook.cash + holdings).toBeCloseTo(11000, 6);
  });

  it("rescales an over-allocated book so cash lands on 0, not negative", () => {
    // Σ = 1.001, the top of the admitted [0.99, 1.01] band. Unscaled this would
    // size 100100 of a 100000 mark and leave cash at −100.
    const result = applyDecision(
      decision({
        openingBook: book({ cash: BASIS }),
        targets: [
          { symbol: "AAPL", targetWeight: 0.5005 },
          { symbol: "MSFT", targetWeight: 0.5005 },
        ],
        prices: { AAPL: 100, MSFT: 200 },
      }),
    );

    expect(result.totalValue).toBeCloseTo(BASIS, 6);
    expect(result.nextBook.cash).toBeCloseTo(0, 9);
    const holdings = [...result.nextBook.shares].reduce(
      (acc, [symbol, shares]) =>
        acc + shares * (result.fills.find((f) => f.symbol === symbol)?.price ?? 0),
      0,
    );
    expect(result.nextBook.cash + holdings).toBeCloseTo(BASIS, 9);
    // Every stored weight is the rescaled one, so the persisted book is
    // self-consistent with the shares it sized.
    expect(result.nextBook.targetWeights.get("AAPL")).toBeCloseTo(0.5005 / 1.001, 9);
    expect(result.nextBook.targetWeights.get("MSFT")).toBeCloseTo(0.5005 / 1.001, 9);
  });

  it("preserves residual cash when the book is under-allocated", () => {
    // Σ = 0.99 ≤ 1: no rescale, so 1% of the mark stays in cash.
    const result = applyDecision(
      decision({
        openingBook: book({ cash: BASIS }),
        targets: [
          { symbol: "AAPL", targetWeight: 0.495 },
          { symbol: "MSFT", targetWeight: 0.495 },
        ],
        prices: { AAPL: 100, MSFT: 200 },
      }),
    );

    expect(result.nextBook.cash).toBeCloseTo(BASIS * 0.01, 6);
    expect(result.nextBook.targetWeights.get("AAPL")).toBeCloseTo(0.495, 9);
  });

  it("leaves an exactly-fully-invested book unchanged", () => {
    // Σ = 1.0: scale is 1, so the fold is byte-for-byte the pre-rescale behavior.
    const result = applyDecision(
      decision({
        openingBook: book({ cash: BASIS }),
        targets: [
          { symbol: "AAPL", targetWeight: 0.5 },
          { symbol: "MSFT", targetWeight: 0.5 },
        ],
        prices: { AAPL: 100, MSFT: 200 },
      }),
    );

    expect(result.nextBook.cash).toBeCloseTo(0, 9);
    expect(result.nextBook.targetWeights.get("AAPL")).toBeCloseTo(0.5, 9);
  });
});

// ---------------------------------------------------------------------------
// computeChainEquitySeries
// ---------------------------------------------------------------------------

describe("computeChainEquitySeries", () => {
  it("drifts day to day with fixed shares and fixed cash, and never re-snaps", () => {
    const days = tradeDates(4);
    const series = computeChainEquitySeries(
      [
        segment({
          openTradeDate: days[0],
          decideTradeDate: days[3],
          openingBook: aaplBook(500),
          decisions: [{ symbol: "AAPL", targetWeight: 1 }],
        }),
      ],
      makeBars(["AAPL", bars("AAPL", [100, 110, 120, 130])]),
    );

    expect(series).toHaveLength(4);
    // Shares stay at 500 for every day — a 4-day window under a `daily` window
    // would have re-snapped 3 times if the legacy cadence were in play.
    expect(series[1]?.holdingsValue).toBeCloseTo(500 * 110, 6);
    expect(series[3]?.holdingsValue).toBeCloseTo(500 * 130, 6);
    expect(series[3]?.totalValue).toBeCloseTo(65000, 6);
    expect(series[3]?.returnPct).toBeCloseTo(-35, 6);
    for (const point of series) expect(point.cash).toBe(0);
  });

  it("measures returnPct against the chain basis, not the first segment's mark", () => {
    const days = tradeDates(2);
    const series = computeChainEquitySeries(
      [
        segment({
          roundSeq: 0,
          openTradeDate: days[0],
          decideTradeDate: days[0],
          openingBook: aaplBook(1000),
          decisions: [{ symbol: "AAPL", targetWeight: 1 }],
        }),
        segment({ roundId: "r2", roundSeq: 1, openTradeDate: days[1], decideTradeDate: days[1] }),
      ],
      makeBars(["AAPL", bars("AAPL", [100, 110])]),
    );

    expect(series).toHaveLength(2);
    expect(series[0]?.totalValue).toBeCloseTo(100000, 6);
    expect(series[0]?.returnPct).toBeCloseTo(0, 6);
    expect(series[1]?.totalValue).toBeCloseTo(110000, 6);
    expect(series[1]?.returnPct).toBeCloseTo(10, 6);
  });

  it("keeps segments contiguous and emits one point per trading day", () => {
    const days = tradeDates(4);
    const series = computeChainEquitySeries(
      [
        segment({
          roundSeq: 0,
          openTradeDate: days[0],
          decideTradeDate: days[1],
          openingBook: aaplBook(1000),
          decisions: [{ symbol: "AAPL", targetWeight: 1 }],
        }),
        segment({ roundId: "r2", roundSeq: 1, openTradeDate: days[2], decideTradeDate: days[3] }),
      ],
      makeBars(["AAPL", bars("AAPL", [100, 101, 102, 103])]),
    );

    expect(series.map((p) => p.tradeDate)).toEqual(days);
    // Consecutive points, which is exactly what sharpe/vol/drawdown require.
    expect(series.map((p) => p.totalValue)).toEqual([100000, 101000, 102000, 103000]);
  });

  it("deduplicates a trade date emitted by two segments, last write wins", () => {
    const days = tradeDates(3);
    // Segment 1 holds AAPL. Segment 2 MISSPECIFIES its open day as segment 1's
    // decide date — the later segment must win, and the date appears once.
    const series = computeChainEquitySeries(
      [
        segment({
          roundSeq: 0,
          openTradeDate: days[0],
          decideTradeDate: days[1],
          openingBook: aaplBook(1000),
          decisions: [{ symbol: "AAPL", targetWeight: 1 }],
        }),
        segment({
          roundId: "r2",
          roundSeq: 1,
          openTradeDate: days[1],
          decideTradeDate: days[2],
          decisions: [{ symbol: "AAPL", targetWeight: 0.5 }],
        }),
      ],
      makeBars(["AAPL", bars("AAPL", [100, 110, 121])]),
    );

    expect(series.map((p) => p.tradeDate)).toEqual([days[0], days[1], days[2]]);
    // days[1] is written twice: once by each segment. The later, post-decision
    // book wins, and a zero-cost trade at the mark leaves the total unchanged.
    expect(series[1]?.totalValue).toBeCloseTo(110000, 6);
    expect(series[1]?.holdingsValue).toBeCloseTo(110000, 6);
    // The decide-date point equals the post-decision book because the fold is
    // value-preserving, so the boundary joins the two segments seamlessly.
    expect(series[2]?.totalValue).toBeCloseTo(121000, 6);
    expect(series[2]?.returnPct).toBeCloseTo(21, 6);
  });

  it("carries the decided book into the next segment's mark", () => {
    const days = tradeDates(3);
    // Round 1: 100% AAPL. Round 2 moves the whole book into MSFT.
    const series = computeChainEquitySeries(
      [
        segment({
          roundSeq: 0,
          openTradeDate: days[0],
          decideTradeDate: days[0],
          openingBook: book({ cash: BASIS }),
          decisions: [{ symbol: "AAPL", targetWeight: 1 }],
        }),
        segment({
          roundSeq: 1,
          openTradeDate: days[1],
          decideTradeDate: days[1],
          decisions: [{ symbol: "MSFT", targetWeight: 1 }],
        }),
      ],
      makeBars(["AAPL", bars("AAPL", [100, 100])], ["MSFT", bars("MSFT", [50, 50])]),
    );

    expect(series.map((p) => p.totalValue)).toEqual([100000, 100000]);
    // Round 2 traded 2000 AAPL into 2000 MSFT, so cash is zero on the last day.
    expect(series[1]?.cash).toBe(0);
    expect(series[1]?.holdingsValue).toBeCloseTo(2000 * 50, 6);
  });

  it("spans its own dates when the segment opens all-cash", () => {
    const days = tradeDates(3);
    // Round 1 holds nothing yet: the pre-decision days are a flat cash series,
    // and they must still be emitted or the chain's first point is not its start.
    const series = computeChainEquitySeries(
      [
        segment({
          openTradeDate: days[0],
          decideTradeDate: days[2],
          openingBook: book({ cash: BASIS }),
          decisions: [{ symbol: "AAPL", targetWeight: 1 }],
        }),
      ],
      makeBars(["AAPL", bars("AAPL", [100, 110, 120])]),
    );

    expect(series.map((p) => p.tradeDate)).toEqual(days);
    expect(series[0]?.totalValue).toBeCloseTo(BASIS, 6);
    expect(series[0]?.holdingsValue).toBe(0);
    expect(series[1]?.totalValue).toBeCloseTo(BASIS, 6);
    expect(series[2]?.totalValue).toBeCloseTo(BASIS, 6);
  });

  it("forward-fills a halted symbol across a segment window", () => {
    const days = tradeDates(3);
    const series = computeChainEquitySeries(
      [
        segment({
          openTradeDate: days[0],
          decideTradeDate: days[2],
          openingBook: book({
            cash: 0,
            shares: new Map([
              ["AAPL", 500],
              ["MSFT", 250],
            ]),
            costBasis: new Map([
              ["AAPL", 100],
              ["MSFT", 200],
            ]),
            targetWeights: new Map([
              ["AAPL", 0.5],
              ["MSFT", 0.5],
            ]),
          }),
        }),
      ],
      makeBars(
        ["AAPL", bars("AAPL", [100, 100, 100])],
        // MSFT has no bar on days[1] — a halt.
        [
          "MSFT",
          [bars("MSFT", [200])[0] as EngineBar, bars("MSFT", [200], days[2])[0] as EngineBar],
        ],
      ),
    );

    expect(series).toHaveLength(3);
    expect(series[1]?.holdingsValue).toBeCloseTo(500 * 100 + 250 * 200, 6);
  });

  it("returns an empty series when there are no segments", () => {
    expect(computeChainEquitySeries([], makeBars())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// replaySegmentChain
// ---------------------------------------------------------------------------

describe("replaySegmentChain", () => {
  it("folds segments from round 1 forward to the final book", () => {
    const days = tradeDates(2);
    const { finalBook, steps } = replaySegmentChain(
      [
        segment({
          roundSeq: 0,
          openTradeDate: days[0],
          decideTradeDate: days[0],
          openingBook: book({ cash: BASIS }),
          decisions: [
            { symbol: "AAPL", targetWeight: 0.5 },
            { symbol: "MSFT", targetWeight: 0.5 },
          ],
        }),
        segment({
          roundId: "r2",
          roundSeq: 1,
          openTradeDate: days[1],
          decideTradeDate: days[1],
          decisions: [
            { symbol: "AAPL", targetWeight: 0 },
            { symbol: "MSFT", targetWeight: 1 },
          ],
        }),
      ],
      makeBars(["AAPL", bars("AAPL", [100, 120])], ["MSFT", bars("MSFT", [200, 200])]),
    );

    expect(steps).toHaveLength(2);
    expect(steps[0]?.roundId).toBe("r1");
    expect(steps[0]?.totalValue).toBeCloseTo(BASIS, 6);
    expect(steps[1]?.roundId).toBe("r2");
    // Round 2 marked 500×120 + 250×200 = 110000 and liquidated AAPL for a
    // 500 × (120 − 100) gain; its 60000 proceeds plus 50000 of MSFT marks the
    // 1.0 target as 550 shares.
    expect(steps[1]?.totalValue).toBeCloseTo(110000, 6);
    expect(steps[1]?.realizedPnl).toBeCloseTo(10000, 6);
    expect(finalBook.shares.has("AAPL")).toBe(false);
    expect(finalBook.shares.get("MSFT")).toBeCloseTo(550, 6);
    expect(finalBook.costBasis.get("MSFT")).toBeCloseTo(200, 6);
    expect(finalBook.cash).toBe(0);
    expect(finalBook.targetWeights.get("MSFT")).toBe(1);
  });

  it("ignores a stale openingBook on segments after the first", () => {
    const { finalBook } = replaySegmentChain(
      [
        segment({ roundSeq: 0, openingBook: book({ cash: BASIS }), decisions: [] }),
        segment({ roundSeq: 1, openingBook: book({ cash: 0 }), decisions: [] }),
      ],
      makeBars(),
    );

    expect(finalBook.cash).toBe(BASIS);
  });

  it("returns an empty book for an empty chain", () => {
    const { finalBook, steps } = replaySegmentChain([], makeBars());
    expect(steps).toEqual([]);
    expect(finalBook.cash).toBe(0);
    expect(finalBook.shares.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isDecisionDue
// ---------------------------------------------------------------------------

describe("isDecisionDue", () => {
  it("is due once the window's cadence in trading days has elapsed", () => {
    expect(isDecisionDue({ window: "daily", tradingDaysSinceLastDecision: 1 })).toBe(true);
    expect(isDecisionDue({ window: "weekly", tradingDaysSinceLastDecision: 4 })).toBe(false);
    expect(isDecisionDue({ window: "weekly", tradingDaysSinceLastDecision: 5 })).toBe(true);
    expect(isDecisionDue({ window: "monthly", tradingDaysSinceLastDecision: 20 })).toBe(false);
    expect(isDecisionDue({ window: "monthly", tradingDaysSinceLastDecision: 21 })).toBe(true);
  });

  it("is always due on a stream's first round", () => {
    expect(isDecisionDue({ window: "monthly", tradingDaysSinceLastDecision: null })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeRanking overload
// ---------------------------------------------------------------------------

describe("computeRanking with an injected basis", () => {
  const series = [
    { tradeDate: "2026-01-05", cash: 0, holdingsValue: 110000, totalValue: 110000, returnPct: 10 },
    { tradeDate: "2026-01-06", cash: 0, holdingsValue: 121000, totalValue: 121000, returnPct: 21 },
  ];

  it("defaults to the first point's value, matching the legacy bare-array call", () => {
    expect(computeRanking(series)).toEqual(computeRanking({ equitySeries: series }));
    expect(computeRanking(series).totalReturnPct).toBeCloseTo(10, 6);
  });

  it("uses the chain basis as the return denominator when injected", () => {
    const ranking = computeRanking({ equitySeries: series, basisCapital: 100000 });
    expect(ranking.totalReturnPct).toBeCloseTo(21, 6);
    expect(ranking.currentValue).toBeCloseTo(121000, 6);
    // Sharpe, vol and drawdown are basis-independent and must not move.
    const legacy = computeRanking(series);
    expect(ranking.sharpe).toBe(legacy.sharpe);
    expect(ranking.annualizedVolPct).toBe(legacy.annualizedVolPct);
    expect(ranking.maxDrawdownPct).toBe(legacy.maxDrawdownPct);
  });

  it("compounds a chain series instead of resetting at each segment boundary", () => {
    const days = tradeDates(3);
    const chain = computeChainEquitySeries(
      [
        segment({
          roundSeq: 0,
          openTradeDate: days[0],
          decideTradeDate: days[1],
          openingBook: aaplBook(1000),
          decisions: [{ symbol: "AAPL", targetWeight: 1 }],
        }),
        segment({ roundId: "r2", roundSeq: 1, openTradeDate: days[2], decideTradeDate: days[2] }),
      ],
      makeBars(["AAPL", bars("AAPL", [100, 110, 121])]),
    );

    expect(chain.map((p) => p.totalValue)).toEqual([100000, 110000, 121000]);
    const ranking = computeRanking({ equitySeries: chain, basisCapital: BASIS });
    expect(ranking.totalReturnPct).toBeCloseTo(21, 6);
    expect(ranking.asOfTradeDate).toBe(days[2]);
    // A drift-free chain has zero volatility and a zero-reward Sharpe.
    expect(ranking.annualizedVolPct).toBe(0);
    expect(ranking.maxDrawdownPct).toBe(0);
  });
});
