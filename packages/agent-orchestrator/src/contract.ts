/**
 * Decision envelope contract — the shared handoff between the analyst
 * orchestrator (this package) and the backend carryover/valuation engine.
 *
 * **v2 is a COMPLETE TARGET BOOK, not a list of new picks.** The portfolio
 * carries positions and cash across rounds, so an envelope states what the
 * whole book should be at the next mark:
 * - `targetWeight > 0` — keep or buy, sized as a share of total portfolio value.
 * - `targetWeight === 0` — LIQUIDATE ENTIRELY. This is the only sell verb.
 * - omitting a held symbol is a VALIDATION ERROR. Omission is never a hold and
 *   never an implicit liquidation: the fold reads a missing name as "exit it",
 *   so a model that forgets one line silently dumps that position.
 *
 * There is deliberately NO `side`, `quantity`, `delta`, or `trimFraction`. The
 * whole sizing path — validation, sum-to-one, share math, rebalance — is
 * target-weight machinery, and a trim is already a reduced positive
 * `targetWeight` ("halve JNJ" is `jnjWeight / 2`). A second sizing primitive
 * would add share/cash math, rounding, and a cash-solvency validation model for
 * zero added expressiveness. Because every target is a fraction of the same
 * mark, cash solvency cannot be violated by construction.
 *
 * Sells are exempt from universe and price membership so a name that stopped
 * trading or left the feed can still be exited — a deliberate relaxation.
 * Buys are not exempt: they must be priced and in the universe.
 *
 * The rename `picks` → `positions` and `weight` → `targetWeight` is honest
 * bookkeeping, not churn: "picks" becomes factually wrong once exits exist, and
 * `targetWeight` matches the `portfolio_positions.target_weight` column, so the
 * translation layer disappears. Likewise `initialCapital` → `portfolioValue`:
 * after round 1 "initial capital" is false — the field carries the per-decision
 * portfolio value the weights applied to, and the chain basis lives on the
 * stream's own state row.
 *
 * This module owns the public types and the envelope-level rules; the position
 * and agent rule bodies live in `contractRules.ts`.
 */

import {
  agentIssues,
  isNonEmptyString,
  isPositiveInteger,
  isRecord,
  positionIssues,
} from "./contractRules.js";

export const DECISION_SCHEMA_VERSION = 2 as const;

export const DECISION_WINDOWS = ["daily", "weekly", "monthly"] as const;
export type DecisionWindow = (typeof DECISION_WINDOWS)[number];

/** Minimum number of BUYS (`targetWeight > 0`). Sell lines never count. */
export const MIN_PICKS = 5;
/** Maximum number of BUYS (`targetWeight > 0`). Sell lines never count. */
export const MAX_PICKS = 10;
export const WEIGHT_SUM_MIN = 0.99;
export const WEIGHT_SUM_MAX = 1.01;
/** Hard ceiling on one target weight. `0` is legal and means "liquidate". */
export const TARGET_WEIGHT_MAX = 1;

export interface DecisionPosition {
  symbol: string;
  /** Target share of TOTAL portfolio value. `0` = liquidate entirely. */
  targetWeight: number;
  thesis: string;
}

/**
 * One currently-held line exactly as the analyst sees it. The agent's rules
 * reference its own book (trend flips, holding age, cost basis), so the book
 * must be in the prompt — a rule about a position the model cannot see is
 * unenforceable.
 */
export interface DecisionHolding {
  symbol: string;
  shares: number;
  /** Per-share average cost (shares-weighted across the open lots). */
  costBasis: number;
  lastPrice: number;
  marketValue: number;
  /** Current share of total portfolio value. */
  weight: number;
  holdingDays: number;
  /** Unrealized P&L against `costBasis`, in percent. */
  unrealizedPnlPct: number;
}

export interface DecisionAgent {
  agentKey: string;
  persona: string;
  strategy: string;
  window: DecisionWindow;
  /** Total value the target weights apply to (cash + holdings at asOf). */
  portfolioValue: number;
  cash: number;
  holdingsValue: number;
  /** `null` on a stream's first round. */
  priorRoundId: string | null;
  roundSeq: number;
  replicateOf?: string;
}

export interface DecisionEnvelope {
  schemaVersion: typeof DECISION_SCHEMA_VERSION;
  roundId: string;
  simulationId: string;
  roundSeq: number;
  agent: DecisionAgent;
  rationale: string;
  /** COMPLETE target book: keeps (> 0) plus explicit exits (=== 0). No omissions. */
  positions: DecisionPosition[];
}

