/**
 * Carryover read routes (beads task 800.4, W4).
 *
 * Five reads over the materialized books, all `c.json` and all scoped by
 * `simId`:
 *
 *   GET /portfolio/simulations
 *   GET /portfolio/simulations/:simId/streams
 *   GET /portfolio/simulations/:simId/streams/:personaKey/:window
 *   GET /portfolio/simulations/:simId/streams/:personaKey/:window/rounds
 *   GET /portfolio/simulations/:simId/leaderboard?mode=overall|by-window|by-persona
 *
 * These read the CACHE, never a re-fold: `agent_portfolio_state` +
 * `portfolio_equity_daily` are written by the fold in the run-insert
 * transaction, so a read here is a snapshot of the last committed fold rather
 * than a second derivation that could disagree with it. Ranking math is the
 * one exception — it is pure and cheap, so the board is ranked on read from the
 * cached curve with the chain basis INJECTED (see `computeRanking`), which is
 * what keeps compounding P&L from reading as flat.
 *
 * Wire convention, matching `routes/portfolio.ts`: computed portfolio values
 * are JSON numbers; only DB numeric strings are parsed, and only here at the
 * edge.
 */

import { Hono } from "hono";
import { db } from "@model_md/database";
import type { AgentPortfolioState, PortfolioEquityDaily, PortfolioWindow } from "@model_md/database";
import { computeRanking } from "../portfolio/ranking.js";
import type { StreamKey } from "../portfolio/carryoverPlan.js";
import { streamAgentKey } from "../portfolio/carryoverStore.js";
import {
  loadEquityByState,
  loadLotsByState,
  loadPersonaLabels,
  loadSimulations,
  loadStreamHistory,
  loadStreamLots,
  loadStreamState,
  loadStreamStates,
} from "../portfolio/carryoverStore.js";
import type { PortfolioPositionLotRow } from "../portfolio/carryoverStore.js";
import { parseNumeric } from "../portfolio/types.js";
import type { EquityPoint } from "../portfolio/types.js";

const WINDOWS: readonly PortfolioWindow[] = ["daily", "weekly", "monthly"];
const LEADERBOARD_MODES = ["overall", "by-window", "by-persona"] as const;
type LeaderboardMode = (typeof LEADERBOARD_MODES)[number];

/** One simulation in the handle list. */
export interface SimulationWire {
  simId: string;
  label: string | null;
  initialCapital: number;
  createdAt: string;
  /** Streams that have materialized a book; 0 means nothing has folded yet. */
  streamCount: number;
  /** Highest chain position in force, or `null` before the first round. */
  lastRoundSeq: number | null;
}

/** One stream's board position. */
export interface StreamSummaryWire {
  simulationId: string;
  personaKey: string;
  persona: string | null;
  strategy: string | null;
  window: PortfolioWindow;
  agentKey: string;
  seq: number;
  lastRoundId: string | null;
  lastTradeDate: string;
  basisCapital: number;
  cash: number;
  holdingsValue: number;
  totalValue: number;
  returnPct: number;
  annualizedVolPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  asOfTradeDate: string;
  openLots: number;
}

/** One open lot of a stream. */
export interface LotWire {
  symbol: string;
  shares: number;
  costBasis: number;
  targetWeight: number;
  openedFromRoundId: string;
  openedTradeDate: string;
  realizedPnl: number;
  thesis: string | null;
}

/** One point of a materialized chain curve. */
export interface ChainEquityPointWire {
  tradeDate: string;
  cash: number;
  holdingsValue: number;
  totalValue: number;
  returnPct: number;
  roundSeq: number | null;
}

/** The stream drilldown: board row + open lots + the full chain curve. */
export interface StreamDetailWire {
  stream: StreamSummaryWire;
  lots: LotWire[];
  equitySeries: ChainEquityPointWire[];
}

/** One decision a stream made, newest chain position first. */
export interface StreamRoundWire {
  roundId: string;
  roundSeq: number;
  decideTradeDate: string;
  targets: { symbol: string; targetWeight: number }[];
  theses: { symbol: string; thesis: string }[];
}

/** The leaderboard: one `rows` list per group, ranked by return within a group. */
export interface LeaderboardGroupWire {
  key: string;
  label: string;
  rows: StreamSummaryWire[];
}

export interface LeaderboardWire {
  simulationId: string;
  mode: LeaderboardMode;
  basisCapital: number;
  groups: LeaderboardGroupWire[];
}

const SIM_ID_PATTERN = /^sim-[a-z0-9][a-z0-9-]{0,46}$/;

/** Parse a `simId` path param, or return the 400 body to hand back. */
export function parseSimId(raw: string | undefined): { simId: string } | { error: unknown } {
  const simId = raw?.trim() ?? "";
  if (!SIM_ID_PATTERN.test(simId)) {
    return {
      error: {
        error: `invalid simId ${JSON.stringify(raw ?? "")}`,
        hint: "simId must match /^sim-[a-z0-9][a-z0-9-]{0,46}$/",
      },
    };
  }
  return { simId };
}

