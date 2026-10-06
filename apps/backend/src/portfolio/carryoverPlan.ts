/**
 * Carryover write PLAN — the pure half of the persistence layer
 * (beads task 800.4, W4).
 *
 * `agent_portfolio_state` + `portfolio_position_lots` + `portfolio_equity_daily`
 * are a MATERIALIZED CACHE over a deterministic fold, so everything here is a
 * function of already-loaded data: rounds (with their complete target books),
 * the stream's current cache, and daily bars. No DB, no clock, no I/O. The DB
 * wrappers in `carryoverStore.ts` load the inputs and write the plan out.
 *
 * Two planners, ONE fold:
 *
 *   `planChainRebuild` — replay the whole chain from round 1.
 *   `planRoundFold`    — advance the cache by exactly one round.
 *
 * Both derive from the same W3 engine calls (`replaySegmentChain`,
 * `applyDecision`, `computeChainEquitySeries`) and both take their decision
 * prices from the SAME bar series, which is what makes "rebuild from history"
 * and "fold incrementally" produce byte-identical rows — the property that lets
 * `replace` and a full rebuild share this module.
 */

import {
  applyDecision,
  computeChainEquitySeries,
  replaySegmentChain,
} from "./carryover.js";
import type { DecisionTarget, EngineSegment, OpeningBook, SegmentStep } from "./carryover.js";
import type { PortfolioWindow } from "./types.js";
import type { BarsBySymbol, EngineBar } from "./valuation.js";

/** One (persona, window) pair inside a simulation: the unit of carryover. */
export interface StreamKey {
  simulationId: string;
  /** Persona key, e.g. `dr-value` (the `agentKey` is `${personaKey}--${window}`). */
  personaKey: string;
  window: PortfolioWindow;
}

/** One round of a stream's history, as the fold needs it. */
export interface ChainRoundInput {
  roundId: string;
  roundSeq: number;
  /** `asOfTradeDate`: the close the decision applies at. */
  decideTradeDate: string;
  /** The round's COMPLETE target book (buys > 0, explicit exits === 0). */
  targets: readonly DecisionTarget[];
  /** symbol → thesis, for the lot rows. Optional. */
  theses?: ReadonlyMap<string, string>;
}

/**
 * A cached lot as the fold reads it back. Carries the position AND its
 * provenance, which is the point of the cache: the next round's opening book is
 * rebuilt from these rows without re-reading prices or re-folding history.
 */
export interface LotSnapshot {
  symbol: string;
  shares: number;
  /** Per-share, shares-weighted average cost. */
  costBasis: number;
  targetWeight: number;
  openedFromRoundId: string;
  openedTradeDate: string;
  /** Realized P&L accumulated on this line across trims. */
  realizedPnl: number;
  thesis: string | null;
}

/**
 * Lot provenance: everything a fold needs about a line EXCEPT its position,
 * which lives in the fold's `OpeningBook`. Kept apart from `LotSnapshot` so the
 * provenance map cannot be mistaken for a full position row.
 */
export type LotProvenance = Omit<LotSnapshot, "shares" | "costBasis" | "targetWeight">;

/** The cache row `agent_portfolio_state` should hold after the plan. */
export interface StateWrite {
  simulationId: string;
  personaKey: string;
  window: PortfolioWindow;
  /** Last applied `round_seq`. */
  seq: number;
  lastTradeDate: string;
  lastRoundId: string;
  /** CHAIN basis — copied from the simulation, never re-derived. */
  initialCapital: string;
  cash: string;
  holdingsValue: string;
  totalValue: string;
  /** Complete target book in force. */
  targetJson: DecisionTarget[];
}

/** One `portfolio_position_lots` row. */
export interface LotWrite {
  symbol: string;
  shares: string;
  costBasis: string;
  targetWeight: string;
  openedFromRoundId: string;
  openedTradeDate: string;
  lastTradeDate: string;
  lastPrice: string | null;
  realizedPnl: string;
  thesis: string | null;
}

