/**
 * Carryover routes (beads task 800.4, W4).
 *
 *   POST /portfolio/simulations
 *
 * Five reads over the materialized books, all `c.json` and all scoped by
 * `simId`:
 *
 *   GET /portfolio/simulations
 *   GET /portfolio/simulations/:simId/streams
 *   GET /portfolio/simulations/:simId/streams/:personaKey/:window
 *   GET /portfolio/simulations/:simId/streams/:personaKey/:window/rounds
 *   GET /portfolio/simulations/:simId/streams/:personaKey/:window/transactions
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
import type {
  AgentPortfolioState,
  PortfolioEquityDaily,
  PortfolioWindow,
} from "@model_md/database";
import { computeRanking } from "../portfolio/ranking.js";
import type { StreamKey } from "../portfolio/carryoverPlan.js";
import { planChainRebuild, planChainTransactions } from "../portfolio/carryoverPlan.js";
import type { StreamWritePlan } from "../portfolio/carryoverPlan.js";
import { streamAgentKey } from "../portfolio/carryoverStore.js";
import {
  createSimulation,
  isRecord,
  loadBarsBySymbol,
  loadEquityByState,
  loadLotsByState,
  loadPersonaLabels,
  loadSimulation,
  loadSimulationRounds,
  loadSimulations,
  loadStreamHistory,
  loadStreamKeys,
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

/** One buy or sell in a stream's history, newest chain position first. */
export interface StreamTransactionWire {
  roundId: string;
  roundSeq: number;
  decideTradeDate: string;
  symbol: string;
  side: "buy" | "sell";
  /** Absolute delta shares transacted (fractional shares are the norm). */
  shares: number;
  /** The fill close on `decideTradeDate`. */
  price: number;
  /** Trade notional: shares × price. */
  value: number;
  /** sells only; 0 for buys. */
  realizedPnl: number;
  thesis: string | null;
}