/** Options describing the stream the envelope is validated against. */
export interface ValidateEnvelopeOptions {
  /** All valid symbols in the universe (e.g. the DEFAULT_UNIVERSE tickers). */
  universe: readonly string[];
  /** Symbols with at least one price bar as of the decision date — BUYS only. */
  symbolsWithPrice: ReadonlySet<string>;
  /**
   * Symbols the stream currently holds. REQUIRED, not optional: it drives both
   * the sell-membership check (you may only liquidate what you hold) and the
   * omission check (a complete book must account for every holding). Leaving it
   * optional would silently disable both and turn the envelope back into a list
   * of picks.
   */
  heldSymbols: ReadonlySet<string>;
  /**
   * The window the round assigned to this agent. When set, an envelope whose
   * `agent.window` differs is rejected: membership in DECISION_WINDOWS is not
   * enough, because a persona run on several windows would otherwise be free to
   * report whichever cadence it likes and the round would no longer be a clean
   * strategy x window cross product.
   */
  expectedWindow?: DecisionWindow;
  /** Value the weights must sum against. Enables the cash-solvency check. */
  portfolioValue?: number;
  expectedSimulationId?: string;
  expectedRoundSeq?: number;
}

/** Typed validation failure — `issues` carries one message per violation. */
export class DecisionValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Decision envelope validation failed:\n- ${issues.join("\n- ")}`);
    this.name = "DecisionValidationError";
    this.issues = issues;
  }
}

/**
 * Validate an unknown payload as a `DecisionEnvelope`.
 *
 * Throws `DecisionValidationError` (with one message per issue) on any
 * violation. Returns the typed envelope on success. The nine v2 rules:
 *
 * 1. `schemaVersion === 2`.
 * 2. `positions` is an array with no duplicate symbols.
 * 3. Buys (`targetWeight > 0`): count in [MIN_PICKS, MAX_PICKS]; `0 <= w <=
 *    TARGET_WEIGHT_MAX`; symbol in `universe` AND in `symbolsWithPrice`.
 * 4. Sells (`targetWeight === 0`): unlimited count; symbol in `heldSymbols`;
 *    NOT required in `universe` or `symbolsWithPrice`.
 * 5. No symbol twice, so "sell then rebuy" is simply a positive `targetWeight`.
 * 6. `round(Σ targetWeight over buys, 6dp)` within the weight-sum tolerance.
 * 7. `heldSymbols \ {symbols in envelope}` is empty; else name every omission.
 * 8. `simulationId` / `roundSeq` match the runner's bookkeeping when supplied.
 * 9. `AGENT_KEY_PATTERN`, window pinning, `replicateOf` — unchanged.
 */
export function validateEnvelope(value: unknown, opts: ValidateEnvelopeOptions): DecisionEnvelope {
  const issues: string[] = [];

  if (!isRecord(value)) {
    throw new DecisionValidationError(["envelope must be a JSON object"]);
  }

  // Rule 1 — schema version.
  if (value.schemaVersion !== DECISION_SCHEMA_VERSION) {
    issues.push(
      `schemaVersion must be ${DECISION_SCHEMA_VERSION}, got ${JSON.stringify(value.schemaVersion)}`,
    );
  }

  if (!isNonEmptyString(value.roundId)) {
    issues.push("roundId must be a non-empty string");
  }
  if (!isNonEmptyString(value.simulationId)) {
    issues.push("simulationId must be a non-empty string");
  }

  // Rule 8 — anti-drift against the runner's own bookkeeping, so a stale or
  // re-ordered envelope cannot be attributed to the wrong step of the chain.
  if (
    isNonEmptyString(value.simulationId) &&
    opts.expectedSimulationId !== undefined &&
    value.simulationId !== opts.expectedSimulationId
  ) {
    issues.push(
      `simulationId must be "${opts.expectedSimulationId}" (the simulation the runner booked), got ${JSON.stringify(value.simulationId)}`,
    );
  }
  if (!isPositiveInteger(value.roundSeq)) {
    issues.push(`roundSeq must be a positive integer, got ${JSON.stringify(value.roundSeq)}`);
  } else if (opts.expectedRoundSeq !== undefined && value.roundSeq !== opts.expectedRoundSeq) {
    issues.push(
      `roundSeq must be ${opts.expectedRoundSeq} (the round the runner booked), got ${JSON.stringify(value.roundSeq)}`,
    );
  }

  // The envelope carries roundSeq twice — top level and inside `agent`. Both
  // can pass as positive integers while disagreeing, which would persist a
  // decisionJson that contradicts the chain position the run is folded at.
  if (
    isRecord(value.agent) &&
    isPositiveInteger(value.roundSeq) &&
    isPositiveInteger(value.agent.roundSeq) &&
    value.agent.roundSeq !== value.roundSeq
  ) {
    issues.push(
      `agent.roundSeq must equal envelope.roundSeq (${value.roundSeq}), got ${JSON.stringify(value.agent.roundSeq)}`,
    );
  }

  // Rule 9 — agent identity, window pinning, and the stream's carried state.
  if (!isRecord(value.agent)) {
    issues.push("agent must be an object");
  } else {
    issues.push(...agentIssues(value.agent, opts));
  }

  if (!isNonEmptyString(value.rationale)) {
    issues.push("rationale must be a non-empty string");
  }

  // Rules 2-7 — the position block.
  if (!Array.isArray(value.positions)) {
    issues.push("positions must be an array");
  } else {
    issues.push(...positionIssues(value.positions, opts));
  }

  if (issues.length > 0) {
    throw new DecisionValidationError(issues);
  }

  return value as unknown as DecisionEnvelope;
}
