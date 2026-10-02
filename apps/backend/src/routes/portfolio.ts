import { Hono } from "hono";
import { db } from "@model_md/database";
import type { AgentRun, PortfolioPosition } from "@model_md/database";
import {
  computeEquitySeries,
  computeRanking,
  loadBarsForRuns,
  loadPositionsForRuns,
  loadRunById,
  loadRunsForLeaderboard,
  parseNumeric,
} from "../portfolio/index.js";
import type {
  BarRow,
  EngineBar,
  EnginePosition,
  EngineRun,
  EquityPoint,
  RankingResult,
} from "../portfolio/index.js";

/**
 * Portfolio-simulation RPC routes (beads task ez8.2).
 *
 * Public reads (no auth, consistent with market-data reads): the leaderboard
 * of completed agent runs (optional ?round filter, default latest round) and
 * one run's drilldown with positions + equity curve.
 *
 * Wire convention: portfolio values are COMPUTED numbers, so they go out as
 * JSON numbers (unlike raw OHLC bars which stay strings). Only DB numeric
 * strings are parsed here, at the edge.
 */

/** One row of the GET /leaderboard response. */
export interface LeaderboardRowWire {
  runId: number;
  agentKey: string;
  persona: string;
  strategy: string;
  window: string;
  replicateOf: string | null;
  roundId: string;
  initialCapital: number;
  currentValue: number;
  totalReturnPct: number;
  annualizedVolPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  asOfTradeDate: string;
  status: string;
}

/** One position of the GET /agents/:id response. */
export interface PositionWire {
  symbol: string;
  name: string | null;
  targetWeight: number;
  shares: number;
  entryTradeDate: string;
  entryPrice: number;
  latestTradeDate: string;
  latestPrice: number;
  value: number;
  unrealizedPnlPct: number;
}

/** One equity-curve point of the GET /agents/:id response. */
export interface EquityPointWire {
  tradeDate: string;
  totalValue: number;
  returnPct: number;
  cash: number;
  holdingsValue: number;
}

/** The GET /agents/:id response: leaderboard fields + drilldown. */
export interface AgentDetailWire extends LeaderboardRowWire {
  rationale: string | null;
  decisionJson: unknown;
  positions: PositionWire[];
  equitySeries: EquityPointWire[];
}

/** Bars grouped by symbol, carrying the instrument name. */
export interface SymbolBars {
  name: string | null;
  bars: EngineBar[];
}

/** Group bar rows by symbol (oldest-first preserved). */
export function groupBarsBySymbol(rows: readonly BarRow[]): Map<string, SymbolBars> {
  const map = new Map<string, SymbolBars>();
  for (const row of rows) {
    const close = parseNumeric(row.close);
    if (!Number.isFinite(close)) continue;
    let entry = map.get(row.symbol);
    if (entry === undefined) {
      entry = { name: row.name, bars: [] };
      map.set(row.symbol, entry);
    }
    entry.bars.push({ tradeDate: row.tradeDate, close });
  }
  return map;
}

/** Positions grouped by agent run id. */
export function groupPositionsByRun(
  positions: readonly PortfolioPosition[],
): Map<number, PortfolioPosition[]> {
  const map = new Map<number, PortfolioPosition[]>();
  for (const pos of positions) {
    const list = map.get(pos.agentRunId) ?? [];
    list.push(pos);
    map.set(pos.agentRunId, list);
  }
  return map;
}

/** Map a DB run row to the engine's run input. */
export function toEngineRun(run: AgentRun): EngineRun {
  return {
    initialCapital: parseNumeric(run.initialCapital),
    window: run.window,
  };
}

/** Map a DB position row to the engine's position input. */
export function toEnginePosition(pos: PortfolioPosition): EnginePosition {
  return {
    symbol: pos.symbol,
    targetWeight: parseNumeric(pos.targetWeight),
    shares: parseNumeric(pos.shares),
    entryTradeDate: pos.entryTradeDate ?? "",
    entryPrice: parseNumeric(pos.entryPrice),
  };
}

/** Shape one leaderboard row from a run + its ranking. */
export function toLeaderboardRow(run: AgentRun, ranking: RankingResult): LeaderboardRowWire {
  return {
    runId: run.id,
    agentKey: run.agentKey,
    persona: run.persona,
    strategy: run.strategy,
    window: run.window,
    replicateOf: run.replicateOf,
    roundId: run.roundId,
    initialCapital: parseNumeric(run.initialCapital),
    currentValue: ranking.currentValue,
    totalReturnPct: ranking.totalReturnPct,
    annualizedVolPct: ranking.annualizedVolPct,
    sharpe: ranking.sharpe,
    maxDrawdownPct: ranking.maxDrawdownPct,
    asOfTradeDate: ranking.asOfTradeDate,
    status: run.status,
  };
}

