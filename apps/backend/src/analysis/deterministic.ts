import { and, desc, eq, lte } from "drizzle-orm";
import { dailyPrices, db, instruments } from "@model_md/database";
import type {
  AnalysisQuestion,
  AnalysisSnapshot,
  DecisionProvider,
  MetricBundle,
  Signal,
} from "./types.js";

/**
 * Rule-based `DecisionProvider`: reads recent `daily_prices` bars in one
 * select, computes the full `MetricBundle` in TypeScript, and emits a fixed
 * question set seeded with the computed signal. Pure DB reads — no network,
 * no `process.env`, fully deterministic for a given database state.
 *
 * Numeric columns arrive from postgres-js as strings; they are parsed with
 * `Number()` BEFORE any arithmetic (the documented wire convention).
 */

/** Enough bars for 252d return + SMA warm-up (200) with headroom. */
const BAR_LIMIT = 300;
const TRADING_DAYS_PER_YEAR = 252;

interface Bar {
  tradeDate: string;
  px: number;
  close: number | null;
}

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** `(P_t / P_{t-N} - 1) * 100`, or null when the window is not covered. */
function pctReturn(px: number[], periods: number): number | null {
  if (px.length <= periods) return null;
  const end = px[px.length - 1];
  const start = px[px.length - 1 - periods];
  if (start === 0) return null;
  return round((end / start - 1) * 100, 2);
}

/** Simple moving average of the last `window` closes, or null if too short. */
function sma(px: number[], window: number): number | null {
  if (px.length < window) return null;
  const slice = px.slice(-window);
  const sum = slice.reduce((acc, v) => acc + v, 0);
  return round(sum / window, 4);
}

/** Annualized stdev of the last 21 daily returns, in percent. */
function volatility21d(px: number[]): number | null {
  if (px.length < 22) return null;
  const rets: number[] = [];
  for (let i = px.length - 21; i < px.length; i += 1) {
    rets.push(px[i] / px[i - 1] - 1);
  }
  const mean = rets.reduce((acc, v) => acc + v, 0) / rets.length;
  const variance = rets.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (rets.length - 1);
  return round(Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100, 2);
}

/** Simple RSI over the last 14 close-to-close changes, 0–100. */
function rsi14(px: number[]): number | null {
  if (px.length < 15) return null;
  let gains = 0;
  let losses = 0;
  for (let i = px.length - 14; i < px.length; i += 1) {
    const delta = px[i] - px[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return round(100 - 100 / (1 + avgGain / avgLoss), 2);
}

/**
 * Deterministic bias rule (unit-testable, documented for FEATURE_README):
 * 1. RSI ≥ 70 → sell (overbought)  |  RSI ≤ 30 → buy (oversold)
 * 2. else trend (sma50AboveSma200) AND 5d momentum must agree:
 *    up + positive → buy; down + negative → sell
 * 3. anything else (missing inputs or disagreement) → hold
 */
export function computeSignal(metrics: Omit<MetricBundle, "signal">): Signal {
  if (metrics.rsi14 !== null && metrics.rsi14 >= 70) return "sell";
  if (metrics.rsi14 !== null && metrics.rsi14 <= 30) return "buy";
  const trendUp = metrics.sma50AboveSma200;
  const mom5 = metrics.returns5d;
  if (trendUp === true && mom5 !== null && mom5 > 0) return "buy";
  if (trendUp === false && mom5 !== null && mom5 < 0) return "sell";
  return "hold";
}

/** Fixed phase-1 question set, seeded with the computed signal/metrics. */
export function generateQuestions(
  symbol: string,
  metrics: MetricBundle,
): readonly AnalysisQuestion[] {
  return [
    {
      id: "bias",
      type: "choice",
      prompt: `Buy/Hold/Sell bias on ${symbol} (deterministic rule signal: ${metrics.signal})`,
      options: ["buy", "hold", "sell"],
    },
    {
      id: "attractiveness",
      type: "score",
      prompt: `Attractiveness score 0-100 for ${symbol} as of ${metrics.tradeDate}`,
      min: 0,
      max: 100,
    },
    {
      id: "thesis",
      type: "noul",
      prompt: `One-paragraph investment thesis for ${symbol} as of ${metrics.tradeDate}, grounded in the precomputed metrics`,
    },
  ];
}

export class DeterministicProvider implements DecisionProvider {
  async analyze(symbol: string, opts?: { asOfTradeDate?: string }): Promise<AnalysisSnapshot> {
    const sym = symbol.trim().toUpperCase();
    const conditions = [eq(instruments.symbol, sym)];
    if (opts?.asOfTradeDate !== undefined) {
      conditions.push(lte(dailyPrices.tradeDate, opts.asOfTradeDate));
    }

    // Single aggregate pass: last ~300 bars, newest first; metrics computed in TS.
    const rows = await db
      .select({
        tradeDate: dailyPrices.tradeDate,
        close: dailyPrices.close,
        adjClose: dailyPrices.adjClose,
      })
      .from(dailyPrices)
      .innerJoin(instruments, eq(dailyPrices.instrumentId, instruments.id))
      .where(and(...conditions))
      .orderBy(desc(dailyPrices.tradeDate))
      .limit(BAR_LIMIT);

    const bars: Bar[] = [];
    for (const row of rows) {
      const adjusted = row.adjClose ?? row.close;
      if (adjusted === null) continue;
      const px = Number(adjusted);
      if (!Number.isFinite(px)) continue;
      bars.push({
        tradeDate: row.tradeDate,
        px,
        close: row.close === null ? null : Number(row.close),
      });
    }
    if (bars.length === 0) {
      const suffix = opts?.asOfTradeDate ? ` as of ${opts.asOfTradeDate}` : "";
      throw new Error(`No daily price data for symbol "${sym}"${suffix} — ingest bars first`);
    }
    bars.reverse(); // oldest → newest for index-based windows

    const px = bars.map((b) => b.px);
    const last = bars[bars.length - 1];
    const sma50 = sma(px, 50);
    const sma200 = sma(px, 200);
    const withoutSignal = {
      tradeDate: last.tradeDate,
      close: last.close,
      returns1d: pctReturn(px, 1),
      returns5d: pctReturn(px, 5),
      returns21d: pctReturn(px, 21),
      returns63d: pctReturn(px, 63),
      returns252d: pctReturn(px, 252),
      volatility21d: volatility21d(px),
      sma50,
      sma200,
      sma50AboveSma200: sma50 !== null && sma200 !== null ? sma50 > sma200 : null,
      rsi14: rsi14(px),
    };
    const metrics: MetricBundle = { ...withoutSignal, signal: computeSignal(withoutSignal) };

    return {
      symbol: sym,
      asOfTradeDate: metrics.tradeDate,
      metrics,
      questions: generateQuestions(sym, metrics),
    };
  }
}