/** One `portfolio_equity_daily` row. */
export interface EquityWrite {
  tradeDate: string;
  cash: string;
  holdingsValue: string;
  totalValue: string;
  /** Chain position in force when the day was marked (null before the first decision). */
  roundSeq: number | null;
}

export interface StreamWritePlan {
  /** `null` when the stream has no rounds at all — nothing to materialize. */
  state: StateWrite | null;
  lots: LotWrite[];
  equity: EquityWrite[];
  summary: {
    seq: number;
    cash: number;
    holdingsValue: number;
    totalValue: number;
    positionCount: number;
  };
}

/** The cached state the incremental fold opens with. */
export interface StateSnapshot {
  seq: number;
  lastTradeDate: string;
  lastRoundId: string | null;
  cash: number;
  holdingsValue: number;
  totalValue: number;
}

/**
 * A round arrived that the book has already passed. The fold is forward-only,
 * so this is an invariant violation, not a recoverable condition — the caller
 * maps it to the `OUT_OF_SEQUENCE` / `ROUND_ALREADY_COMPLETE` policy errors.
 */
export class BackdatedRoundError extends Error {
  readonly roundSeq: number;
  readonly streamSeq: number;

  constructor(roundSeq: number, streamSeq: number) {
    super(
      `round_seq ${roundSeq} is not after the stream's last applied round_seq ${streamSeq} — the carryover fold is forward-only`,
    );
    this.name = "BackdatedRoundError";
    this.roundSeq = roundSeq;
    this.streamSeq = streamSeq;
  }
}

/** Map a DB `agent_portfolio_state` row to the fold's snapshot input. */
export function toStateSnapshot(row: {
  seq: number;
  lastTradeDate: string;
  lastRoundId: string | null;
  cash: string;
  holdingsValue: string;
  totalValue: string;
}): StateSnapshot {
  return {
    seq: row.seq,
    lastTradeDate: row.lastTradeDate,
    lastRoundId: row.lastRoundId,
    cash: num(row.cash),
    holdingsValue: num(row.holdingsValue),
    totalValue: num(row.totalValue),
  };
}

/** Map DB lot rows to the fold's cache input. */
export function toLotSnapshots(
  rows: readonly {
    symbol: string;
    shares: string;
    costBasis: string;
    targetWeight: string;
    openedFromRoundId: string;
    openedTradeDate: string;
    realizedPnl: string;
    thesis: string | null;
  }[],
): LotSnapshot[] {
  return rows.map((row) => ({
    symbol: row.symbol,
    shares: num(row.shares),
    costBasis: num(row.costBasis),
    targetWeight: num(row.targetWeight),
    openedFromRoundId: row.openedFromRoundId,
    openedTradeDate: row.openedTradeDate,
    realizedPnl: num(row.realizedPnl),
    thesis: row.thesis,
  }));
}

export interface ChainRebuildInput {
  key: StreamKey;
  /** The simulation's starting capital — the chain basis, identical in every segment. */
  basisCapital: number;
  rounds: readonly ChainRoundInput[];
  bars: BarsBySymbol;
}

/**
 * Recompute a stream's whole cache from its round history.
 *
 * Replay is from round 1 every time: there is no incremental shortcut here and
 * no snapshot to restore, so `replace`, a delete-and-refold, and a cold rebuild
 * are literally this function.
 */
export function planChainRebuild(input: ChainRebuildInput): StreamWritePlan {
  const ordered = [...input.rounds].sort((a, b) => a.roundSeq - b.roundSeq);
  if (ordered.length === 0) {
    return { state: null, lots: [], equity: [], summary: emptySummary() };
  }

  const key = input.key;
  const segments = buildSegments({
    key,
    basisCapital: input.basisCapital,
    rounds: ordered,
    bars: input.bars,
    openingBook: emptyBook(input.basisCapital),
  });

  const { steps, finalBook } = replaySegmentChain(segments, input.bars);
  const equitySeries = computeChainEquitySeries(segments, input.bars);
  const last = ordered[ordered.length - 1]!;
  const closes = closesOnOrBefore(input.bars, chainSymbols(ordered, finalBook), last.decideTradeDate);

  const provenance = foldLotProvenance([], steps, ordered);
  return {
    state: stateWrite({
      key,
      basisCapital: input.basisCapital,
      seq: last.roundSeq,
      lastTradeDate: last.decideTradeDate,
      lastRoundId: last.roundId,
      book: finalBook,
      closes,
    }),
    lots: lotWrites(finalBook, provenance, last.decideTradeDate, closes),
    equity: equityWrites(equitySeries, ordered),
    summary: summaryOf(last.roundSeq, finalBook, closes),
  };
}