/**
 * Derive the leaderboard rows for the given runs (completed, with positions),
 * sorted by totalReturnPct DESC. Pure derivation over pre-loaded rows.
 */
export function buildLeaderboard(
  runs: readonly AgentRun[],
  positions: readonly PortfolioPosition[],
  bars: readonly BarRow[],
): LeaderboardRowWire[] {
  const positionsByRun = groupPositionsByRun(positions);
  const groupedBars = groupBarsBySymbol(bars);
  const barsBySymbol = new Map<string, readonly EngineBar[]>();
  for (const [symbol, { bars: symbolBars }] of groupedBars) {
    barsBySymbol.set(symbol, symbolBars);
  }

  const rows: LeaderboardRowWire[] = [];
  for (const run of runs) {
    const runPositions = positionsByRun.get(run.id) ?? [];
    if (runPositions.length === 0) continue;
    const series = computeEquitySeries(
      toEngineRun(run),
      runPositions.map(toEnginePosition),
      barsBySymbol,
    );
    rows.push(toLeaderboardRow(run, computeRanking(series)));
  }
  rows.sort((a, b) => b.totalReturnPct - a.totalReturnPct);
  return rows;
}

/** Derive the full drilldown for one run (positions + equity curve). */
export function buildAgentDetail(
  run: AgentRun,
  positions: readonly PortfolioPosition[],
  bars: readonly BarRow[],
): AgentDetailWire {
  const groupedBars = groupBarsBySymbol(bars);
  const barsBySymbol = new Map<string, readonly EngineBar[]>();
  for (const [symbol, { bars: symbolBars }] of groupedBars) {
    barsBySymbol.set(symbol, symbolBars);
  }

  const series = computeEquitySeries(
    toEngineRun(run),
    positions.map(toEnginePosition),
    barsBySymbol,
  );
  const ranking = computeRanking(series);

  const positionWires: PositionWire[] = positions.map((pos) => {
    const symbolBars = groupedBars.get(pos.symbol);
    const symbolBarsList = symbolBars?.bars ?? [];
    const latest =
      symbolBarsList.length > 0 ? symbolBarsList[symbolBarsList.length - 1] : undefined;
    const entryPrice = parseNumeric(pos.entryPrice);
    const shares = parseNumeric(pos.shares);
    const latestPrice = latest?.close ?? entryPrice;
    const value = shares * latestPrice;
    const unrealizedPnlPct = entryPrice === 0 ? 0 : ((latestPrice - entryPrice) / entryPrice) * 100;
    return {
      symbol: pos.symbol,
      name: symbolBars?.name ?? null,
      targetWeight: parseNumeric(pos.targetWeight),
      shares,
      entryTradeDate: pos.entryTradeDate ?? "",
      entryPrice,
      latestTradeDate: latest?.tradeDate ?? pos.entryTradeDate ?? "",
      latestPrice,
      value,
      unrealizedPnlPct,
    };
  });

  return {
    ...toLeaderboardRow(run, ranking),
    rationale: run.rationale,
    decisionJson: run.decisionJson,
    positions: positionWires,
    equitySeries: series.map(
      (p: EquityPoint): EquityPointWire => ({
        tradeDate: p.tradeDate,
        totalValue: p.totalValue,
        returnPct: p.returnPct,
        cash: p.cash,
        holdingsValue: p.holdingsValue,
      }),
    ),
  };
}

const portfolioApp = new Hono()
  .get("/leaderboard", async (c) => {
    const roundId = c.req.query("round")?.trim() || undefined;
    const runs = await loadRunsForLeaderboard(db, roundId);
    if (runs.length === 0) return c.json([]);
    const positions = await loadPositionsForRuns(
      db,
      runs.map((r) => r.id),
    );
    const symbols = [...new Set(positions.map((p) => p.symbol))];
    const bars = await loadBarsForRuns(db, symbols);
    return c.json(buildLeaderboard(runs, positions, bars));
  })

  .get("/agents/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: "Invalid run id", hint: "run id must be a positive integer" }, 400);
    }
    const run = await loadRunById(db, id);
    if (run === undefined || run.status !== "completed") {
      return c.json(
        {
          error: `No completed agent run with id ${id}`,
          hint: "run must exist and have status 'completed'",
        },
        404,
      );
    }
    const positions = await loadPositionsForRuns(db, [id]);
    const symbols = [...new Set(positions.map((p) => p.symbol))];
    const bars = await loadBarsForRuns(db, symbols);
    return c.json(buildAgentDetail(run, positions, bars));
  });

export default portfolioApp;
