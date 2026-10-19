/**
 * Decision-envelope persistence.
 *
 * Inserts one validated envelope into the DB inside a transaction:
 * - one `agent_runs` row (status "completed", rationale, full decisionJson,
 *   startedAt/completedAt), and
 * - one `portfolio_positions` row per KEPT position WITH ENTRY FILLS:
 *   - `entryTradeDate` = the dataset asOfTradeDate (latest trade_date),
 *   - `entryPrice` = that symbol's close on asOfTradeDate,
 *   - `shares` = (portfolioValue × targetWeight) / entryPrice (6dp).
 *
 * Liquidations (`targetWeight === 0`) get no `portfolio_positions` row: they are
 * exits, not entries, so there is no entry fill to record, and requiring an
 * entry price for them would reject exactly the exits envelope v2 exists to
 * permit (a symbol that stopped trading has no close on the decision date).
 * Recording the fold's realized exit is the carryover fold's job, not this
 * round-1 entry-fill path's.
 *
 * `persona` and `strategy` are written from the catalog (see
 * `InsertRunOptions`), never from `envelope.agent`: the model's own strings are
 * preserved verbatim in `decisionJson` for audit, but they are free text and
 * would otherwise fragment the leaderboard's grouping keys. `window` stays
 * model-supplied because it is already pinned by `expectedWindow` during spawn
 * and cross-checked against the window encoded in `agentKey` on ingest.
 *
 * Unique (roundId, agentKey): an existing run errors clearly — no silent
 * overwrite.
 */

import { and, eq } from "drizzle-orm";
import { agentRuns, db, portfolioPositions, roundJobs } from "@model_md/database";
import type { DecisionEnvelope } from "./contract.js";

export interface RoundBooking {
  simulationId: string | null;
  roundSeq: number;
  /** The mark the fold values the portfolio at; null for a legacy round. */
  asOfTradeDate: string | null;
}

/**
 * The chain identity a run must be written under. `agent_runs.round_id`
 * deliberately has no FK to `round_jobs`, so nothing in the schema stops a run
 * being written under a chain position that disagrees with its round's booking;
 * this read is where that invariant is enforced.
 */
export async function loadRoundBooking(roundId: string): Promise<RoundBooking | null> {
  const [row] = await db
    .select({
      simulationId: roundJobs.simulationId,
      roundSeq: roundJobs.roundSeq,
      asOfTradeDate: roundJobs.asOfTradeDate,
    })
    .from(roundJobs)
    .where(eq(roundJobs.roundId, roundId))
    .limit(1);
  if (row === undefined) return null;
  return {
    simulationId: row.simulationId,
    roundSeq: row.roundSeq,
    asOfTradeDate: row.asOfTradeDate,
  };
}

export interface InsertRunOptions {
  envelope: DecisionEnvelope;
  /** symbol → close on asOfTradeDate (the entry fill price). */
  entryPrices: Readonly<Record<string, number>>;
  /** The dataset asOfTradeDate — the entry trade date for every position. */
  asOfTradeDate: string;
  /**
   * Catalog display name, persisted to `agent_runs.persona`. Authoritative:
   * the value the model self-reports in `envelope.agent.persona` is free text
   * and would fragment the leaderboard.
   */
  expectedPersona: string;
  /**
   * Catalog strategy label, persisted to `agent_runs.strategy`. Authoritative
   * for the same reason — an LLM asked to echo a label will paraphrase it
   * ("macro-regime-quality-tilt" for `macro-quality`), which silently splits one
   * persona across several strategy buckets in the leaderboard.
   */
  expectedStrategy: string;
  /**
   * Chain position, from the `round_jobs` BOOKING row — never from the envelope,
   * whose `roundSeq` is model-supplied free text. NOT NULL in the schema
   * (migration 0005): a unique index cannot reject duplicate non-null pairs
   * while the column is nullable. A pre-carryover round is still booked (the
   * launch route writes `roundSeq: body.roundSeq ?? 1`), so this is required on
   * the legacy path too.
   */
  roundSeq: number;
  /**
   * The simulation this run belongs to, from the same booking row; `null` for a
   * pre-carryover round, which sits outside every chain. Required and nullable
   * rather than optional so every call site states which world it is in — an
   * omitted optional field would silently write a chainless row.
   */
  simulationId: string | null;
  /** When the analyst run started. Defaults to now. */
  startedAt?: Date;
  /**
   * Prompt-set stamp: `PROMPT_SET_VERSION` of the prompt that produced this
   * run; `null`/omitted stores NULL (legacy callers without stamping).
   */
  promptSetVersion?: string | null;
  /** Prompt-set stamp: sha256 hex of the static prompt template; NULL when absent. */
  promptHash?: string | null;
}

