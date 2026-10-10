/**
 * Rerun policy for carryover rounds (beads task 800.4, W4).
 *
 * Four errors that are ADJACENT but genuinely distinct, so they stay four codes
 * and never collapse into one generic 409 (spec R4):
 *
 * | code                    | meaning                                              | terminal |
 * |-------------------------|------------------------------------------------------|----------|
 * | `SAME_TRADE_DATE`       | a round for (simId, asOfTradeDate) is still in flight | no       |
 * | `ROUND_ALREADY_COMPLETE`| a round for (simId, asOfTradeDate) is terminal        | yes      |
 * | `STALE_TRADE_DATE`      | no new prices: MAX(trade_date) <= max(stream mark)    | no       |
 * | `OUT_OF_SEQUENCE`       | back-dated: asOfTradeDate <= max(stream mark)         | no       |
 *
 * `STALE_TRADE_DATE` vs `OUT_OF_SEQUENCE` is decided by INTENT, which is
 * observable: a launch whose `asOfTradeDate` equals the dataset's
 * `MAX(daily_prices.trade_date)` is asking for "the newest data" and there is
 * none past the book's last mark (`STALE_TRADE_DATE`), whereas an `asOfTradeDate`
 * strictly older than the dataset max is explicitly asking to replay a past day,
 * which the forward-only fold forbids (`OUT_OF_SEQUENCE`) unless `replace=true`.
 *
 * `replace=true` re-decides a FINISHED round: its `agent_runs` and equity rows
 * are deleted and the affected streams are re-folded from history in the same
 * transaction. `takeover=true` is a DIFFERENT, pre-existing flag — it re-runs a
 * PARTIALLY FAILED round's agents. The two are never conflated.
 *
 * Pure: no DB, no clock, no I/O. The route owns the writes; this module only
 * decides and explains.
 */

/** The distinct, non-collapsed rerun error codes. */
export const rerunErrorCodes = [
  "ROUND_ALREADY_COMPLETE",
  "SAME_TRADE_DATE",
  "STALE_TRADE_DATE",
  "OUT_OF_SEQUENCE",
] as const;

export type RerunErrorCode = (typeof rerunErrorCodes)[number];

/** One existing round for the (simulationId, asOfTradeDate) pair. */
export interface ExistingRound {
  roundId: string;
  status: string;
  /** `null` for a pre-carryover round; such rows never make a launch terminal. */
  roundSeq: number | null;
}

export interface RerunPolicyInput {
  /** `replace=true` re-decides a FINISHED round instead of rejecting it. */
  replace: boolean;
  /** The dataset's `asOfTradeDate` — `MAX(daily_prices.trade_date)` by construction. */
  asOfTradeDate: string;
  /** Every round already recorded for this (simulationId, asOfTradeDate). */
  existingRounds: readonly ExistingRound[];
  /**
   * `MAX(daily_prices.trade_date)` — the newest close available to a launch.
   * `null` means the feed has no bars at all.
   */
  latestTradeDate: string | null;
  /**
   * `last_trade_date` of every SELECTED stream that already has materialized
   * state. Streams without state are first-round streams and are excluded here
   * (they place no constraint on the chain).
   */
  streamLastTradeDates: readonly string[];
}

/** A rejected launch: one code, an actionable hint, and the dates behind it. */
export interface RerunRejection {
  ok: false;
  code: RerunErrorCode;
  /** Terminal errors cannot be cleared by waiting; the others can. */
  terminal: boolean;
  error: string;
  hint: string;
  detail: {
    asOfTradeDate: string;
    latestTradeDate: string | null;
    /** Highest existing book mark, or `null` when no selected stream has state. */
    streamLastTradeDate: string | null;
    roundIds: string[];
  };
}

export interface RerunAllowed {
  ok: true;
  /** `replace` deletes and re-folds; `insert` advances the chain. */
  action: "insert" | "replace";
  /** Terminal rounds to delete before re-folding (empty for `insert`). */
  replaceRoundIds: string[];
}

/** Terminal statuses mirror `round_jobs`; duplicated here to keep this module pure. */
const TERMINAL_STATUSES = new Set(["done", "partial", "error"]);

const isTerminal = (status: string): boolean => TERMINAL_STATUSES.has(status);

const maxOrNull = (dates: readonly string[]): string | null =>
  dates.length === 0 ? null : dates.reduce((a, b) => (a > b ? a : b));

