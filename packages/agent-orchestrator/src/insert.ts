/**
 * Decision-envelope persistence.
 *
 * Inserts one validated envelope into the DB inside a transaction:
 * - one `agent_runs` row (status "completed", rationale, full decisionJson,
 *   startedAt/completedAt), and
 * - one `portfolio_positions` row per pick WITH ENTRY FILLS:
 *   - `entryTradeDate` = the dataset asOfTradeDate (latest trade_date),
 *   - `entryPrice` = that symbol's close on asOfTradeDate,
 *   - `shares` = (initialCapital × targetWeight) / entryPrice (6dp).
 *
 * Unique (roundId, agentKey): an existing run errors clearly — no silent
 * overwrite.
 */

import { and, eq } from "drizzle-orm";
import { agentRuns, db, portfolioPositions } from "@model_md/database";
import type { DecisionEnvelope } from "./contract.js";

export interface InsertRunOptions {
  envelope: DecisionEnvelope;
  /** symbol → close on asOfTradeDate (the entry fill price). */
  entryPrices: Readonly<Record<string, number>>;
  /** The dataset asOfTradeDate — the entry trade date for every position. */
  asOfTradeDate: string;
  /** When the analyst run started. Defaults to now. */
  startedAt?: Date;
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
          agentKey: agent.agentKey,
          persona: agent.persona,
          strategy: agent.strategy,
          window: agent.window,
          initialCapital: agent.initialCapital.toFixed(2),
          status: "completed",
          rationale: envelope.rationale,
          decisionJson: envelope,
          replicateOf: agent.replicateOf ?? null,
          startedAt,
          completedAt,
        })
        .returning({ id: agentRuns.id });

      const positions = envelope.picks.map((pick) => {
        const entryPrice = entryPrices[pick.symbol];
        if (entryPrice === undefined || !Number.isFinite(entryPrice) || entryPrice <= 0) {
          throw new MissingEntryPriceError(pick.symbol, asOfTradeDate);
        }
        const shares = (agent.initialCapital * pick.weight) / entryPrice;
        return {
          agentRunId: run.id,
          symbol: pick.symbol,
          targetWeight: pick.weight.toFixed(6),
          shares: shares.toFixed(6),
          entryTradeDate: asOfTradeDate,
          entryPrice: entryPrice.toFixed(4),
          thesis: pick.thesis,
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
