/**
 * The book one analyst stream carries INTO a round.
 *
 * Envelope v2 makes a decision a COMPLETE target book, so the runner has to
 * know what a stream already holds before it spawns that stream's analyst. The
 * carried book becomes the prompt's HOLDINGS section, `heldSymbols` drives the
 * sell-membership and complete-book omission checks, and `portfolioValue` is
 * the number the target weights apply to.
 *
 * Those three are derived here, once, from the two facts the state row reports
 * (the open lines and the cash balance), so they cannot drift apart: no caller
 * can hand the spawner a `heldSymbols` set that disagrees with the holdings it
 * passed alongside it, or a `portfolioValue` that is not cash plus positions.
 *
 * Nothing in this module reads the network. A stream that has not been folded
 * yet genuinely holds nothing, so `streamBook([], capital)` is an honest
 * opening book rather than a placeholder: Phase 2 replaces the runner's
 * default with the backend streams API and does not change this shape.
 */

import type { DecisionHolding } from "@model_md/agent-orchestrator";

export interface StreamBook {
  /** The open lines exactly as the analyst sees them. Empty on a first round. */
  readonly holdings: readonly DecisionHolding[];
  readonly cash: number;
  readonly holdingsValue: number;
  /** Cash plus open positions, marked at the decision date. */
  readonly portfolioValue: number;
  /** The only symbols a zero-weight exit is allowed to name. */
  readonly heldSymbols: ReadonlySet<string>;
  /** The round this book was folded by; `null` on a stream's first round. */
  readonly priorRoundId: string | null;
}

export function streamBook(
  holdings: readonly DecisionHolding[],
  cash: number,
  priorRoundId: string | null = null,
): StreamBook {
  const holdingsValue = holdings.reduce((total, h) => total + h.marketValue, 0);
  return {
    holdings,
    cash,
    holdingsValue,
    portfolioValue: cash + holdingsValue,
    heldSymbols: new Set(holdings.map((h) => h.symbol)),
    priorRoundId,
  };
}