/**
 * Decide whether a round launch may proceed.
 *
 * Order is load-bearing: the in-flight check runs BEFORE the terminal check, so
 * a round that is still running is never misreported as "already complete" —
 * those two are the same lookup with opposite answers and the user needs to be
 * told which one they are looking at.
 */
export function decideRerun(input: RerunPolicyInput): RerunAllowed | RerunRejection {
  const { asOfTradeDate, existingRounds, latestTradeDate, streamLastTradeDates, replace } = input;
  const streamLastTradeDate = maxOrNull(streamLastTradeDates);
  const detail = {
    asOfTradeDate,
    latestTradeDate,
    streamLastTradeDate,
    roundIds: existingRounds.map((r) => r.roundId),
  };

  const inFlight = existingRounds.find((r) => !isTerminal(r.status));
  if (inFlight !== undefined) {
    return {
      ok: false,
      code: "SAME_TRADE_DATE",
      terminal: false,
      error: `a round for asOfTradeDate ${asOfTradeDate} is already in flight (round "${inFlight.roundId}", status=${inFlight.status})`,
      hint: "Poll GET /api/portfolio/rounds/:roundId/job, or re-launch that round with takeover=true to reset a partially failed round.",
      detail,
    };
  }

  const terminalRounds = existingRounds.filter((r) => isTerminal(r.status));
  if (terminalRounds.length > 0 && !replace) {
    const first = terminalRounds[0]!;
    return {
      ok: false,
      code: "ROUND_ALREADY_COMPLETE",
      terminal: true,
      error: `round "${first.roundId}" for asOfTradeDate ${asOfTradeDate} already completed (status=${first.status}) — its decisions are all present`,
      hint: "Pass replace=true to discard that round's decisions and re-decide from its book.",
      detail,
    };
  }

  if (terminalRounds.length > 0 && replace) {
    return { ok: true, action: "replace", replaceRoundIds: terminalRounds.map((r) => r.roundId) };
  }

  // A brand-new chain position: the fold may only move forward.
  if (latestTradeDate === null) {
    return {
      ok: false,
      code: "STALE_TRADE_DATE",
      terminal: false,
      error: "no price data is available — MAX(daily_prices.trade_date) is null",
      hint: "Run market-data ingestion before launching a round.",
      detail,
    };
  }

  if (asOfTradeDate > latestTradeDate) {
    return {
      ok: false,
      code: "STALE_TRADE_DATE",
      terminal: false,
      error: `asOfTradeDate ${asOfTradeDate} is ahead of the newest available close ${latestTradeDate}`,
      hint: "Rebuild the round dataset so asOfTradeDate is MAX(daily_prices.trade_date).",
      detail,
    };
  }

  if (
    streamLastTradeDate !== null &&
    asOfTradeDate === latestTradeDate &&
    latestTradeDate <= streamLastTradeDate
  ) {
    return {
      ok: false,
      code: "STALE_TRADE_DATE",
      terminal: false,
      error: `no new prices since the book was last marked: MAX(daily_prices.trade_date) is ${latestTradeDate}, and the selected streams are marked through ${streamLastTradeDate}`,
      hint: "Wait for a new session's closes, or pass replace=true to re-decide the round already recorded for this date.",
      detail,
    };
  }

  if (
    streamLastTradeDate !== null &&
    asOfTradeDate < latestTradeDate &&
    asOfTradeDate <= streamLastTradeDate
  ) {
    return {
      ok: false,
      code: "OUT_OF_SEQUENCE",
      terminal: false,
      error: `back-dated round: asOfTradeDate ${asOfTradeDate} is not after the streams' last mark ${streamLastTradeDate} (newest close is ${latestTradeDate})`,
      hint: `The fold is forward-only. Re-decide the chain at ${latestTradeDate}, or open a DIFFERENT simulation to replay history cleanly.`,
      detail,
    };
  }

  return { ok: true, action: "insert", replaceRoundIds: [] };
}

/** HTTP status for a rejection: every rerun error is a 409. */
export const rerunRejectionStatus = 409;

/** Narrow a decision to a rejection (used by the route before mapping to `c.json`). */
export function isRerunRejection(
  decision: RerunAllowed | RerunRejection,
): decision is RerunRejection {
  return decision.ok === false;
}
