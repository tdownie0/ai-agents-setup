/**
 * Portfolio-simulation engine types (beads task ez8.2).
 *
 * Pure derivation types shared by the valuation/ranking engine and the RPC
 * wire layer. Every numeric value here is a plain JS number — DB numeric
 * strings are parsed at the edge (see `parseNumeric` below and
 * `routes/portfolio.ts`).
 */

/** Rebalance cadence in trading days from the entry day. */
export const REBALANCE_CADENCE = {
  daily: 1,
  weekly: 5,
  monthly: 21,
} as const;

export type PortfolioWindow = keyof typeof REBALANCE_CADENCE;

/** One daily point of a run's equity curve. */
export interface EquityPoint {
  /** US-session calendar date YYYY-MM-DD (daily_prices.trade_date). */
  tradeDate: string;
  /** Uninvested cash carried from the last rebalance (entry fill or boundary). */
  cash: number;
  /** Σ shares × close over the run's symbols (last known close for halts). */
  holdingsValue: number;
  /** cash + holdingsValue. */
  totalValue: number;
  /** (totalValue − initialCapital) / initialCapital × 100. */
  returnPct: number;
}

/** Derived performance summary for one run (leaderboard row math). */
export interface RankingResult {
  /** Last trade date covered by the equity series. */
  asOfTradeDate: string;
  /** Total portfolio value on the last trade date. */
  currentValue: number;
  /** (currentValue − initialCapital) / initialCapital × 100. */
  totalReturnPct: number;
  /** Annualized stdev of daily returns × √252, in %. */
  annualizedVolPct: number;
  /** mean(daily returns) / stdev × √252 with rf=0; 0 when <2 points or stdev=0. */
  sharpe: number;
  /** Max peak-to-trough decline of totalValue, negative %. */
  maxDrawdownPct: number;
}

/**
 * Parse a DB numeric string (or number) to a JS number at the wire edge.
 * Null/undefined (nullable numeric columns) and non-finite values map to 0 so
 * downstream arithmetic never sees NaN.
 */
export function parseNumeric(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}