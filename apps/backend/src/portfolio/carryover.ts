import { REBALANCE_CADENCE, type EquityPoint, type PortfolioWindow } from "./types.js";
import type { BarsBySymbol } from "./valuation.js";

/**
 * Deterministic portfolio carryover fold (beads task 800.3, W3).
 *
 * One round hands an agent a book; the agent answers with a COMPLETE target
 * book expressed as fractions of the marked total value. This module turns
 * (carried book + target book + closes) into the next carried book — the pure
 * function that makes `agent_portfolio_state` a cache rather than a ledger:
 * replace, delete and re-fold are one code path because the fold is total and
 * has no state of its own.
 *
 * Everything here is synchronous and DB-free: rows are parsed at the wire
 * edge, exactly as `valuation.ts` does for the legacy single-run path.
 *
 * The legacy path (`computeEquitySeries` in `valuation.ts`) is deliberately
 * untouched. It re-snaps to the FIRST round's target weights on every cadence
 * boundary, which is wrong for a carried book — it re-imposes round 1 forever,
 * silently, so an agent's later decisions never actually hold. The chain path
 * below never re-snaps: between two decisions shares and cash are fixed and the
 * book drifts with the market.
 */

/**
 * The book carried from one round to the next. Cash is a fold OUTPUT here, not
 * a derivation: `initialCapital − Σ shares × entryPrice` cannot represent a
 * book that spans rounds, which is the whole point of carryover.
 */
export interface OpeningBook {
  /** Uninvested cash carried forward. */
  cash: number;
  /** Open lots by symbol, in shares. Symbols with 0 shares are not present. */
  shares: ReadonlyMap<string, number>;
  /** Per-share average cost by symbol (shares-weighted across rounds). */
  costBasis: ReadonlyMap<string, number>;
  /** Target weights in force by symbol. */
  targetWeights: ReadonlyMap<string, number>;
}

/** One line of a round's COMPLETE target book. `targetWeight: 0` = liquidate. */
export interface DecisionTarget {
  symbol: string;
  /** Target share of the marked total value. 0 liquidates the line entirely. */
  targetWeight: number;
}

/**
 * A fold fill. The union is discriminated on `side` so the states the spec
 * forbids cannot be represented: a `hold` carries no shares and no realized
 * P&L, a `buy` carries no realized P&L.
 */
export interface BuyFill {
  symbol: string;
  side: "buy";
  /** Shares purchased (the delta; fractional shares are the norm). */
  shares: number;
  price: number;
  realizedPnl: 0;
}

export interface SellFill {
  symbol: string;
  side: "sell";
  /** Shares sold (the delta). */
  shares: number;
  price: number;
  /** soldShares × (price − costBasis). */
  realizedPnl: number;
}

export interface HoldFill {
  symbol: string;
  side: "hold";
  /** 0 — a zero-delta line is not a trade. */
  shares: 0;
  realizedPnl: 0;
  price: number;
}

export type DecisionFill = BuyFill | SellFill | HoldFill;

export interface ApplyDecisionInput {
  /** The carried book this round opens with. */
  openingBook: OpeningBook;
  /**
   * Chain basis for this round. The fold values the target weights against the
   * MARK (`totalValue`), not the basis, so after round 1 this field does not
   * enter the arithmetic — the caller carries it for its own chain-return math.
   */
  basisCapital: number;
  /** This round's COMPLETE target book: buys have `targetWeight > 0`, exits exactly 0. */
  targets: ReadonlyArray<DecisionTarget>;
  /**
   * symbol → close on `asOfTradeDate`, BOTH the mark and the fill price. A
   * symbol with no price here contributes 0 to the mark and cannot be bought;
   * the caller is expected to forward-fill held names from their last price.
   */
  prices: Readonly<Record<string, number>>;
  /** The date whose closes `prices` holds. Single-date mark-and-trade, so the arithmetic needs no date. */
  asOfTradeDate: string;
}

export interface ApplyDecisionResult {
  /** The book the next round opens with: only lines with shares > 0 are kept. */
  nextBook: OpeningBook;
  /** One fill per target, in target order. */
  fills: ReadonlyArray<DecisionFill>;
  /** Σ realized P&L across this round's sells. */
  realizedPnl: number;
  /** Marked total value at `asOfTradeDate`. Preserved by the fold (zero-cost trade at the mark). */
  totalValue: number;
}