/** One buy or sell in a stream's history, as the fold saw it. */
export interface ChainTransaction {
  roundId: string;
  roundSeq: number;
  decideTradeDate: string;
  symbol: string;
  /** "buy" when the line grew, "sell" when it shrank. Holds are not transactions. */
  side: "buy" | "sell";
  /** Absolute delta shares transacted (fractional shares are the norm). */
  shares: number;
  /** The close on `decideTradeDate` — the fill price. */
  price: number;
  /** Trade notional: shares × price. */
  value: number;
  /** sells only; 0 for buys — soldShares × (price − costBasis). */
  realizedPnl: number;
  thesis: string | null;
}

export interface ChainTransactionsInput {
  /** The chain basis the replay opens with. */
  basisCapital: number;
  rounds: readonly ChainRoundInput[];
  bars: BarsBySymbol;
}

/**
 * Replay a stream's round history through the fold to produce its buy/sell log.
 *
 * This is the SAME fold that materializes the cache (`planChainRebuild`), so
 * the log is guaranteed to agree with the stream's lots and equity curve: each
 * round opens with the previous round's next book, marks at the
 * `closesOnOrBefore` closes on its decide date, and emits one fill per target
 * line. Zero-delta lines (`hold`) are dropped — a no-op is not a trade.
 *
 * Newest chain position first, matching the `/rounds` wire convention.
 */
export function planChainTransactions(input: ChainTransactionsInput): ChainTransaction[] {
  const ordered = [...input.rounds].sort((a, b) => a.roundSeq - b.roundSeq);

  const symbols = new Set<string>();
  for (const round of ordered) {
    for (const target of round.targets) symbols.add(target.symbol);
  }

  const transactions: ChainTransaction[] = [];
  let book = emptyBook(input.basisCapital);
  for (const round of ordered) {
    const closes = closesOnOrBefore(input.bars, symbols, round.decideTradeDate);
    const step = applyDecision({
      openingBook: book,
      basisCapital: input.basisCapital,
      targets: round.targets,
      prices: Object.fromEntries(closes),
      asOfTradeDate: round.decideTradeDate,
    });
    for (const fill of step.fills) {
      if (fill.side === "hold") continue;
      transactions.push({
        roundId: round.roundId,
        roundSeq: round.roundSeq,
        decideTradeDate: round.decideTradeDate,
        symbol: fill.symbol,
        side: fill.side,
        shares: fill.shares,
        price: fill.price,
        value: fill.shares * fill.price,
        realizedPnl: fill.realizedPnl,
        thesis: round.theses?.get(fill.symbol) ?? null,
      });
    }
    book = step.nextBook;
  }
  return transactions.reverse();
}

export interface RoundFoldInput {
  key: StreamKey;
  round: ChainRoundInput;
  basisCapital: number;
  /** `null` on a stream's first round. */
  currentState: StateSnapshot | null;
  currentLots: readonly LotSnapshot[];
  bars: BarsBySymbol;
}

/**
 * Advance the cache by exactly ONE completed round.
 *
 * The state's marks, the gap equity points and the decision itself are produced
 * by the same W3 engine the rebuild uses, with the same bar-derived prices, so
 * folding 1..n one round at a time and folding 1..n in one pass agree exactly.
 *
 * @throws BackdatedRoundError when the round is not after the cached `seq`.
 */