export interface InsertRunResult {
  agentRunId: number;
  positionsInserted: number;
}

export class DuplicateRunError extends Error {
  readonly roundId: string;
  readonly agentKey: string;

  constructor(roundId: string, agentKey: string) {
    super(
      `Agent run already exists for round "${roundId}" and agentKey "${agentKey}" — refusing to overwrite`,
    );
    this.name = "DuplicateRunError";
    this.roundId = roundId;
    this.agentKey = agentKey;
  }
}

export class MissingEntryPriceError extends Error {
  constructor(symbol: string, asOfTradeDate: string) {
    super(
      `No entry price available for "${symbol}" as of ${asOfTradeDate} — the symbol has no price data on the decision date`,
    );
    this.name = "MissingEntryPriceError";
  }
}

/** True when a postgres-js error is a unique-constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/**
 * Insert one validated envelope (agent run + positions with entry fills).
 * Throws `DuplicateRunError` when (roundId, agentKey) already exists.
 *
 * The legacy single-round write path: it records the run and its entry fills but
 * advances no carried state, so it is only correct for a round booked outside
 * every simulation chain. A chained round must go through the backend's
 * `insertRunAndFold`, which folds the state advance into the same transaction —
 * a run committed here could not be folded afterwards without either splitting
 * the transaction or deadlocking every retry behind the duplicate guard.
 */
export async function insertRun(opts: InsertRunOptions): Promise<InsertRunResult> {
  const { envelope, entryPrices, asOfTradeDate } = opts;
  const { roundId, agent } = envelope;

  const existing = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.roundId, roundId), eq(agentRuns.agentKey, agent.agentKey)))
    .limit(1);
  if (existing.length > 0) {
    throw new DuplicateRunError(roundId, agent.agentKey);
  }

  const completedAt = new Date();
  const startedAt = opts.startedAt ?? completedAt;

  try {
    return await db.transaction(async (tx) => {
      const [run] = await tx
        .insert(agentRuns)
        .values({
          roundId,
          simulationId: opts.simulationId,
          roundSeq: opts.roundSeq,
          agentKey: agent.agentKey,
          persona: opts.expectedPersona,
          strategy: opts.expectedStrategy,
          window: agent.window,
          initialCapital: agent.portfolioValue.toFixed(2),
          status: "completed",
          rationale: envelope.rationale,
          decisionJson: envelope,
          replicateOf: agent.replicateOf ?? null,
          startedAt,
          completedAt,
          promptSetVersion: opts.promptSetVersion ?? null,
          promptHash: opts.promptHash ?? null,
        })
        .returning({ id: agentRuns.id });

      const positions = envelope.positions
        .filter((position) => position.targetWeight > 0)
        .map((position) => {
          const entryPrice = entryPrices[position.symbol];
          if (entryPrice === undefined || !Number.isFinite(entryPrice) || entryPrice <= 0) {
            throw new MissingEntryPriceError(position.symbol, asOfTradeDate);
          }
          const shares = (agent.portfolioValue * position.targetWeight) / entryPrice;
          return {
            agentRunId: run.id,
            symbol: position.symbol,
            targetWeight: position.targetWeight.toFixed(6),
            shares: shares.toFixed(6),
            entryTradeDate: asOfTradeDate,
            entryPrice: entryPrice.toFixed(4),
            thesis: position.thesis,
          };
        });

      await tx.insert(portfolioPositions).values(positions);

      return { agentRunId: run.id, positionsInserted: positions.length };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new DuplicateRunError(roundId, agent.agentKey);
    }
    throw err;
  }
}
