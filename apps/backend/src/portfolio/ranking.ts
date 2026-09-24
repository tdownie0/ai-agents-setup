import type { EquityPoint, RankingResult } from "./types.js";

const TRADING_DAYS_PER_YEAR = 252;

/**
 * Pure performance ranking math (beads task ez8.2).
 *
 * Daily returns come from consecutive `totalValue` points; volatility is the
 * sample stdev of daily returns annualized × √252 (in %); Sharpe is
 * mean/stdev × √252 with rf=0 (0 when <2 points or stdev=0); max drawdown is
 * the largest peak-to-trough decline of totalValue (negative %).
 */
export function computeRanking(equitySeries: readonly EquityPoint[]): RankingResult {
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
  // the series itself is the source of truth for the starting capital.
  const initialCapital = first.totalValue;
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