export function planRoundFold(input: RoundFoldInput): StreamWritePlan {
  const { round, key, basisCapital } = input;
  const currentState = input.currentState;
  if (currentState !== null && round.roundSeq <= currentState.seq) {
    throw new BackdatedRoundError(round.roundSeq, currentState.seq);
  }

  const book: OpeningBook =
    currentState === null ? emptyBook(basisCapital) : bookFromLots(input.currentLots, currentState.cash);

  const symbols = new Set([...book.shares.keys(), ...round.targets.map((t) => t.symbol)]);
  const openTradeDate =
    currentState === null
      ? round.decideTradeDate
      : (nextTradingDate(input.bars, symbols, currentState.lastTradeDate) ?? round.decideTradeDate);

  const segment: EngineSegment = {
    roundId: round.roundId,
    roundSeq: round.roundSeq,
    openTradeDate,
    decideTradeDate: round.decideTradeDate,
    basisCapital,
    window: key.window,
    openingBook: book,
    decisions: round.targets,
  };

  const closes = closesOnOrBefore(input.bars, symbols, round.decideTradeDate);
  const step = applyDecision({
    openingBook: book,
    basisCapital,
    targets: round.targets,
    prices: Object.fromEntries(closes),
    asOfTradeDate: round.decideTradeDate,
  });
  const steps: SegmentStep[] = [
    {
      roundId: round.roundId,
      roundSeq: round.roundSeq,
      decideTradeDate: round.decideTradeDate,
      totalValue: step.totalValue,
      fills: step.fills,
      realizedPnl: step.realizedPnl,
      nextBook: step.nextBook,
    },
  ];

  const equitySeries = computeChainEquitySeries([segment], input.bars);
  const lastCloses = closesOnOrBefore(input.bars, symbols, round.decideTradeDate);
  const provenance = foldLotProvenance(input.currentLots, steps, [round]);

  return {
    state: stateWrite({
      key,
      basisCapital,
      seq: round.roundSeq,
      lastTradeDate: round.decideTradeDate,
      lastRoundId: round.roundId,
      book: step.nextBook,
      closes: lastCloses,
    }),
    lots: lotWrites(step.nextBook, provenance, round.decideTradeDate, lastCloses),
    // Every day in the gap was marked BEFORE this round's decision landed, so
    // the chain position in force on all of them is the previous one.
    equity: equitySeries.map((point) => ({
      tradeDate: point.tradeDate,
      cash: fixed(point.cash, 4),
      holdingsValue: fixed(point.holdingsValue, 4),
      totalValue: fixed(point.totalValue, 4),
      roundSeq: currentState?.seq ?? null,
    })),
    summary: summaryOf(round.roundSeq, step.nextBook, lastCloses),
  };
}

/* ------------------------------------------------------------------ *
 * internals
 * ------------------------------------------------------------------ */

function buildSegments(input: {
  key: StreamKey;
  basisCapital: number;
  rounds: readonly ChainRoundInput[];
  bars: BarsBySymbol;
  openingBook: OpeningBook;
}): EngineSegment[] {
  const { key, basisCapital, rounds, bars } = input;
  const allSymbols = new Set<string>();
  for (const round of rounds) for (const target of round.targets) allSymbols.add(target.symbol);

  const segments: EngineSegment[] = [];
  rounds.forEach((round, index) => {
    const previous = rounds[index - 1];
    // Contiguity is load-bearing (sharpe/vol/drawdown read consecutive points),
    // so segment k opens the first trading day after segment k-1's decision.
    const openTradeDate =
      previous === undefined
        ? round.decideTradeDate
        : (nextTradingDate(bars, allSymbols, previous.decideTradeDate) ?? round.decideTradeDate);
    segments.push({
      roundId: round.roundId,
      roundSeq: round.roundSeq,
      openTradeDate,
      decideTradeDate: round.decideTradeDate,
      basisCapital,
      window: key.window,
      // Only the first segment's book is trusted; the fold recomputes the rest.
      openingBook: index === 0 ? input.openingBook : emptyBook(0),
      decisions: round.targets,
    });
  });
  return segments;
}