/** Parse a `:personaKey` + `:window` path pair into a stream key. */
export function parseStreamParams(
  simulationId: string,
  rawPersonaKey: string | undefined,
  rawWindow: string | undefined,
): { key: StreamKey } | { error: unknown } {
  const personaKey = rawPersonaKey?.trim() ?? "";
  if (personaKey.length === 0) {
    return { error: { error: "personaKey path param is required" } };
  }
  const window = rawWindow?.trim() ?? "";
  if (!WINDOWS.includes(window as PortfolioWindow)) {
    return {
      error: {
        error: `invalid window ${JSON.stringify(rawWindow ?? "")}`,
        hint: `window must be one of ${WINDOWS.join(", ")}`,
      },
    };
  }
  return { key: { simulationId, personaKey, window: window as PortfolioWindow } };
}

/** Parse the leaderboard `mode` query param; absent means `overall`. */
export function parseLeaderboardMode(raw: string | undefined): LeaderboardMode {
  return LEADERBOARD_MODES.includes(raw as LeaderboardMode)
    ? (raw as LeaderboardMode)
    : "overall";
}

/** Cached curve rows → engine points, with return measured against the chain basis. */
export function toChainEquityPoints(
  rows: readonly PortfolioEquityDaily[],
  basisCapital: number,
): EquityPoint[] {
  return rows.map((row) => {
    const totalValue = parseNumeric(row.totalValue);
    return {
      tradeDate: row.tradeDate,
      cash: parseNumeric(row.cash),
      holdingsValue: parseNumeric(row.holdingsValue),
      totalValue,
      returnPct: basisCapital === 0 ? 0 : ((totalValue - basisCapital) / basisCapital) * 100,
    };
  });
}

export function toLotWire(lot: PortfolioPositionLotRow): LotWire {
  return {
    symbol: lot.symbol,
    shares: parseNumeric(lot.shares),
    costBasis: parseNumeric(lot.costBasis),
    targetWeight: parseNumeric(lot.targetWeight),
    openedFromRoundId: lot.openedFromRoundId,
    openedTradeDate: lot.openedTradeDate,
    realizedPnl: parseNumeric(lot.realizedPnl),
    thesis: lot.thesis,
  };
}

/**
 * Board row for one stream, ranked from its cached curve.
 *
 * A stream with no cached points still gets a row (ranked flat at 0) rather than
 * vanishing: "decided nothing yet" is a fact the board should show, and a
 * missing row would read as "not in this simulation".
 */
export function toStreamSummary(
  state: AgentPortfolioState,
  equity: readonly PortfolioEquityDaily[],
  labels: ReadonlyMap<string, { persona: string; strategy: string }>,
): StreamSummaryWire {
  const basisCapital = parseNumeric(state.initialCapital);
  const label = labels.get(state.personaKey);
  const series = toChainEquityPoints(equity, basisCapital);
  const ranking = computeRanking({ equitySeries: series, basisCapital });
  const lastPoint = series[series.length - 1];
  return {
    simulationId: state.simulationId,
    personaKey: state.personaKey,
    persona: label?.persona ?? null,
    strategy: label?.strategy ?? null,
    window: state.window,
    agentKey: streamAgentKey({ personaKey: state.personaKey, window: state.window }),
    seq: state.seq,
    lastRoundId: state.lastRoundId,
    lastTradeDate: state.lastTradeDate,
    basisCapital,
    cash: parseNumeric(state.cash),
    holdingsValue: parseNumeric(state.holdingsValue),
    totalValue: lastPoint?.totalValue ?? parseNumeric(state.totalValue),
    returnPct: ranking.totalReturnPct,
    annualizedVolPct: ranking.annualizedVolPct,
    sharpe: ranking.sharpe,
    maxDrawdownPct: ranking.maxDrawdownPct,
    asOfTradeDate: ranking.asOfTradeDate === "" ? state.lastTradeDate : ranking.asOfTradeDate,
    openLots: 0,
  };
}

/** Group and rank rows for the requested leaderboard mode. */
export function buildLeaderboardGroups(
  rows: readonly StreamSummaryWire[],
  mode: LeaderboardMode,
): LeaderboardGroupWire[] {
  const byReturn = (a: StreamSummaryWire, b: StreamSummaryWire): number =>
    b.returnPct - a.returnPct || a.personaKey.localeCompare(b.personaKey);

  if (mode === "overall") {
    return [{ key: "overall", label: "All streams", rows: [...rows].sort(byReturn) }];
  }

  const groups = new Map<string, StreamSummaryWire[]>();
  for (const row of rows) {
    const key = mode === "by-window" ? row.window : row.personaKey;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => ({
      key,
      label: mode === "by-window" ? key : (list[0]?.persona ?? key),
      rows: list.sort(byReturn),
    }));
}

