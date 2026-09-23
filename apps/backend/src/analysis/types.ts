/**
 * Provider-agnostic decision/analysis contract (phase 1).
 *
 * Pre-shaped like the Jev System One question taxonomy (choice / score /
 * noul) but deliberately decoupled from any specific model: every
 * `DecisionProvider` — the shipped `DeterministicProvider`, a future Jev
 * client (phase 2), or a financial-specialist agent — emits the same
 * `AnalysisSnapshot`: one typed state + typed questions in a single call.
 *
 * Jev System One cannot do arithmetic or date math (~64k-token typed state,
 * free output, paid input), so `MetricBundle` carries EVERY number a
 * consumer might need: code computes all metrics up front and the question
 * layer only reasons over them.
 */

/** Pick exactly one of a fixed option set. */
export type ChoiceQuestion = {
  id: string;
  type: "choice";
  prompt: string;
  options: readonly string[];
};

/** A bounded numeric rating. */
export type ScoreQuestion = {
  id: string;
  type: "score";
  prompt: string;
  min: number;
  max: number;
};

/**
 * Noul = no-option question: an open factual/forecast prompt with no fixed
 * options (free-text answer expected).
 */
export type NoulQuestion = {
  id: string;
  type: "noul";
  prompt: string;
};

export type AnalysisQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion;

/** Deterministic rule-based bias attached to every snapshot. */
export type Signal = "buy" | "hold" | "sell";

/**
 * Pre-computed numeric metrics for one symbol at one trade date.
 *
 * Every field except `tradeDate`/`close`/`signal` is nullable: young
 * symbols simply have no 252-day history yet. Returns are percent changes
 * on the adjusted series (`adjClose ?? close`), i.e.
 * `(P_t / P_{t-N} - 1) * 100` over N trading days.
 */
export interface MetricBundle {
  /** Last trade date in the window, US-session calendar date YYYY-MM-DD. */
  tradeDate: string;
  /** Raw close of `tradeDate` (numeric-as-string parsed to number). */
  close: number | null;
  returns1d: number | null;
  returns5d: number | null;
  returns21d: number | null;
  returns63d: number | null;
  returns252d: number | null;
  /** Annualized volatility: stdev of last 21 daily returns × √252, in %. */
  volatility21d: number | null;
  sma50: number | null;
  sma200: number | null;
  /** `true` when both SMAs exist and sma50 > sma200; `null` if either is missing. */
  sma50AboveSma200: boolean | null;
  /** Simple RSI over the last 14 close-to-close changes, 0–100. */
  rsi14: number | null;
  /** Rule-based bias derived from trend + momentum + RSI zones (never null). */
  signal: Signal;
}

/** The "state + questions" an agent or Jev client consumes in one round trip. */
export interface AnalysisSnapshot {
  symbol: string;
  asOfTradeDate: string;
  metrics: MetricBundle;
  questions: readonly AnalysisQuestion[];
}

/** The single typed seam every decision backend implements. */
export interface DecisionProvider {
  analyze(symbol: string, opts?: { asOfTradeDate?: string }): Promise<AnalysisSnapshot>;
}
