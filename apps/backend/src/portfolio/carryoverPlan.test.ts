/**
 * Pure-math unit tests for the carryover planners and the rerun policy
 * (beads task 800.4, W4).
 *
 * No DB, no network — inline fixtures, same discipline as `carryover.test.ts`.
 * The centrepiece is the equivalence proof: folding a chain in ONE pass
 * (`planChainRebuild`) must equal folding it one round at a time
 * (`planRoundFold`), because the cache is disposable and a rebuild must never
 * disagree with the incremental fold that produced it.
 */

import { describe, expect, it } from "vitest";
import {
  BackdatedRoundError,
  planChainRebuild,
  planRoundFold,
  toLotSnapshots,
  toStateSnapshot,
  type ChainRoundInput,
  type LotSnapshot,
  type StateSnapshot,
  type StreamKey,
  type StreamWritePlan,
} from "./carryoverPlan.js";
import { decideRerun, type ExistingRound } from "./rerunPolicy.js";
import type { BarsBySymbol, EngineBar } from "./valuation.js";

const BASIS = 100000;
const KEY: StreamKey = { simulationId: "sim-t1", personaKey: "dr-value", window: "daily" };

function tradeDates(count: number, start: string): string[] {
  const dates: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < count; i += 1) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

/** Weekdays only, so `nextTradingDate` never lands on a missing bar. */
function sessions(count: number, start = "2026-01-05"): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  while (out.length < count) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function barSeries(closes: readonly number[], dates: readonly string[]): EngineBar[] {
  return closes.map((close, i) => ({ tradeDate: dates[i]!, close }));
}

/** 20 sessions of bars for the given symbols, each on its own price path. */
function makeBars(dates: readonly string[], paths: Record<string, readonly number[]>): BarsBySymbol {
  const map = new Map<string, EngineBar[]>();
  for (const [symbol, closes] of Object.entries(paths)) {
    map.set(symbol, barSeries(closes, dates));
  }
  return map;
}

const AAPL = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109];
const MSFT = [200, 199, 201, 203, 202, 204, 206, 205, 207, 209];
const TSLA = [50, 52, 49, 51, 53, 55, 54, 56, 58, 60];

/** Three sessions of decisions across the 20-session bar grid. */
const DATES = sessions(20);
const BARS = makeBars(DATES, { AAPL, MSFT, TSLA });

const ROUNDS: ChainRoundInput[] = [
  {
    roundId: "r1",
    roundSeq: 1,
    decideTradeDate: DATES[0]!,
    targets: [
      { symbol: "AAPL", targetWeight: 0.6 },
      { symbol: "MSFT", targetWeight: 0.4 },
    ],
    theses: new Map([["AAPL", "cheap"], ["MSFT", "quality"]]),
  },
  {
    roundId: "r2",
    roundSeq: 2,
    decideTradeDate: DATES[4]!,
    targets: [
      { symbol: "AAPL", targetWeight: 0.4 },
      { symbol: "MSFT", targetWeight: 0.3 },
      { symbol: "TSLA", targetWeight: 0.3 },
    ],
    theses: new Map([["TSLA", "momentum"]]),
  },
  {
    roundId: "r3",
    roundSeq: 3,
    decideTradeDate: DATES[9]!,
    // Full liquidation: every target weight is an explicit zero.
    targets: [
      { symbol: "AAPL", targetWeight: 0 },
      { symbol: "MSFT", targetWeight: 0 },
      { symbol: "TSLA", targetWeight: 0 },
    ],
  },
];

/** Fold the chain one round at a time, feeding each plan's output back in. */
function foldIncrementally(rounds: readonly ChainRoundInput[]): StreamWritePlan[] {
  const plans: StreamWritePlan[] = [];
  let state: StateSnapshot | null = null;
  let lots: LotSnapshot[] = [];
  for (const round of rounds) {
    const plan = planRoundFold({ key: KEY, round, basisCapital: BASIS, currentState: state, currentLots: lots, bars: BARS });
    plans.push(plan);
    state = toStateSnapshot(plan.state!);
    lots = toLotSnapshots(plan.lots);
  }
  return plans;
}

/**
 * The two code paths cannot agree bit-for-bit and are not expected to: the
 * incremental fold re-opens each round from the CACHE, so its opening book has
 * been through a decimal round-trip, while the rebuild carries full float
 * precision in memory. Each fold therefore contributes up to one unit of
 * round-trip error in the last stored place, and the bound has to grow with the
 * fold count. Comparing in integer units of the stored scale (rather than as
 * floats) keeps that exact and immune to float noise.
 */
const STORED_SCALE = 4;
const STORED_UNITS_PER_FOLD = 1;

function storedUnits(value: string | number): number {
  return Math.round(Number(value) * 10 ** STORED_SCALE);
}

function expectMoneyEqual(actual: string | number, expected: string | number, folds = 1): void {
  expect(Math.abs(storedUnits(actual) - storedUnits(expected))).toBeLessThanOrEqual(
    STORED_UNITS_PER_FOLD * folds,
  );
  const scale = Math.max(Math.abs(Number(actual)), Math.abs(Number(expected)), 1);
  expect(Math.abs(Number(actual) - Number(expected)) / scale).toBeLessThan(1e-7);
}

