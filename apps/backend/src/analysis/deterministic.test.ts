/**
 * Unit tests for the backend analysis/decision layer (beads task vll.6).
 *
 * Pure/unit only — NO live database, NO network. `deterministic.ts` imports
 * `db` directly from `@model_md/database`, so that module is mocked with
 * `vi.mock("@model_md/database", ...)`: the real schema tables are kept
 * (via `importOriginal`) and only `db` is replaced by an in-memory chainable
 * `select` fake. `computeSignal` / `generateQuestions` are pure and tested
 * directly; `DeterministicProvider.analyze` is tested through the mocked db.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeterministicProvider, computeSignal, generateQuestions } from "./deterministic.js";
import { createProvider, DECISION_PROVIDER_NAMES } from "./registry.js";
import type { MetricBundle } from "./types.js";

// ---------------------------------------------------------------------------
// Module mock: keep the real schema tables, replace only `db`.
// ---------------------------------------------------------------------------

const dbMock = vi.hoisted(() => ({ select: vi.fn() }));

vi.mock("@model_md/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@model_md/database")>();
  return { ...actual, db: dbMock };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MetricsWithoutSignal = Omit<MetricBundle, "signal">;

function makeMetrics(overrides: Partial<MetricsWithoutSignal> = {}): MetricsWithoutSignal {
  return {
    tradeDate: "2026-09-22",
    close: 150,
    returns1d: null,
    returns5d: null,
    returns21d: null,
    returns63d: null,
    returns252d: null,
    volatility21d: null,
    sma50: null,
    sma200: null,
    sma50AboveSma200: null,
    rsi14: null,
    ...overrides,
  };
}

/** Rows as the DB returns them: newest first, numeric columns as strings. */
interface PriceRow {
  tradeDate: string;
  close: string | null;
  adjClose: string | null;
}

function tradeDates(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
  );
}

/**
 * Deterministic rising series: alternating +1 / -0.9 deltas give a gentle
 * uptrend (net +0.1 per pair) with a mid-band RSI (~52) — so the signal rule
 * falls through to trend + momentum instead of the RSI extremes.
 */
function risingSeries(count: number): number[] {
  const px: number[] = [100];
  for (let i = 1; i < count; i += 1) {
    px.push(px[i - 1] + (i % 2 === 1 ? 1 : -0.9));
  }
  return px;
}

function newestFirstRows(px: readonly number[]): PriceRow[] {
  const dates = tradeDates(px.length);
  const rows = px.map((value, i) => ({
    tradeDate: dates[i],
    close: value.toFixed(4),
    adjClose: value.toFixed(4),
  }));
  return rows.reverse();
}

/** Point `db.select(...)` at a chainable fake resolving to `rows`. */
function mockRows(rows: readonly PriceRow[]): void {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: (_n: number) => Promise.resolve([...rows]),
  };
  dbMock.select.mockReturnValue(chain);
}

function expectNumber(value: number | null): number {
  if (value === null) throw new Error("expected a number, got null");
  return value;
}

// ---------------------------------------------------------------------------
// computeSignal
// ---------------------------------------------------------------------------