/**
 * Fold one round's decision into the carried book.
 *
 * Exact order: mark the opening book at the decision close → `totalValue` →
 * `targetShares = totalValue × targetWeight / price` → `deltaShares =
 * targetShares − heldShares`. An exit (`targetWeight === 0`) therefore yields
 * `targetShares = 0` and a full liquidation, whose proceeds land in cash; a
 * zero delta is a `hold` with no trade and no realized P&L.
 *
 * Envelope validation admits Σ targetWeight ∈ [0.99, 1.01] (WEIGHT_SUM_MIN /
 * WEIGHT_SUM_MAX). A sum above 1 would size the book past the mark and drive
 * cash negative, so `applyDecision` rescales every positive weight by `1 / Σ`
 * before sizing: cash is then `totalValue × (1 − Σ × scale) ≥ 0` by
 * construction, and the identity `cash + Σ shares × price = totalValue` holds
 * in every case. That property is the entire reason this design carries target
 * weights instead of `side`/`quantity`; clamping cash instead would mint
 * `totalValue × (Σ − 1)` out of nothing.
 */
export function applyDecision(input: ApplyDecisionInput): ApplyDecisionResult {
  const { openingBook, targets, prices } = input;
  const closeOf = new Map(Object.entries(prices));

  const markCloses = new Map<string, number>();
  for (const symbol of openingBook.shares.keys()) markCloses.set(symbol, closeOf.get(symbol) ?? 0);
  const { totalValue } = markBook(openingBook.cash, openingBook.shares, markCloses);

  // Rescale an over-allocated book back onto the mark. Σ ≤ 1 is left untouched
  // (residual cash is intentional); Σ > 1 is scaled so the buys sum to exactly
  // the mark and cash lands on 0 rather than negative.
  const weightSum = targets.reduce(
    (sum, { targetWeight }) => sum + (targetWeight > 0 ? targetWeight : 0),
    0,
  );
  const scale = weightSum > 1 ? 1 / weightSum : 1;

  const nextShares = new Map<string, number>();
  const nextCostBasis = new Map<string, number>();
  const nextTargetWeights = new Map<string, number>();
  const fills: DecisionFill[] = [];
  let invested = 0;
  let realizedPnl = 0;

  for (const { symbol, targetWeight } of targets) {
    const price = closeOf.get(symbol) ?? 0;
    const effectiveWeight = targetWeight * scale;
    const targetShares = price > 0 ? (totalValue * effectiveWeight) / price : 0;
    const heldShares = openingBook.shares.get(symbol) ?? 0;
    const unitCost = openingBook.costBasis.get(symbol) ?? 0;
    const deltaShares = targetShares - heldShares;
    const boughtShares = deltaShares > 0 ? deltaShares : 0;
    const soldShares = deltaShares < 0 ? -deltaShares : 0;
    const lineRealized = soldShares * (price - unitCost);

    fills.push(
      boughtShares > 0
        ? { symbol, side: "buy", shares: boughtShares, price, realizedPnl: 0 }
        : soldShares > 0
          ? { symbol, side: "sell", shares: soldShares, price, realizedPnl: lineRealized }
          : { symbol, side: "hold", shares: 0, price, realizedPnl: 0 },
    );
    realizedPnl += lineRealized;
    invested += targetShares * price;

    if (targetShares > 0) {
      nextShares.set(symbol, targetShares);
      nextTargetWeights.set(symbol, effectiveWeight);
      // Only a bought quantity can move the shares-weighted average: a hold and
      // a trim both leave the retained unit cost exactly as it was.
      let unitCostNext: number;
      if (boughtShares === 0) unitCostNext = unitCost;
      else if (heldShares === 0) unitCostNext = price;
      else unitCostNext = (heldShares * unitCost + boughtShares * price) / targetShares;
      nextCostBasis.set(symbol, unitCostNext);
    }
  }

  // Cash is the residual of the SAME mark the (rescaled) weights applied to, so
  // `cash + Σ shares × price` is the pre-decision total by construction.
  // Non-negative for every admitted envelope: Σ ≤ 1 leaves cash at
  // `totalValue × (1 − Σ)`, and Σ > 1 is rescaled to exactly 1 above.
  return {
    nextBook: {
      cash: totalValue - invested,
      shares: nextShares,
      costBasis: nextCostBasis,
      targetWeights: nextTargetWeights,
    },
    fills,
    realizedPnl,
    totalValue,
  };
}