/** Every symbol the chain can hold: anything any round decided on. */
function chainSymbols(
  rounds: readonly ChainRoundInput[],
  finalBook: OpeningBook,
): ReadonlySet<string> {
  const symbols = new Set<string>(finalBook.shares.keys());
  for (const round of rounds) for (const target of round.targets) symbols.add(target.symbol);
  return symbols;
}

/** Rebuild lot provenance from the fills, keeping `openedFromRoundId` immutable. */
function foldLotProvenance(
  previous: readonly LotProvenance[],
  steps: readonly SegmentStep[],
  rounds: readonly ChainRoundInput[],
): Map<string, LotProvenance> {
  const bySymbol = new Map<string, LotProvenance>();
  for (const lot of previous) bySymbol.set(lot.symbol, { ...lot });

  steps.forEach((step, index) => {
    const theses = rounds[index]?.theses;
    const realized = new Map<string, number>();
    for (const fill of step.fills) realized.set(fill.symbol, fill.realizedPnl);

    for (const [symbol, shares] of step.nextBook.shares) {
      const prior = bySymbol.get(symbol);
      bySymbol.set(symbol, {
        symbol,
        openedFromRoundId: prior?.openedFromRoundId ?? step.roundId,
        openedTradeDate: prior?.openedTradeDate ?? step.decideTradeDate,
        realizedPnl: (prior?.realizedPnl ?? 0) + (realized.get(symbol) ?? 0),
        thesis: theses?.get(symbol) ?? prior?.thesis ?? null,
      });
      if (shares <= 0) bySymbol.delete(symbol);
    }
  });

  // Anything the fold no longer holds is gone (a full liquidation).
  const survivors = steps[steps.length - 1]?.nextBook.shares ?? new Map<string, number>();
  for (const symbol of [...bySymbol.keys()]) {
    if (!survivors.has(symbol)) bySymbol.delete(symbol);
  }
  return bySymbol;
}

/** Rebuild the opening book straight from the cached lots plus the state's cash. */
function bookFromLots(lots: readonly LotSnapshot[], cash: number): OpeningBook {
  const shares = new Map<string, number>();
  const costBasis = new Map<string, number>();
  const targetWeights = new Map<string, number>();
  for (const lot of lots) {
    if (lot.shares <= 0) continue;
    shares.set(lot.symbol, lot.shares);
    costBasis.set(lot.symbol, lot.costBasis);
    targetWeights.set(lot.symbol, lot.targetWeight);
  }
  return { cash, shares, costBasis, targetWeights };
}

function stateWrite(input: {
  key: StreamKey;
  basisCapital: number;
  seq: number;
  lastTradeDate: string;
  lastRoundId: string;
  book: OpeningBook;
  closes: ReadonlyMap<string, number>;
}): StateWrite {
  const { holdingsValue, totalValue } = markBook(input.book, input.closes);
  return {
    simulationId: input.key.simulationId,
    personaKey: input.key.personaKey,
    window: input.key.window,
    seq: input.seq,
    lastTradeDate: input.lastTradeDate,
    lastRoundId: input.lastRoundId,
    initialCapital: fixed(input.basisCapital, 2),
    cash: fixed(input.book.cash, 4),
    holdingsValue: fixed(holdingsValue, 4),
    totalValue: fixed(totalValue, 4),
    targetJson: [...input.book.targetWeights.entries()].map(([symbol, targetWeight]) => ({
      symbol,
      targetWeight,
    })),
  };
}

function lotWrites(
  book: OpeningBook,
  provenance: ReadonlyMap<string, LotProvenance>,
  lastTradeDate: string,
  closes: ReadonlyMap<string, number>,
): LotWrite[] {
  const rows: LotWrite[] = [];
  for (const [symbol, shares] of book.shares) {
    const meta = provenance.get(symbol);
    const close = closes.get(symbol);
    rows.push({
      symbol,
      shares: fixed(shares, 6),
      costBasis: fixed(book.costBasis.get(symbol) ?? 0, 6),
      targetWeight: fixed(book.targetWeights.get(symbol) ?? 0, 6),
      openedFromRoundId: meta?.openedFromRoundId ?? "",
      openedTradeDate: meta?.openedTradeDate ?? lastTradeDate,
      lastTradeDate,
      lastPrice: close === undefined ? null : fixed(close, 4),
      realizedPnl: fixed(meta?.realizedPnl ?? 0, 4),
      thesis: meta?.thesis ?? null,
    });
  }
  rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return rows;
}