describe("computeSignal", () => {
  it("returns buy when RSI is at or below 30", () => {
    expect(computeSignal(makeMetrics({ rsi14: 30 }))).toBe("buy");
    expect(computeSignal(makeMetrics({ rsi14: 12.34 }))).toBe("buy");
  });

  it("returns sell when RSI is at or above 70", () => {
    expect(computeSignal(makeMetrics({ rsi14: 70 }))).toBe("sell");
    expect(computeSignal(makeMetrics({ rsi14: 88.5 }))).toBe("sell");
  });

  it("lets RSI extremes override trend and momentum", () => {
    expect(computeSignal(makeMetrics({ rsi14: 25, sma50AboveSma200: false, returns5d: -3 }))).toBe(
      "buy",
    );
    expect(computeSignal(makeMetrics({ rsi14: 75, sma50AboveSma200: true, returns5d: 3 }))).toBe(
      "sell",
    );
  });

  it("returns buy on a rising trend with positive 5d momentum", () => {
    expect(computeSignal(makeMetrics({ rsi14: 55, sma50AboveSma200: true, returns5d: 0.01 }))).toBe(
      "buy",
    );
  });

  it("returns sell on a falling trend with negative 5d momentum", () => {
    expect(
      computeSignal(makeMetrics({ rsi14: 45, sma50AboveSma200: false, returns5d: -0.01 })),
    ).toBe("sell");
  });

  it("returns hold when trend and momentum disagree", () => {
    expect(computeSignal(makeMetrics({ sma50AboveSma200: true, returns5d: -1 }))).toBe("hold");
    expect(computeSignal(makeMetrics({ sma50AboveSma200: false, returns5d: 1 }))).toBe("hold");
  });

  it("returns hold when inputs are missing or momentum is flat", () => {
    expect(computeSignal(makeMetrics())).toBe("hold");
    expect(computeSignal(makeMetrics({ sma50AboveSma200: true }))).toBe("hold");
    expect(computeSignal(makeMetrics({ returns5d: 2 }))).toBe("hold");
    expect(computeSignal(makeMetrics({ sma50AboveSma200: true, returns5d: 0 }))).toBe("hold");
  });
});

// ---------------------------------------------------------------------------
// generateQuestions
// ---------------------------------------------------------------------------

describe("generateQuestions", () => {
  const metrics: MetricBundle = {
    ...makeMetrics({ sma50AboveSma200: true, returns5d: 1.5, rsi14: 55 }),
    signal: "buy",
  };

  it("returns exactly three questions with stable ids", () => {
    const questions = generateQuestions("AAPL", metrics);
    expect(questions).toHaveLength(3);
    expect(questions.map((q) => q.id)).toEqual(["bias", "attractiveness", "thesis"]);
    // Stable across calls.
    expect(generateQuestions("AAPL", metrics).map((q) => q.id)).toEqual([
      "bias",
      "attractiveness",
      "thesis",
    ]);
  });

  it("emits the choice bias question with buy/hold/sell options and the signal", () => {
    const bias = generateQuestions("AAPL", metrics)[0];
    expect(bias?.type).toBe("choice");
    if (bias === undefined || bias.type !== "choice") {
      throw new Error("expected a choice question");
    }
    expect(bias.options).toEqual(["buy", "hold", "sell"]);
    expect(bias.prompt).toContain("Buy/Hold/Sell bias on AAPL");
    expect(bias.prompt).toContain("signal: buy");
  });

  it("seeds the bias prompt with a sell signal when the metrics say sell", () => {
    const sellMetrics: MetricBundle = { ...makeMetrics({ rsi14: 80 }), signal: "sell" };
    const bias = generateQuestions("MSFT", sellMetrics)[0];
    if (bias === undefined || bias.type !== "choice") {
      throw new Error("expected a choice question");
    }
    expect(bias.prompt).toContain("signal: sell");
  });

  it("emits the score question bounded 0-100 with symbol and trade date", () => {
    const score = generateQuestions("AAPL", metrics)[1];
    expect(score?.type).toBe("score");
    if (score === undefined || score.type !== "score") {
      throw new Error("expected a score question");
    }
    expect(score.min).toBe(0);
    expect(score.max).toBe(100);
    expect(score.prompt).toContain("AAPL");
    expect(score.prompt).toContain("2026-09-22");
  });

  it("emits the noul thesis question", () => {
    const thesis = generateQuestions("AAPL", metrics)[2];
    expect(thesis?.type).toBe("noul");
    if (thesis === undefined || thesis.type !== "noul") {
      throw new Error("expected a noul question");
    }
    expect(thesis.prompt).toContain("AAPL");
    expect(thesis.prompt).toContain("thesis");
  });
});

// ---------------------------------------------------------------------------
// DeterministicProvider.analyze
// ---------------------------------------------------------------------------

