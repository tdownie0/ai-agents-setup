import type { EquityPoint, RankingResult } from "./types.js";

const TRADING_DAYS_PER_YEAR = 252;

/**
 * Chain-aware ranking input (beads task 800.3, W3).
 *
 * `basisCapital` must be INJECTED for a carryover chain: inferring it from
 * `equitySeries[0].totalValue` is right for one legacy run and wrong for a
 * concatenated chain, where it silently resets the return at every round
 * boundary and makes compounding P&L read as flat.
 */
export interface RankingInput {
  equitySeries: readonly EquityPoint[];
  /** Chain starting capital. Omit for a legacy single-round series. */
  basisCapital?: number;
}

/**
 * Pure performance ranking math (beads task ez8.2).
 *
 * Daily returns come from consecutive `totalValue` points; volatility is the
 * sample stdev of daily returns annualized × √252 (in %); Sharpe is
 * mean/stdev × √252 with rf=0 (0 when <2 points or stdev=0); max drawdown is
 * the largest peak-to-trough decline of totalValue (negative %).
 *
 * Sharpe, volatility and drawdown read consecutive points only, so they need
 * no change for a carryover chain — but ONLY when the series is contiguous and
 * deduplicated by trade date, which `computeChainEquitySeries` guarantees.
 */
export function computeRanking(equitySeries: readonly EquityPoint[]): RankingResult;
export function computeRanking(input: RankingInput): RankingResult;
export function computeRanking(input: RankingInput | readonly EquityPoint[]): RankingResult {
  const legacyCall = isSeries(input);
  const equitySeries = legacyCall ? input : input.equitySeries;
  const injectedBasis = legacyCall ? undefined : input.basisCapital;

  if (equitySeries.length === 0) {
    return {
      asOfTradeDate: "",
      currentValue: 0,
      totalReturnPct: 0,
      annualizedVolPct: 0,
      sharpe: 0,
      maxDrawdownPct: 0,
    };
  }

  const first = equitySeries[0];
  const last = equitySeries[equitySeries.length - 1];
  // The entry-day point carries totalValue = initialCapital (returnPct 0), so
  // for a legacy single-run series the series itself is the source of truth for
  // the starting capital. A chain injects its basis instead.
  const initialCapital = injectedBasis ?? first.totalValue;
  const currentValue = last.totalValue;
  const totalReturnPct =
    initialCapital === 0 ? 0 : ((currentValue - initialCapital) / initialCapital) * 100;

  const returns: number[] = [];
  for (let i = 1; i < equitySeries.length; i += 1) {
    const prev = equitySeries[i - 1].totalValue;
    if (prev === 0) continue;
    returns.push(equitySeries[i].totalValue / prev - 1);
  }

  let annualizedVolPct = 0;
  let sharpe = 0;
  if (returns.length >= 2) {
    const mean = returns.reduce((acc, v) => acc + v, 0) / returns.length;
    const variance = returns.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (returns.length - 1);
    const stdev = Math.sqrt(variance);
    annualizedVolPct = stdev * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
    sharpe = stdev === 0 ? 0 : (mean / stdev) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  }

  let peak = first.totalValue;
  let maxDrawdownPct = 0;
  for (const point of equitySeries) {
    if (point.totalValue > peak) peak = point.totalValue;
    const drawdown = peak === 0 ? 0 : ((point.totalValue - peak) / peak) * 100;
    if (drawdown < maxDrawdownPct) maxDrawdownPct = drawdown;
  }

  return {
    asOfTradeDate: last.tradeDate,
    currentValue,
    totalReturnPct,
    annualizedVolPct,
    sharpe,
    maxDrawdownPct,
  };
}

/** `Array.isArray` cannot narrow a `readonly` array out of the union, so guard explicitly. */
function isSeries(input: RankingInput | readonly EquityPoint[]): input is readonly EquityPoint[] {
  return Array.isArray(input);
}