/** One round of the chain: the span between two decisions. */
export interface EngineSegment {
  roundId: string;
  roundSeq: number;
  /**
   * First date to emit. For `roundSeq > 0` this MUST be the trading day after
   * the previous segment's `decideTradeDate` — contiguity is load-bearing,
   * because sharpe, volatility and drawdown are all read off consecutive points.
   */
  openTradeDate: string;
  /** `asOfTradeDate` of this round; the decision applies at that date's close. */
  decideTradeDate: string;
  /** Chain starting capital. Identical across every segment; the first segment's value is the chain basis. */
  basisCapital: number;
  window: PortfolioWindow;
  /**
   * The book this segment opens with. The fold recomputes it for `roundSeq > 0`
   * rather than trusting this field, so a stale cached book can never corrupt
   * the chain — which is what makes the state cache disposable.
   */
  openingBook: OpeningBook;
  /** This round's COMPLETE target book. */
  decisions: ReadonlyArray<DecisionTarget>;
}

/**
 * Continuous chain equity series: segments in `roundSeq` order, one point per
 * trading day from `openTradeDate` through `decideTradeDate`, with shares and
 * cash FIXED between decisions and NO cadence re-snap. The decision is applied
 * at `decideTradeDate`'s close, and the resulting book is what the next segment
 * marks.
 *
 * Two invariants the caller must uphold, both pinned by tests here:
 *
 * 1. **Dedup by `tradeDate`, last write wins.** A date emitted by two segments
 *    keeps the later segment's value (the post-decision book).
 * 2. **Contiguity.** Segment `k` opens the trading day after segment `k−1`'s
 *    decide date, so the output has one point per trading day with no gap and
 *    no repeated boundary.
 *
 * `returnPct` is measured against the chain `basisCapital` on EVERY point — it
 * is never re-derived per segment, which is what makes a chain's return compound
 * instead of resetting at each boundary.
 */
export function computeChainEquitySeries(
  segments: readonly EngineSegment[],
  barsBySymbol: BarsBySymbol,
): EquityPoint[] {
  const ordered = [...segments].sort((a, b) => a.roundSeq - b.roundSeq);
  if (ordered.length === 0) return [];

  const basisCapital = ordered[0].basisCapital;
  const points = new Map<string, EquityPoint>();
  let book: OpeningBook = ordered[0].openingBook;

  for (const segment of ordered) {
    const markSymbols = [...book.shares.keys()];
    // A segment that opens all-cash (round 1, or a round that liquidated) must
    // still span its own dates, so the calendar comes from the names the
    // decision touches as well as the names currently held.
    const priceSymbols = [...new Set([...markSymbols, ...segment.decisions.map((d) => d.symbol)])];
    const calendar = new Set<string>();
    const closeInWindow = new Map<string, ReadonlyMap<string, number>>();
    for (const symbol of priceSymbols) {
      const byDate = new Map<string, number>();
      for (const bar of barsBySymbol.get(symbol) ?? []) {
        if (bar.tradeDate >= segment.openTradeDate && bar.tradeDate <= segment.decideTradeDate) {
          byDate.set(bar.tradeDate, bar.close);
          calendar.add(bar.tradeDate);
        }
      }
      closeInWindow.set(symbol, byDate);
    }

    // Forward-fill state: last known close per held symbol on the open day.
    const liveCloses = closesOnOrBefore(barsBySymbol, markSymbols, segment.openTradeDate);

    // A segment whose window has no bars still reports one point, marked with
    // the forward-filled closes, so the book is never silently dropped.
    const days = [...calendar].sort();
    for (const day of days.length > 0 ? days : [segment.decideTradeDate]) {
      for (const [symbol, byDate] of closeInWindow) {
        const close = byDate.get(day);
        if (close !== undefined) liveCloses.set(symbol, close);
      }
      const { holdingsValue, totalValue } = markBook(book.cash, book.shares, liveCloses);
      points.set(day, {
        tradeDate: day,
        cash: book.cash,
        holdingsValue,
        totalValue,
        returnPct: basisCapital === 0 ? 0 : ((totalValue - basisCapital) / basisCapital) * 100,
      });

      if (day === segment.decideTradeDate) {
        book = applyDecision({
          openingBook: book,
          basisCapital,
          targets: segment.decisions,
          prices: Object.fromEntries(
            closesOnOrBefore(barsBySymbol, priceSymbols, segment.decideTradeDate),
          ),
          asOfTradeDate: segment.decideTradeDate,
        }).nextBook;
      }
    }
  }

  return [...points.values()].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}