describe("DeterministicProvider.analyze", () => {
  const provider = new DeterministicProvider();

  beforeEach(() => {
    dbMock.select.mockReset();
  });

  it("computes a full metric bundle and a buy signal for a long rising series", async () => {
    const px = risingSeries(260);
    mockRows(newestFirstRows(px));

    const snapshot = await provider.analyze("aapl");

    expect(snapshot.symbol).toBe("AAPL");
    expect(snapshot.asOfTradeDate).toBe(tradeDates(260)[259]);
    expect(snapshot.questions).toHaveLength(3);

    const m = snapshot.metrics;
    expect(m.tradeDate).toBe(tradeDates(260)[259]);
    expect(m.close).not.toBeNull();

    // Rising series sanity: sma50 sits below the last close.
    const sma50 = expectNumber(m.sma50);
    const close = expectNumber(m.close);
    expect(sma50).toBeLessThan(close);

    // Long-horizon metrics exist and are positive.
    expect(expectNumber(m.returns252d)).toBeGreaterThan(0);
    expect(expectNumber(m.returns5d)).toBeGreaterThan(0);
    expect(m.sma50AboveSma200).toBe(true);
    expect(expectNumber(m.volatility21d)).toBeGreaterThan(0);

    // RSI is mid-band (not extreme) → trend + momentum drive the signal.
    const rsi = expectNumber(m.rsi14);
    expect(rsi).toBeGreaterThan(30);
    expect(rsi).toBeLessThan(70);
    expect(m.signal).toBe("buy");
  });

  it("returns nulls for long-horizon metrics on a young symbol", async () => {
    mockRows(newestFirstRows(risingSeries(10)));

    const snapshot = await provider.analyze("  YOUNG  ");

    expect(snapshot.symbol).toBe("YOUNG");
    const m = snapshot.metrics;
    expect(m.sma50).toBeNull();
    expect(m.sma200).toBeNull();
    expect(m.sma50AboveSma200).toBeNull();
    expect(m.returns252d).toBeNull();
    expect(m.returns63d).toBeNull();
    expect(m.returns21d).toBeNull();
    expect(m.volatility21d).toBeNull();
    expect(m.rsi14).toBeNull();
    // Short-horizon returns still exist.
    expect(m.returns1d).not.toBeNull();
    expect(m.returns5d).not.toBeNull();
    // No trend, no RSI → hold.
    expect(m.signal).toBe("hold");
    expect(snapshot.questions).toHaveLength(3);
  });

  it("rejects when no bars exist", async () => {
    mockRows([]);
    await expect(provider.analyze("NONE")).rejects.toThrow(/No daily price data/);
  });

  it("rejects when every row has null prices", async () => {
    mockRows([{ tradeDate: "2024-01-02", close: null, adjClose: null }]);
    await expect(provider.analyze("NONE")).rejects.toThrow(/No daily price data/);
  });
});

// ---------------------------------------------------------------------------
// createProvider registry
// ---------------------------------------------------------------------------

describe("createProvider", () => {
  it("returns a DeterministicProvider by default and for 'deterministic'", () => {
    expect(createProvider({})).toBeInstanceOf(DeterministicProvider);
    expect(createProvider({ decisionProvider: "deterministic" })).toBeInstanceOf(
      DeterministicProvider,
    );
  });

  it("throws a not-implemented error for the reserved 'jev' name", () => {
    expect(() => createProvider({ decisionProvider: "jev" })).toThrow(/not implemented/);
  });

  it("throws for unknown provider names with the supported list", () => {
    expect(() => createProvider({ decisionProvider: "oracle" })).toThrow(
      /Unknown decision provider/,
    );
    expect(() => createProvider({ decisionProvider: "oracle" })).toThrow(
      /Supported: deterministic/,
    );
  });

  it("lists only deterministic as a supported provider", () => {
    expect([...DECISION_PROVIDER_NAMES]).toEqual(["deterministic"]);
  });
});