function equityWrites(
  points: readonly { tradeDate: string; cash: number; holdingsValue: number; totalValue: number }[],
  rounds: readonly ChainRoundInput[],
): EquityWrite[] {
  return points.map((point) => ({
    tradeDate: point.tradeDate,
    cash: fixed(point.cash, 4),
    holdingsValue: fixed(point.holdingsValue, 4),
    totalValue: fixed(point.totalValue, 4),
    roundSeq: seqInForce(point.tradeDate, rounds),
  }));
}

/**
 * The chain position in force when `tradeDate` was marked: the last round whose
 * decision landed STRICTLY before that date (a day that IS a decision date is
 * marked before that day's decision is applied).
 */
export function seqInForce(
  tradeDate: string,
  rounds: readonly { roundSeq: number; decideTradeDate: string }[],
): number | null {
  let seq: number | null = null;
  for (const round of rounds) {
    if (round.decideTradeDate < tradeDate && (seq === null || round.roundSeq > seq)) {
      seq = round.roundSeq;
    }
  }
  return seq;
}

function summaryOf(
  seq: number,
  book: OpeningBook,
  closes: ReadonlyMap<string, number>,
): StreamWritePlan["summary"] {
  const { holdingsValue, totalValue } = markBook(book, closes);
  return {
    seq,
    cash: book.cash,
    holdingsValue,
    totalValue,
    positionCount: book.shares.size,
  };
}

function emptySummary(): StreamWritePlan["summary"] {
  return { seq: 0, cash: 0, holdingsValue: 0, totalValue: 0, positionCount: 0 };
}

function markBook(
  book: OpeningBook,
  closes: ReadonlyMap<string, number>,
): { holdingsValue: number; totalValue: number } {
  let holdingsValue = 0;
  for (const [symbol, shares] of book.shares) holdingsValue += shares * (closes.get(symbol) ?? 0);
  return { holdingsValue, totalValue: book.cash + holdingsValue };
}

/** First close on or before `tradeDate` per symbol, forward-filled across halts. */
export function closesOnOrBefore(
  bars: BarsBySymbol,
  symbols: Iterable<string>,
  tradeDate: string,
): Map<string, number> {
  const prices = new Map<string, number>();
  for (const symbol of symbols) {
    let known = 0;
    for (const bar of bars.get(symbol) ?? []) {
      if (bar.tradeDate > tradeDate) break;
      known = bar.close;
    }
    prices.set(symbol, known);
  }
  return prices;
}

/** The first trading date strictly after `after` across the given symbols. */
export function nextTradingDate(
  bars: BarsBySymbol,
  symbols: Iterable<string>,
  after: string,
): string | null {
  let next: string | null = null;
  for (const symbol of symbols) {
    for (const bar of bars.get(symbol) ?? []) {
      if (bar.tradeDate <= after) continue;
      if (next === null || bar.tradeDate < next) next = bar.tradeDate;
      break;
    }
  }
  return next;
}

/** Bars for one symbol, oldest first (exposed for fixtures). */
export function barsOf(tradeDates: readonly string[], close: number): EngineBar[] {
  return tradeDates.map((tradeDate) => ({ tradeDate, close }));
}

function emptyBook(cash: number): OpeningBook {
  return {
    cash,
    shares: new Map<string, number>(),
    costBasis: new Map<string, number>(),
    targetWeights: new Map<string, number>(),
  };
}

function num(raw: string): number {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fixed(value: number, decimals: number): string {
  return (Number.isFinite(value) ? value : 0).toFixed(decimals);
}