const portfolioCarryoverApp = new Hono()
  .get("/simulations", async (c) => {
    const rows = await loadSimulations(db);
    const summaries = await Promise.all(
      rows.map(async (sim) => {
        const states = await loadStreamStates(db, sim.simId);
        return {
          simId: sim.simId,
          label: sim.label,
          initialCapital: parseNumeric(sim.initialCapital),
          createdAt: sim.createdAt.toISOString(),
          streamCount: states.length,
          lastRoundSeq: states.reduce<number | null>(
            (max, state) => (max === null || state.seq > max ? state.seq : max),
            null,
          ),
        } satisfies SimulationWire;
      }),
    );
    return c.json(summaries);
  })

  .get("/simulations/:simId/streams", async (c) => {
    const parsed = parseSimId(c.req.param("simId"));
    if ("error" in parsed) return c.json(parsed.error, 400);
    const states = await loadStreamStates(db, parsed.simId);
    const [equity, lots, labels] = await Promise.all([
      loadEquityByState(db, states.map((state) => state.id)),
      loadLotsByState(db, states.map((state) => state.id)),
      loadPersonaLabels(db, parsed.simId),
    ]);
    return c.json(
      states.map((state) => {
        const summary = toStreamSummary(state, equity.get(state.id) ?? [], labels);
        return {
          ...summary,
          openLots: (lots.get(state.id) ?? []).filter((lot) => parseNumeric(lot.shares) > 0).length,
        };
      }),
    );
  })

  .get("/simulations/:simId/streams/:personaKey/:window", async (c) => {
    const parsed = parseSimId(c.req.param("simId"));
    if ("error" in parsed) return c.json(parsed.error, 400);
    const stream = parseStreamParams(
      parsed.simId,
      c.req.param("personaKey"),
      c.req.param("window"),
    );
    if ("error" in stream) return c.json(stream.error, 400);

    const state = await loadStreamState(db, stream.key);
    if (state === undefined) {
      return c.json(
        {
          error: `no materialized book for stream ${stream.key.personaKey}--${stream.key.window} in ${parsed.simId}`,
          hint: "A stream appears here once its first round has been folded.",
        },
        404,
      );
    }
    const [equity, lots, labels] = await Promise.all([
      loadEquityByState(db, [state.id]),
      loadStreamLots(db, state.id),
      loadPersonaLabels(db, parsed.simId),
    ]);
    const basisCapital = parseNumeric(state.initialCapital);
    const detail: StreamDetailWire = {
      stream: {
        ...toStreamSummary(state, equity.get(state.id) ?? [], labels),
        openLots: lots.filter((lot) => parseNumeric(lot.shares) > 0).length,
      },
      lots: lots.map(toLotWire),
      equitySeries: (equity.get(state.id) ?? []).map((row) => ({
        tradeDate: row.tradeDate,
        cash: parseNumeric(row.cash),
        holdingsValue: parseNumeric(row.holdingsValue),
        totalValue: parseNumeric(row.totalValue),
        returnPct:
          basisCapital === 0
            ? 0
            : ((parseNumeric(row.totalValue) - basisCapital) / basisCapital) * 100,
        roundSeq: row.roundSeq,
      })),
    };
    return c.json(detail);
  })

  .get("/simulations/:simId/streams/:personaKey/:window/rounds", async (c) => {
    const parsed = parseSimId(c.req.param("simId"));
    if ("error" in parsed) return c.json(parsed.error, 400);
    const stream = parseStreamParams(
      parsed.simId,
      c.req.param("personaKey"),
      c.req.param("window"),
    );
    if ("error" in stream) return c.json(stream.error, 400);

    const history = await loadStreamHistory(db, stream.key);
    // Newest chain position first: the next decision reads the most recent
    // round, so leading with it makes the "what did I just do" question a
    // glance rather than a scroll.
    const rounds: StreamRoundWire[] = [...history]
      .sort((a, b) => b.roundSeq - a.roundSeq)
      .map((round) => ({
        roundId: round.roundId,
        roundSeq: round.roundSeq,
        decideTradeDate: round.decideTradeDate,
        targets: round.targets.map((target) => ({
          symbol: target.symbol,
          targetWeight: target.targetWeight,
        })),
        theses: [...round.theses.entries()].map(([symbol, thesis]) => ({ symbol, thesis })),
      }));
    return c.json({ ...stream.key, rounds });
  })

  .get("/simulations/:simId/leaderboard", async (c) => {
    const parsed = parseSimId(c.req.param("simId"));
    if ("error" in parsed) return c.json(parsed.error, 400);
    const mode = parseLeaderboardMode(c.req.query("mode"));

    const states = await loadStreamStates(db, parsed.simId);
    const [equity, labels] = await Promise.all([
      loadEquityByState(db, states.map((state) => state.id)),
      loadPersonaLabels(db, parsed.simId),
    ]);
    const rows = states.map((state) => toStreamSummary(state, equity.get(state.id) ?? [], labels));
    const basisCapital = rows[0]?.basisCapital ?? 0;
    return c.json({
      simulationId: parsed.simId,
      mode,
      basisCapital,
      groups: buildLeaderboardGroups(rows, mode),
    } satisfies LeaderboardWire);
  });

export default portfolioCarryoverApp;
