import { REBALANCE_CADENCE, type EquityPoint, type PortfolioWindow } from "./types.js";

/**
 * Pure portfolio valuation engine (beads task ez8.2).
 *
 * Derives a run's daily equity curve from its entry-fill positions and the
 * `daily_prices` bars for its symbols. No DB access, no writes — the route
 * layer loads rows and parses numeric strings before calling in here.
 */

/** A position as the engine consumes it (parsed from DB rows at the edge). */
export interface EnginePosition {
  symbol: string;
  targetWeight: number;
  shares: number;
  entryTradeDate: string;
  entryPrice: number;
}

/** One daily bar for a symbol (close parsed to number). */
export interface EngineBar {
  tradeDate: string;
  close: number;
}

/** Bars keyed by symbol, oldest-first. */
export type BarsBySymbol = ReadonlyMap<string, readonly EngineBar[]>;

/** The run inputs the engine needs (parsed from DB rows at the edge). */
export interface EngineRun {
  initialCapital: number;
  window: PortfolioWindow;
}

/**
 * Daily equity series from the entry day (first trading day ≥ the positions'
 * entryTradeDate) through the last available trade date.
 *
 * - Between rebalance boundaries shares are fixed; holdingsValue = Σ shares ×
 *   close (forward-filled last close for halted symbols) and cash is fixed.
 * - At a boundary close (every Nth trading day from entry: daily=1, weekly=5,
 *   monthly=21) the portfolio is rebalanced to equal target weights: total =
 *   cash + holdingsValue, shares = total × targetWeight / close, cash = total
 *   − Σ shares × close. Total value is preserved by construction.
 * - A symbol with no bars at all contributes 0 to holdings.
 */
export function computeEquitySeries(
  run: EngineRun,
  positions: readonly EnginePosition[],
  barsBySymbol: BarsBySymbol,
): EquityPoint[] {
  const { initialCapital, window } = run;
  const cadence = REBALANCE_CADENCE[window];

  const entryTradeDate = positions[0]?.entryTradeDate;
  if (entryTradeDate === undefined || entryTradeDate.length === 0) return [];

  // Union trade-date calendar ≥ entry day, ascending.
  const calendar = new Set<string>();
  for (const bars of barsBySymbol.values()) {
    for (const bar of bars) {
      if (bar.tradeDate >= entryTradeDate) calendar.add(bar.tradeDate);
    }
  }
  const days = [...calendar].sort();

  // Entry-fill cash: initialCapital − Σ shares × entryPrice (≈ 0 when the
  // target weights sum to 1).
  let cash = initialCapital;
  for (const pos of positions) cash -= pos.shares * pos.entryPrice;

  // Current shares per symbol (start = entry fill).
  const shares = new Map<string, number>();
  for (const pos of positions) shares.set(pos.symbol, pos.shares);

  // Per-symbol close lookup for the ≥ entry-day window.
  const closeByDate = new Map<string, Map<string, number>>();
  for (const pos of positions) {
    const byDate = new Map<string, number>();
    for (const bar of barsBySymbol.get(pos.symbol) ?? []) {
      if (bar.tradeDate >= entryTradeDate) byDate.set(bar.tradeDate, bar.close);
    }
    closeByDate.set(pos.symbol, byDate);
  }

  // Forward-fill state: last known close per symbol (last bar ≤ entry day).
  const lastClose = new Map<string, number>();
  for (const pos of positions) {
    const bars = barsBySymbol.get(pos.symbol) ?? [];
    let known: number | undefined;
    for (const bar of bars) {
      if (bar.tradeDate <= entryTradeDate) known = bar.close;
      else break;
    }
    if (known !== undefined) lastClose.set(pos.symbol, known);
  }

  // Empty-prices edge: emit the entry-day-only point from the fill.
  if (days.length === 0) {
    let holdings = 0;
    for (const pos of positions) holdings += pos.shares * pos.entryPrice;
    const total = cash + holdings;
    return [
      {
        tradeDate: entryTradeDate,
        cash,
        holdingsValue: holdings,
        totalValue: total,
        returnPct: ((total - initialCapital) / initialCapital) * 100,
      },
    ];
  }

  const points: EquityPoint[] = [];
  for (let i = 0; i < days.length; i += 1) {
    const day = days[i];

    // Advance forward-fill state for symbols that trade today.
    for (const pos of positions) {
      const close = closeByDate.get(pos.symbol)?.get(day);
      if (close !== undefined) lastClose.set(pos.symbol, close);
    }

    let holdings = 0;
    for (const pos of positions) {
      holdings += (shares.get(pos.symbol) ?? 0) * (lastClose.get(pos.symbol) ?? 0);
    }
    const total = cash + holdings;
    points.push({
      tradeDate: day,
      cash,
      holdingsValue: holdings,
      totalValue: total,
      returnPct: ((total - initialCapital) / initialCapital) * 100,
    });

    // Rebalance at every Nth trading day from entry (the entry day itself is
    // the initial fill, not a boundary).
    if ((i + 1) % cadence === 0) {
      const nextShares = new Map<string, number>();
      let nextCash = total;
      for (const pos of positions) {
        const px = lastClose.get(pos.symbol) ?? 0;
        const s = px > 0 ? (total * pos.targetWeight) / px : 0;
        nextShares.set(pos.symbol, s);
        nextCash -= s * px;
      }
      shares.clear();
      for (const [symbol, s] of nextShares) shares.set(symbol, s);
      cash = nextCash;
    }
  }

  return points;
}