describe("planChainRebuild vs planRoundFold", () => {
  it("agrees on the final book to the precision the cache stores", () => {
    const rebuilt = planChainRebuild({ key: KEY, basisCapital: BASIS, rounds: ROUNDS, bars: BARS });
    const last = foldIncrementally(ROUNDS).at(-1)!;

    expect(rebuilt.state?.seq).toBe(last.state?.seq);
    expect(rebuilt.state?.lastRoundId).toBe(last.state?.lastRoundId);
    expect(rebuilt.state?.lastTradeDate).toBe(last.state?.lastTradeDate);
    expect(rebuilt.state?.simulationId).toBe(last.state?.simulationId);
    expect(rebuilt.state?.personaKey).toBe(last.state?.personaKey);
    expect(rebuilt.state?.window).toBe(last.state?.window);
    expect(rebuilt.state?.targetJson).toEqual(last.state?.targetJson);
    expect(rebuilt.lots).toEqual(last.lots);
    expect(rebuilt.summary.seq).toBe(last.summary.seq);
    expect(rebuilt.summary.positionCount).toBe(last.summary.positionCount);

    for (const field of ["cash", "holdingsValue", "totalValue", "initialCapital"] as const) {
      expectMoneyEqual(rebuilt.state![field], last.state![field], ROUNDS.length);
    }
    for (const field of ["cash", "holdingsValue", "totalValue"] as const) {
      expectMoneyEqual(rebuilt.summary[field], last.summary[field], ROUNDS.length);
    }
  });

  it("covers the same trading days in both paths", () => {
    const rebuilt = planChainRebuild({ key: KEY, basisCapital: BASIS, rounds: ROUNDS, bars: BARS });
    // Each incremental plan carries only the days ITS round added — that is
    // what makes the write an upsert of a gap rather than a rewrite — so the
    // full curve is their concatenation.
    const stitched = foldIncrementally(ROUNDS)
      .flatMap((plan) => plan.equity)
      .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));

    expect(rebuilt.equity.map((point) => point.tradeDate)).toEqual(
      stitched.map((point) => point.tradeDate),
    );
    expect(rebuilt.equity).toHaveLength(stitched.length);
    for (const [i, point] of rebuilt.equity.entries()) {
      const other = stitched[i]!;
      for (const field of ["cash", "holdingsValue", "totalValue"] as const) {
        expectMoneyEqual(point[field], other[field], ROUNDS.length);
      }
      expect(point.roundSeq).toBe(other.roundSeq);
    }
  });

  it("is insensitive to the order the round history arrives in", () => {
    const ordered = planChainRebuild({ key: KEY, basisCapital: BASIS, rounds: ROUNDS, bars: BARS });
    const shuffled = planChainRebuild({
      key: KEY,
      basisCapital: BASIS,
      rounds: [ROUNDS[2]!, ROUNDS[0]!, ROUNDS[1]!],
      bars: BARS,
    });
    expect(shuffled.state).toEqual(ordered.state);
    expect(shuffled.equity).toEqual(ordered.equity);
  });

  it("holds the chain basis from the simulation across every round", () => {
    const rebuilt = planChainRebuild({ key: KEY, basisCapital: BASIS, rounds: ROUNDS, bars: BARS });
    expect(rebuilt.state?.initialCapital).toBe("100000.00");
    // The first point is the entry day at basis, so the chain's return starts
    // at zero rather than at round 2's inflated portfolio value.
    expect(rebuilt.equity[0]?.totalValue).toBe("100000.0000");
  });
});

describe("planChainRebuild", () => {
  it("materializes nothing for an empty history", () => {
    const plan = planChainRebuild({ key: KEY, basisCapital: BASIS, rounds: [], bars: BARS });
    expect(plan.state).toBeNull();
    expect(plan.lots).toEqual([]);
    expect(plan.equity).toEqual([]);
  });

  it("drops every lot after a full liquidation but keeps the cash", () => {
    const plan = planChainRebuild({ key: KEY, basisCapital: BASIS, rounds: ROUNDS, bars: BARS });
    expect(plan.lots).toEqual([]);
    expect(Number.parseFloat(plan.state!.totalValue)).toBeCloseTo(
      Number.parseFloat(plan.state!.cash),
      6,
    );
  });

  it("keeps the chain contiguous and date-deduplicated", () => {
    const plan = planChainRebuild({ key: KEY, basisCapital: BASIS, rounds: ROUNDS, bars: BARS });
    const dates = plan.equity.map((point) => point.tradeDate);
    expect(new Set(dates).size).toBe(dates.length);
    expect([...dates]).toEqual([...dates].sort());
  });

  it("carries lot provenance from the round that opened each line", () => {
    const plan = planChainRebuild({ key: KEY, basisCapital: BASIS, rounds: ROUNDS.slice(0, 2), bars: BARS });
    const tsla = plan.lots.find((lot) => lot.symbol === "TSLA");
    expect(tsla?.openedFromRoundId).toBe("r2");
    expect(tsla?.openedTradeDate).toBe(DATES[4]);
    expect(tsla?.thesis).toBe("momentum");
  });
});