/** One applied segment of a chain replay — the unit the state cache is written in. */
export interface SegmentStep {
  roundId: string;
  roundSeq: number;
  decideTradeDate: string;
  /** Marked value at the decision close; the fold preserves it (zero-cost trade at the mark). */
  totalValue: number;
  fills: ReadonlyArray<DecisionFill>;
  realizedPnl: number;
  /** The book the NEXT round opens with. */
  nextBook: OpeningBook;
}

export interface ChainReplay {
  /** Book in force after the last segment's decision; an empty book when there are no segments. */
  finalBook: OpeningBook;
  /** One step per segment in `roundSeq` order — the write plan for the state cache. */
  steps: ReadonlyArray<SegmentStep>;
}

/**
 * Fold a list of segments from round 1 forward and return the final book plus
 * the per-round steps. The PURE core of `rebuildStream`: given the same
 * segments and bars it produces the same cache rows on every run, which is why
 * the cache needs no snapshot table.
 *
 * Segment `k`'s `openingBook` is recomputed, never read — only segment 0's is
 * trusted as the chain's starting point.
 */
export function replaySegmentChain(
  segments: readonly EngineSegment[],
  barsBySymbol: BarsBySymbol,
): ChainReplay {
  const ordered = [...segments].sort((a, b) => a.roundSeq - b.roundSeq);
  const first = ordered[0];
  const steps: SegmentStep[] = [];
  let book: OpeningBook = first?.openingBook ?? {
    cash: 0,
    shares: new Map<string, number>(),
    costBasis: new Map<string, number>(),
    targetWeights: new Map<string, number>(),
  };

  for (const segment of ordered) {
    const result = applyDecision({
      openingBook: book,
      basisCapital: segment.basisCapital,
      targets: segment.decisions,
      prices: Object.fromEntries(
        closesOnOrBefore(
          barsBySymbol,
          [...book.shares.keys(), ...segment.decisions.map((d) => d.symbol)],
          segment.decideTradeDate,
        ),
      ),
      asOfTradeDate: segment.decideTradeDate,
    });
    steps.push({
      roundId: segment.roundId,
      roundSeq: segment.roundSeq,
      decideTradeDate: segment.decideTradeDate,
      totalValue: result.totalValue,
      fills: result.fills,
      realizedPnl: result.realizedPnl,
      nextBook: result.nextBook,
    });
    book = result.nextBook;
  }

  return { finalBook: book, steps };
}

/** Cadence state the UI shows as "next review due". */
export interface DecisionDueInput {
  window: PortfolioWindow;
  /** Trading days since the stream's last decision; null on a stream's first round. */
  tradingDaysSinceLastDecision: number | null;
}

/**
 * Is this window's next review due? `tradingDaysSinceLastDecision >=
 * REBALANCE_CADENCE[window]`, and a stream's first round (null) is always due.
 *
 * This is the ONLY surviving use of the cadence. It used to drive an automatic
 * re-snap, which traded without asking anyone; now it is advisory metadata. The
 * window keeps its meaning end to end and the engine never trades without a
 * decision.
 */
export function isDecisionDue(input: DecisionDueInput): boolean {
  const { window, tradingDaysSinceLastDecision } = input;
  if (tradingDaysSinceLastDecision === null) return true;
  return tradingDaysSinceLastDecision >= REBALANCE_CADENCE[window];
}

/** Mark a book at a set of closes: `holdingsValue = Σ shares × close`. */
function markBook(
  cash: number,
  shares: ReadonlyMap<string, number>,
  closes: ReadonlyMap<string, number>,
): { holdingsValue: number; totalValue: number } {
  let holdingsValue = 0;
  for (const [symbol, quantity] of shares) holdingsValue += quantity * (closes.get(symbol) ?? 0);
  return { holdingsValue, totalValue: cash + holdingsValue };
}

/**
 * symbol → last close on or before `tradeDate`, forward-filled across halts.
 * A symbol that has never traded by then maps to 0.
 */
function closesOnOrBefore(
  barsBySymbol: BarsBySymbol,
  symbols: Iterable<string>,
  tradeDate: string,
): Map<string, number> {
  const prices = new Map<string, number>();
  for (const symbol of symbols) {
    let known = 0;
    for (const bar of barsBySymbol.get(symbol) ?? []) {
      if (bar.tradeDate > tradeDate) break;
      known = bar.close;
    }
    prices.set(symbol, known);
  }
  return prices;
}