/** The transaction log for one stream. */
export interface StreamTransactionsWire {
  simulationId: string;
  personaKey: string;
  window: PortfolioWindow;
  transactions: StreamTransactionWire[];
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

/** One selectable round in a simulation's history. */
export interface SimulationRoundWire {
  roundId: string;
  roundSeq: number;
  asOfTradeDate: string | null;
  status: string;
  runCount: number;
}

/** Every stream's book frozen at one chain position. */
export interface RoundSnapshotWire {
  simulationId: string;
  roundId: string;
  roundSeq: number;
  decideTradeDate: string | null;
  basisCapital: number;
  streams: StreamSummaryWire[];
}

/**
 * Parse a `roundSeq` path param. Chain positions start at 1, so `0` and
 * negatives are rejected rather than clamped.
 */
export function parseRoundSeq(raw: string | undefined): { roundSeq: number } | { error: unknown } {
  const text = raw?.trim() ?? "";
  if (!/^[1-9][0-9]*$/.test(text)) {
    return {
      error: {
        error: `invalid roundSeq ${JSON.stringify(raw ?? "")}`,
        hint: "roundSeq must be a positive integer",
      },
    };
  }
  return { roundSeq: Number(text) };
}

/**
 * Board row for a stream frozen at a past chain position.
 *
 * Ranking reads the replayed curve rather than the live cache, so a snapshot is
 * self-consistent: every metric on the row comes from the same prefix of rounds.
 * A stream that had not folded by `roundSeq` reports the untouched basis rather
 * than a 100% loss — it never held a position, so nothing was lost.
 */
export function toSnapshotStream(
  key: StreamKey,
  plan: StreamWritePlan,
  basisCapital: number,
  labels: ReadonlyMap<string, { persona: string; strategy: string }>,
  decideTradeDate: string,
): StreamSummaryWire {
  const label = labels.get(key.personaKey);
  const shared = {
    simulationId: key.simulationId,
    personaKey: key.personaKey,
    persona: label?.persona ?? null,
    strategy: label?.strategy ?? null,
    window: key.window,
    agentKey: streamAgentKey(key),
    basisCapital,
    lastTradeDate: decideTradeDate,
    asOfTradeDate: decideTradeDate,
    openLots: 0,
  };

  if (plan.state === null) {
    return {
      ...shared,
      seq: 0,
      lastRoundId: null,
      cash: basisCapital,
      holdingsValue: 0,
      totalValue: basisCapital,
      returnPct: 0,
      annualizedVolPct: 0,
      sharpe: 0,
      maxDrawdownPct: 0,
    };
  }

  const series = plan.equity.map((row) => {
    const totalValue = parseNumeric(row.totalValue);
    return {
      tradeDate: row.tradeDate,
      cash: parseNumeric(row.cash),
      holdingsValue: parseNumeric(row.holdingsValue),
      totalValue,
      returnPct: basisCapital === 0 ? 0 : ((totalValue - basisCapital) / basisCapital) * 100,
    };
  });
  const ranking = computeRanking({ equitySeries: series, basisCapital });

  return {
    ...shared,
    seq: plan.summary.seq,
    lastRoundId: null,
    cash: plan.summary.cash,
    holdingsValue: plan.summary.holdingsValue,
    totalValue: plan.summary.totalValue,
    returnPct: ranking.totalReturnPct,
    annualizedVolPct: ranking.annualizedVolPct,
    sharpe: ranking.sharpe,
    maxDrawdownPct: ranking.maxDrawdownPct,
    openLots: plan.lots.filter((lot) => parseNumeric(lot.shares) > 0).length,
  };
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
  return LEADERBOARD_MODES.includes(raw as LeaderboardMode) ? (raw as LeaderboardMode) : "overall";
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

export interface CreateSimulationBody {
  simId: string;
  label: string | null;
  initialCapital: number;
}

/**
 * Validate a `POST /simulations` body. Throws a message suitable for a 400.
 *
 * `initialCapital` defaults to 100000 to match the column default, so the
 * common case is `{"simId": "sim-baseline"}`.
 */
export function parseCreateSimulationBody(value: unknown): CreateSimulationBody {
  if (!isRecord(value)) {
    throw new Error("request body must be a JSON object");
  }
  const rawSimId = value.simId;
  if (typeof rawSimId !== "string" || !SIM_ID_PATTERN.test(rawSimId.trim())) {
    throw new Error("body.simId must match /^sim-[a-z0-9][a-z0-9-]{0,46}$/");
  }
  if (value.label !== undefined && value.label !== null && typeof value.label !== "string") {
    throw new Error("body.label must be a string when present");
  }
  const initialCapital = value.initialCapital ?? 100000;
  if (
    typeof initialCapital !== "number" ||
    !Number.isFinite(initialCapital) ||
    initialCapital <= 0
  ) {
    throw new Error("body.initialCapital must be a positive number");
  }
  const label =
    typeof value.label === "string" && value.label.trim().length > 0 ? value.label.trim() : null;
  return { simId: rawSimId.trim(), label, initialCapital };
}

const portfolioCarryoverApp = new Hono()
  .post("/simulations", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    let body: CreateSimulationBody;
    try {
      body = parseCreateSimulationBody(raw);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    const row = await createSimulation(db, body);
    if (row === undefined) {
      return c.json(
        {
          error: `simulation "${body.simId}" already exists`,
          hint: "A simId is permanent once booked. Reuse the existing simulation or choose a new one.",
        },
        409,
      );
    }

    return c.json(
      {
        simId: row.simId,
        label: row.label,
        initialCapital: parseNumeric(row.initialCapital),
        createdAt: row.createdAt.toISOString(),
        streamCount: 0,
        lastRoundSeq: null,
      } satisfies SimulationWire,
      201,
    );
  })

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
      loadEquityByState(
        db,
        states.map((state) => state.id),
      ),
      loadLotsByState(
        db,
        states.map((state) => state.id),
      ),
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

  .get("/simulations/:simId/streams/:personaKey/:window/transactions", async (c) => {
    const parsed = parseSimId(c.req.param("simId"));
    if ("error" in parsed) return c.json(parsed.error, 400);
    const stream = parseStreamParams(
      parsed.simId,
      c.req.param("personaKey"),
      c.req.param("window"),
    );
    if ("error" in stream) return c.json(stream.error, 400);

    const sim = await loadSimulation(db, parsed.simId);
    if (sim === undefined) {
      return c.json({ error: `unknown simulation ${JSON.stringify(parsed.simId)}` }, 404);
    }

    const history = await loadStreamHistory(db, stream.key);
    if (history.length === 0) {
      return c.json({ ...stream.key, transactions: [] } satisfies StreamTransactionsWire);
    }

    const symbols = new Set<string>();
    for (const round of history) {
      for (const target of round.targets) symbols.add(target.symbol);
    }
    const bars = await loadBarsBySymbol(db, [...symbols]);

    const transactions = planChainTransactions({
      basisCapital: parseNumeric(sim.initialCapital),
      rounds: history.map((row) => ({
        roundId: row.roundId,
        roundSeq: row.roundSeq,
        decideTradeDate: row.decideTradeDate,
        targets: row.targets,
        theses: row.theses,
      })),
      bars,
    });

    return c.json({ ...stream.key, transactions } satisfies StreamTransactionsWire);
  })

  .get("/simulations/:simId/rounds", async (c) => {
    const parsed = parseSimId(c.req.param("simId"));
    if ("error" in parsed) return c.json(parsed.error, 400);
    const rows = await loadSimulationRounds(db, parsed.simId);
    return c.json(
      rows.map(
        (row) =>
          ({
            roundId: row.roundId,
            roundSeq: row.roundSeq,
            asOfTradeDate: row.asOfTradeDate,
            status: row.status,
            runCount: row.runCount,
          }) satisfies SimulationRoundWire,
      ),
    );
  })

  .get("/simulations/:simId/rounds/:roundSeq", async (c) => {
    const parsed = parseSimId(c.req.param("simId"));
    if ("error" in parsed) return c.json(parsed.error, 400);
    const seq = parseRoundSeq(c.req.param("roundSeq"));
    if ("error" in seq) return c.json(seq.error, 400);

    const [sim, rounds] = await Promise.all([
      loadSimulation(db, parsed.simId),
      loadSimulationRounds(db, parsed.simId),
    ]);
    if (sim === undefined) {
      return c.json({ error: `unknown simulation ${JSON.stringify(parsed.simId)}` }, 404);
    }

    const target = rounds.find((row) => row.roundSeq === seq.roundSeq);
    if (target === undefined) {
      return c.json(
        {
          error: `round ${seq.roundSeq} is not part of ${JSON.stringify(parsed.simId)}`,
          hint: `recorded rounds: ${rounds.map((row) => row.roundSeq).join(", ") || "none"}`,
        },
        404,
      );
    }

    const keys = await loadStreamKeys(db, parsed.simId);
    const histories = await Promise.all(keys.map((key) => loadStreamHistory(db, key)));
    const upto = histories.map((rows) => rows.filter((row) => row.roundSeq <= seq.roundSeq));

    const symbols = new Set<string>();
    for (const rows of upto) {
      for (const row of rows) for (const targetRow of row.targets) symbols.add(targetRow.symbol);
    }

    const [bars, labels] = await Promise.all([
      loadBarsBySymbol(db, [...symbols]),
      loadPersonaLabels(db, parsed.simId),
    ]);
    const basisCapital = parseNumeric(sim.initialCapital);
    const decideTradeDate = target.asOfTradeDate ?? "";

    return c.json({
      simulationId: parsed.simId,
      roundId: target.roundId,
      roundSeq: target.roundSeq,
      decideTradeDate: target.asOfTradeDate,
      basisCapital,
      streams: keys.map((key, index) =>
        toSnapshotStream(key, planChainRebuild({ key, basisCapital, rounds: upto[index] ?? [], bars }), basisCapital, labels, decideTradeDate),
      ),
    } satisfies RoundSnapshotWire);
  })

  .get("/simulations/:simId/leaderboard", async (c) => {
    const parsed = parseSimId(c.req.param("simId"));
    if ("error" in parsed) return c.json(parsed.error, 400);
    const mode = parseLeaderboardMode(c.req.query("mode"));

    const states = await loadStreamStates(db, parsed.simId);
    const [equity, labels] = await Promise.all([
      loadEquityByState(
        db,
        states.map((state) => state.id),
      ),
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
