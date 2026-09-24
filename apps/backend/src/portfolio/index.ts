/**
 * Portfolio-simulation engine (beads task ez8.2).
 *
 * Pure derivation (valuation + ranking) plus the read-only query helpers the
 * RPC routes use to load runs / positions / bars. The engine NEVER writes to
 * the DB — the orchestrator owns ingest; this layer reads and derives only.
 *
 * Query helpers are exported for downstream tests (mirroring the
 * `marketData.ts` exported-helpers-for-tests pattern).
 */

import { and, asc, desc, eq, exists, inArray } from "drizzle-orm";
import { agentRuns, dailyPrices, db, instruments, portfolioPositions } from "@model_md/database";
import type { AgentRun, PortfolioPosition } from "@model_md/database";
import type { DbClient } from "@model_md/market-data";

export type { EquityPoint, PortfolioWindow, RankingResult } from "./types.js";
export { parseNumeric, REBALANCE_CADENCE } from "./types.js";
export type { BarsBySymbol, EngineBar, EnginePosition, EngineRun } from "./valuation.js";
export { computeEquitySeries } from "./valuation.js";
export { computeRanking } from "./ranking.js";

/** One bar row as the bars query returns it (numeric close still a string). */
export interface BarRow {
  symbol: string;
  name: string | null;
  tradeDate: string;
  close: string | null;
}

/**
 * Completed runs with at least one position, newest first. When `roundId` is
 * omitted, the latest round (by run created_at) is used.
 */
export async function loadRunsForLeaderboard(
  dbClient: DbClient,
  roundId?: string,
): Promise<AgentRun[]> {
  let effectiveRoundId = roundId;
  if (effectiveRoundId === undefined) {
    const [latest] = await dbClient
      .select({ roundId: agentRuns.roundId })
      .from(agentRuns)
      .innerJoin(portfolioPositions, eq(portfolioPositions.agentRunId, agentRuns.id))
      .where(eq(agentRuns.status, "completed"))
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    effectiveRoundId = latest?.roundId;
    if (effectiveRoundId === undefined) return [];
  }

  return dbClient
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.status, "completed"),
        eq(agentRuns.roundId, effectiveRoundId),
        exists(
          dbClient
            .select({ id: portfolioPositions.id })
            .from(portfolioPositions)
            .where(eq(portfolioPositions.agentRunId, agentRuns.id)),
        ),
      ),
    )
    .orderBy(desc(agentRuns.createdAt));
}

/** One run by id, regardless of status (the route enforces `completed`). */
export async function loadRunById(dbClient: DbClient, id: number): Promise<AgentRun | undefined> {
  const [run] = await dbClient.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
  return run;
}

/** All positions for the given run ids, ordered by run then symbol. */
export async function loadPositionsForRuns(
  dbClient: DbClient,
  runIds: readonly number[],
): Promise<PortfolioPosition[]> {
  if (runIds.length === 0) return [];
  return dbClient
    .select()
    .from(portfolioPositions)
    .where(inArray(portfolioPositions.agentRunId, [...runIds]))
    .orderBy(asc(portfolioPositions.agentRunId), asc(portfolioPositions.symbol));
}

/**
 * Daily bars for the given symbols (instrument → symbol via `instruments`),
 * oldest-first. Only symbols with at least one bar appear.
 */
export async function loadBarsForRuns(
  dbClient: DbClient,
  symbols: readonly string[],
): Promise<BarRow[]> {
  if (symbols.length === 0) return [];
  return dbClient
    .select({
      symbol: instruments.symbol,
      name: instruments.name,
      tradeDate: dailyPrices.tradeDate,
      close: dailyPrices.close,
    })
    .from(dailyPrices)
    .innerJoin(instruments, eq(dailyPrices.instrumentId, instruments.id))
    .where(inArray(instruments.symbol, [...symbols]))
    .orderBy(asc(dailyPrices.tradeDate));
}