describe("planRoundFold", () => {
  it("rejects a round at or before the cached chain position", () => {
    expect(() =>
      planRoundFold({
        key: KEY,
        round: ROUNDS[1]!,
        basisCapital: BASIS,
        currentState: {
          seq: 2,
          lastTradeDate: DATES[4]!,
          lastRoundId: "r2",
          cash: 0,
          holdingsValue: 0,
          totalValue: 0,
        },
        currentLots: [],
        bars: BARS,
      }),
    ).toThrow(BackdatedRoundError);
  });

  it("reports both positions on a backdated round so the caller can name them", () => {
    try {
      planRoundFold({
        key: KEY,
        round: ROUNDS[0]!,
        basisCapital: BASIS,
        currentState: { seq: 3, lastTradeDate: DATES[9]!, lastRoundId: "r3", cash: 0, holdingsValue: 0, totalValue: 0 },
        currentLots: [],
        bars: BARS,
      });
      expect.unreachable("a backdated round must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BackdatedRoundError);
      expect((err as BackdatedRoundError).roundSeq).toBe(1);
      expect((err as BackdatedRoundError).streamSeq).toBe(3);
    }
  });

  it("opens a first round from cash alone", () => {
    const plan = planRoundFold({ key: KEY, round: ROUNDS[0]!, basisCapital: BASIS, currentState: null, currentLots: [], bars: BARS });
    expect(plan.state?.seq).toBe(1);
    expect(plan.lots).toHaveLength(2);
  });
});

describe("decideRerun", () => {
  const base = {
    replace: false,
    asOfTradeDate: "2026-01-20",
    latestTradeDate: "2026-01-20",
    streamLastTradeDates: ["2026-01-16"],
  };

  const done = (roundId: string, roundSeq = 1): ExistingRound => ({
    roundId,
    status: "done",
    roundSeq,
  });

  it("allows a new chain position on a fresh date", () => {
    const decision = decideRerun({ ...base, existingRounds: [] });
    expect(decision).toEqual({ ok: true, action: "insert", replaceRoundIds: [] });
  });

  it("reports SAME_TRADE_DATE for a round still in flight", () => {
    const decision = decideRerun({
      ...base,
      existingRounds: [{ roundId: "r9", status: "running", roundSeq: 1 }],
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("SAME_TRADE_DATE");
    expect(decision.terminal).toBe(false);
    expect(decision.detail.roundIds).toEqual(["r9"]);
  });

  it("reports ROUND_ALREADY_COMPLETE for a finished round and names replace as the way out", () => {
    const decision = decideRerun({ ...base, existingRounds: [done("r7")] });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("ROUND_ALREADY_COMPLETE");
    expect(decision.terminal).toBe(true);
    expect(decision.hint).toContain("replace=true");
  });

  it("turns a finished round into a replace when asked", () => {
    const decision = decideRerun({ ...base, replace: true, existingRounds: [done("r7", 4)] });
    expect(decision).toEqual({ ok: true, action: "replace", replaceRoundIds: ["r7"] });
  });

  it("reports STALE_TRADE_DATE when the feed has not moved past the book", () => {
    const decision = decideRerun({
      ...base,
      asOfTradeDate: "2026-01-20",
      latestTradeDate: "2026-01-20",
      streamLastTradeDates: ["2026-01-20"],
      existingRounds: [],
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("STALE_TRADE_DATE");
  });

  it("reports STALE_TRADE_DATE when the dataset is ahead of the feed", () => {
    const decision = decideRerun({ ...base, asOfTradeDate: "2026-02-01", existingRounds: [] });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("STALE_TRADE_DATE");
  });

  it("reports OUT_OF_SEQUENCE for a back-dated round on a chain that has moved on", () => {
    const decision = decideRerun({
      ...base,
      asOfTradeDate: "2026-01-15",
      latestTradeDate: "2026-01-20",
      streamLastTradeDates: ["2026-01-16"],
      existingRounds: [],
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("OUT_OF_SEQUENCE");
    expect(decision.hint).toContain("2026-01-20");
  });

  it("reports STALE_TRADE_DATE when there are no prices at all", () => {
    const decision = decideRerun({ ...base, latestTradeDate: null, existingRounds: [] });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("STALE_TRADE_DATE");
  });

  it("does not let a first-round stream constrain the chain", () => {
    // Streams with no state place no constraint, so an empty list is correct.
    const decision = decideRerun({ ...base, streamLastTradeDates: [], existingRounds: [] });
    expect(decision.ok).toBe(true);
  });

  it("prefers the in-flight code over the finished one for a mixed same-date set", () => {
    const decision = decideRerun({
      ...base,
      existingRounds: [done("r7"), { roundId: "r8", status: "running", roundSeq: 2 }],
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("SAME_TRADE_DATE");
  });
});
