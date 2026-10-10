/**
 * Carryover persistence — the DB-facing half (beads task 800.4, W4).
 *
 * Owns every write to `agent_portfolio_state` / `portfolio_position_lots` /
 * `portfolio_equity_daily`, and the loads that feed the pure planners in
 * `carryoverPlan.ts`. Two rules are load-bearing:
 *
 * 1. **The fold is the single writer.** `agent_runs.simulation_id` /
 *    `round_seq` and the materialized state are written in ONE transaction by
 *    `insertRunAndFold`. A run whose state did not advance would deadlock any
 *    retry behind `DuplicateRunError`, which is exactly the failure R5 exists to
 *    prevent — hence all-or-nothing, no half-states.
 * 2. **The cache is disposable.** Nothing here is a ledger: `rebuildStream`
 *    recomputes a stream from its round history, so a `replace`, a delete and a
 *    cold rebuild are the same code path and cannot drift from the fold.
 *
 * `agent_runs.round_id` intentionally has NO foreign key to `round_jobs` (R6):
 * pre-carryover rows would break, and the denormalized `simulationId`/`roundSeq`
 * pair is the invariant instead — they always equal the owning job's values.
 */

import { and, asc, eq, gt, inArray, lte, max, notInArray, sql } from "drizzle-orm";
import {
  agentPortfolioState,
  agentRuns,
  dailyPrices,
  instruments,
  portfolioEquityDaily,
  portfolioPositionLots,
  portfolioPositions,
  roundAgentProgress,
  roundJobs,
  simulations,
} from "@model_md/database";
import type {
  AgentPortfolioState,
  PortfolioEquityDaily,
  PortfolioWindow,
  RoundAgentStatus,
} from "@model_md/database";
import type { DbClient } from "@model_md/market-data";
import { isDecisionDue } from "./carryover.js";
import type { DecisionTarget } from "./carryover.js";
import {
  planChainRebuild,
  planRoundFold,
  toLotSnapshots,
  toStateSnapshot,
} from "./carryoverPlan.js";
import type { ChainRoundInput, StreamKey, StreamWritePlan } from "./carryoverPlan.js";
import type { ExistingRound } from "./rerunPolicy.js";
import type { BarsBySymbol, EngineBar } from "./valuation.js";

/** The drizzle transaction handle a fold may be composed into. */
export type PortfolioTx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** A reader/writer: the live client and a transaction expose the same surface. */
export type Queryable = Pick<PortfolioTx, "select" | "insert" | "update" | "delete">;

/** `agentKey` for a stream: the persona key and the window joined by `--`. */
export function streamAgentKey(key: Pick<StreamKey, "personaKey" | "window">): string {
  return `${key.personaKey}--${key.window}`;
}

/** A round's decision history, as stored on `agent_runs.decision_json`. */
export interface StreamRoundRow {
  roundId: string;
  roundSeq: number;
  decideTradeDate: string;
  targets: DecisionTarget[];
  theses: Map<string, string>;
}

/* ------------------------------------------------------------------ *
 * loads
 * ------------------------------------------------------------------ */

/**
 * One stream's decision history in chain order.
 *
 * `agent_runs.round_seq` is denormalized (R6) so this needs no join; the
 * decide date comes from `round_jobs`, which is authoritative for the round.
 * A run whose round has no `as_of_trade_date` cannot be marked, so it is
 * skipped rather than folded at a guessed date.
 */
export async function loadStreamHistory(
  client: Queryable,
  key: StreamKey,
): Promise<StreamRoundRow[]> {
  const runs = await client
    .select({
      roundId: agentRuns.roundId,
      roundSeq: agentRuns.roundSeq,
      decisionJson: agentRuns.decisionJson,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.simulationId, key.simulationId),
        eq(agentRuns.agentKey, streamAgentKey(key)),
      ),
    )
    .orderBy(asc(agentRuns.roundSeq));

  if (runs.length === 0) return [];
  const roundIds = runs.map((run) => run.roundId);
  const jobs = await client
    .select({
      roundId: roundJobs.roundId,
      asOfTradeDate: roundJobs.asOfTradeDate,
      seq: roundJobs.roundSeq,
    })
    .from(roundJobs)
    .where(inArray(roundJobs.roundId, roundIds));
  const jobByRound = new Map(jobs.map((job) => [job.roundId, job]));

  const rows: StreamRoundRow[] = [];
  for (const run of runs) {
    const job = jobByRound.get(run.roundId);
    if (job?.asOfTradeDate == null) continue;
    rows.push({
      roundId: run.roundId,
      roundSeq: run.roundSeq,
      decideTradeDate: job.asOfTradeDate,
      targets: parseEnvelopeTargets(run.decisionJson),
      theses: parseEnvelopeTheses(run.decisionJson),
    });
  }
  return rows;
}

/** The cached state row for a stream, or `null` on its first round. */
export async function loadStreamState(
  client: Queryable,
  key: StreamKey,
): Promise<AgentPortfolioState | undefined> {
  const [row] = await client
    .select()
    .from(agentPortfolioState)
    .where(
      and(
        eq(agentPortfolioState.simulationId, key.simulationId),
        eq(agentPortfolioState.personaKey, key.personaKey),
        eq(agentPortfolioState.window, key.window),
      ),
    )
    .limit(1);
  return row;
}

/** The cached open lots for a stream, symbol-ascending. */
export async function loadStreamLots(
  client: Queryable,
  stateId: number,
): Promise<PortfolioPositionLotRow[]> {
  return client
    .select({
      symbol: portfolioPositionLots.symbol,
      shares: portfolioPositionLots.shares,
      costBasis: portfolioPositionLots.costBasis,
      targetWeight: portfolioPositionLots.targetWeight,
      openedFromRoundId: portfolioPositionLots.openedFromRoundId,
      openedTradeDate: portfolioPositionLots.openedTradeDate,
      realizedPnl: portfolioPositionLots.realizedPnl,
      thesis: portfolioPositionLots.thesis,
    })
    .from(portfolioPositionLots)
    .where(eq(portfolioPositionLots.stateId, stateId))
    .orderBy(asc(portfolioPositionLots.symbol));
}

export interface PortfolioPositionLotRow {
  stateId?: number;
  symbol: string;
  shares: string;
  costBasis: string;
  targetWeight: string;
  openedFromRoundId: string;
  openedTradeDate: string;
  realizedPnl: string;
  thesis: string | null;
}

/**
 * Symbols a stream currently holds — the `heldSymbols` set envelope v2 requires
 * and the run-insert route validates omissions against.
 */
export async function loadHeldSymbols(client: Queryable, key: StreamKey): Promise<Set<string>> {
  const state = await loadStreamState(client, key);
  if (state === undefined) return new Set();
  const lots = await loadStreamLots(client, state.id);
  return new Set(lots.filter((lot) => Number.parseFloat(lot.shares) > 0).map((lot) => lot.symbol));
}

/** Daily bars per symbol, oldest first, for the given symbols. */
export async function loadBarsBySymbol(
  client: Queryable,
  symbols: readonly string[],
): Promise<BarsBySymbol> {
  const map = new Map<string, EngineBar[]>();
  if (symbols.length === 0) return map;
  const rows = await client
    .select({
      symbol: instruments.symbol,
      tradeDate: dailyPrices.tradeDate,
      close: dailyPrices.close,
    })
    .from(dailyPrices)
    .innerJoin(instruments, eq(dailyPrices.instrumentId, instruments.id))
    .where(inArray(instruments.symbol, [...symbols]))
    .orderBy(asc(dailyPrices.tradeDate));

  for (const row of rows) {
    if (row.close === null) continue;
    const close = Number.parseFloat(row.close);
    if (!Number.isFinite(close)) continue;
    const bars = map.get(row.symbol) ?? [];
    bars.push({ tradeDate: row.tradeDate, close });
    map.set(row.symbol, bars);
  }
  return map;
}

/** `MAX(daily_prices.trade_date)` — the newest close a round can be built from. */
export async function loadLatestTradeDate(client: Queryable): Promise<string | null> {
  const [row] = await client.select({ tradeDate: max(dailyPrices.tradeDate) }).from(dailyPrices);
  return row?.tradeDate ?? null;
}

/** Distinct trading dates in `(after, through]`, ascending. */
export async function loadTradingDatesBetween(
  client: Queryable,
  after: string,
  through: string,
): Promise<string[]> {
  if (through <= after) return [];
  const rows = await client
    .select({ tradeDate: dailyPrices.tradeDate })
    .from(dailyPrices)
    .where(and(gt(dailyPrices.tradeDate, after), lte(dailyPrices.tradeDate, through)))
    .orderBy(asc(dailyPrices.tradeDate));
  return [...new Set(rows.map((row) => row.tradeDate))];
}

/** One stream of a prospective roster: the identity the cadence gate needs. */
export interface RosterStream {
  agentKey: string;
  personaKey: string;
  window: PortfolioWindow;
}

/** The decision-due state of one roster stream at a round's `asOfTradeDate`. */
export interface StreamDue extends RosterStream {
  /** The stream's last decision date, or null on its first round. */
  lastTradeDate: string | null;
  /** Trading days elapsed since that decision; null on the first round. */
  tradingDaysSinceLastDecision: number | null;
  due: boolean;
}

/**
 * Resolve which roster streams are due to decide at `asOfTradeDate`.
 *
 * The count is trading days from the price calendar — the same calendar the fold
 * marks against — so holidays and weekends never advance it. The calendar is
 * loaded ONCE for the whole roster (from the earliest last decision) and counted
 * per stream, rather than one query per stream. A stream with no state is due:
 * its first round always opens a book (`isDecisionDue`).
 */
export async function computeRosterDue(
  client: Queryable,
  simulationId: string,
  asOfTradeDate: string,
  roster: readonly RosterStream[],
): Promise<StreamDue[]> {
  if (roster.length === 0) return [];
  const states = await loadStreamStates(client, simulationId);
  const lastByKey = new Map(states.map((state) => [streamAgentKey(state), state.lastTradeDate]));
  const lastDates = roster.map((entry) => lastByKey.get(entry.agentKey) ?? null);
  const known = lastDates.filter((value): value is string => value !== null);
  const earliest = known.reduce<string | null>(
    (min, value) => (min === null || value < min ? value : min),
    null,
  );
  const calendar =
    earliest === null ? [] : await loadTradingDatesBetween(client, earliest, asOfTradeDate);
  return roster.map((entry, index) => {
    const lastTradeDate = lastDates[index];
    const tradingDaysSinceLastDecision =
      lastTradeDate === null ? null : calendar.filter((date) => date > lastTradeDate).length;
    return {
      ...entry,
      lastTradeDate,
      tradingDaysSinceLastDecision,
      due: isDecisionDue({ window: entry.window, tradingDaysSinceLastDecision }),
    };
  });
}

/** One agent's orchestration status in a round, or undefined when it has no row. */
export async function loadAgentProgressStatus(
  client: Queryable,
  roundId: string,
  agentKey: string,
): Promise<RoundAgentStatus | undefined> {
  const [row] = await client
    .select({ status: roundAgentProgress.status })
    .from(roundAgentProgress)
    .where(and(eq(roundAgentProgress.roundId, roundId), eq(roundAgentProgress.agentKey, agentKey)))
    .limit(1);
  return row?.status;
}

/** The simulation row, or `undefined` when the simId is unknown. */
export async function loadSimulation(client: Queryable, simulationId: string) {
  const [row] = await client
    .select()
    .from(simulations)
    .where(eq(simulations.simId, simulationId))
    .limit(1);
  return row;
}

/**
 * Rounds already recorded for a (simulation, asOfTradeDate) pair, oldest first —
 * the input `decideRerun` needs to tell an in-flight round from a finished one.
 *
 * A round with no `as_of_trade_date` is excluded: it has no date to collide on,
 * so it neither blocks a launch nor can be replaced by one.
 */
export async function loadRoundsForTradeDate(
  client: Queryable,
  simulationId: string,
  asOfTradeDate: string,
): Promise<ExistingRound[]> {
  const rows = await client
    .select({
      roundId: roundJobs.roundId,
      status: roundJobs.status,
      roundSeq: roundJobs.roundSeq,
    })
    .from(roundJobs)
    .where(
      and(eq(roundJobs.simulationId, simulationId), eq(roundJobs.asOfTradeDate, asOfTradeDate)),
    )
    .orderBy(asc(roundJobs.roundSeq));
  return rows;
}

/**
 * `last_trade_date` of every stream in a simulation that already has state.
 *
 * Streams with no state are first-round streams: they place no constraint on
 * the chain, which is why they are absent here rather than reported as `null`.
 */
export async function loadStreamLastTradeDates(
  client: Queryable,
  simulationId: string,
): Promise<string[]> {
  const rows = await client
    .select({ lastTradeDate: agentPortfolioState.lastTradeDate })
    .from(agentPortfolioState)
    .where(eq(agentPortfolioState.simulationId, simulationId));
  return rows.map((row) => row.lastTradeDate);
}

/** One recorded round of a simulation, with how many runs it produced. */
export interface SimulationRoundRow {
  roundId: string;
  roundSeq: number;
  /** `null` when the round was booked but never reached a dataset date. */
  asOfTradeDate: string | null;
  status: string;
  /** Runs recorded in this round; `0` for a launch that inserted nothing. */
  runCount: number;
}

/**
 * A simulation's rounds in chain order — the list a round selector is built from.
 *
 * Ordered by `round_seq`, which is unique per simulation and therefore a total
 * order; `created_at` would rank by whichever agent finished last. `as_of_trade_date`
 * is left nullable rather than filtered out so a booked-but-undated round still
 * appears in the history instead of silently vanishing from the dropdown.
 */
export async function loadSimulationRounds(
  client: Queryable,
  simulationId: string,
): Promise<SimulationRoundRow[]> {
  const jobs = await client
    .select({
      roundId: roundJobs.roundId,
      roundSeq: roundJobs.roundSeq,
      asOfTradeDate: roundJobs.asOfTradeDate,
      status: roundJobs.status,
    })
    .from(roundJobs)
    .where(eq(roundJobs.simulationId, simulationId))
    .orderBy(asc(roundJobs.roundSeq));

  if (jobs.length === 0) return [];

  const counts = await client
    .select({
      roundId: agentRuns.roundId,
      runCount: sql<number>`cast(count(*) as int)`,
    })
    .from(agentRuns)
    .where(eq(agentRuns.simulationId, simulationId))
    .groupBy(agentRuns.roundId);
  const countByRound = new Map(counts.map((row) => [row.roundId, Number(row.runCount)]));

  return jobs.map((job) => ({
    roundId: job.roundId,
    roundSeq: job.roundSeq,
    asOfTradeDate: job.asOfTradeDate ?? null,
    status: job.status,
    runCount: countByRound.get(job.roundId) ?? 0,
  }));
}

/** Every `personaKey`/`window` pair that has materialized state in a simulation. */
export async function loadStreamKeys(
  client: Queryable,
  simulationId: string,
): Promise<StreamKey[]> {
  const rows = await client
    .select({ personaKey: agentPortfolioState.personaKey, window: agentPortfolioState.window })
    .from(agentPortfolioState)
    .where(eq(agentPortfolioState.simulationId, simulationId))
    .orderBy(asc(agentPortfolioState.personaKey), asc(agentPortfolioState.window));
  return rows.map((row) => ({ simulationId, personaKey: row.personaKey, window: row.window }));
}

/** The next chain position for a simulation: one past the highest recorded. */
export async function loadNextRoundSeq(client: Queryable, simulationId: string): Promise<number> {
  const [row] = await client
    .select({ seq: max(roundJobs.roundSeq) })
    .from(roundJobs)
    .where(eq(roundJobs.simulationId, simulationId));
  return (row?.seq ?? 0) + 1;
}

/** Every simulation, oldest first, so the handle list is stable across calls. */
export async function loadSimulations(client: Queryable) {
  return client
    .select()
    .from(simulations)
    .orderBy(asc(simulations.createdAt), asc(simulations.simId));
}

/**
 * Create one simulation — the scope every chained round hangs off.
 *
 * `initialCapital` is the CHAIN BASIS, not a per-round budget: it seeds
 * `agent_portfolio_state.initial_capital` and is the denominator of every
 * round's `returnPct`, so it is fixed for the life of the chain.
 *
 * Returns `undefined` when `simId` is already taken, so the route can answer
 * 409 rather than let `onConflictDoNothing` swallow the collision as a silent
 * success on a handle the caller does not own.
 */
export async function createSimulation(
  client: Queryable,
  input: { simId: string; label: string | null; initialCapital: number },
) {
  const [row] = await client
    .insert(simulations)
    .values({
      simId: input.simId,
      label: input.label,
      initialCapital: input.initialCapital.toFixed(2),
    })
    .onConflictDoNothing({ target: simulations.simId })
    .returning();
  return row;
}

/** One materialized book per stream in a simulation, in (persona, window) order. */
export async function loadStreamStates(
  client: Queryable,
  simulationId: string,
): Promise<AgentPortfolioState[]> {
  return client
    .select()
    .from(agentPortfolioState)
    .where(eq(agentPortfolioState.simulationId, simulationId))
    .orderBy(asc(agentPortfolioState.personaKey), asc(agentPortfolioState.window));
}

/** Materialized equity curves for many streams at once, keyed by `stateId`. */
export async function loadEquityByState(
  client: Queryable,
  stateIds: readonly number[],
): Promise<Map<number, PortfolioEquityDaily[]>> {
  const byState = new Map<number, PortfolioEquityDaily[]>();
  if (stateIds.length === 0) return byState;
  const rows = await client
    .select()
    .from(portfolioEquityDaily)
    .where(inArray(portfolioEquityDaily.stateId, [...stateIds]))
    .orderBy(asc(portfolioEquityDaily.stateId), asc(portfolioEquityDaily.tradeDate));
  for (const row of rows) {
    const list = byState.get(row.stateId) ?? [];
    list.push(row);
    byState.set(row.stateId, list);
  }
  return byState;
}

/** Open lots for many streams at once, keyed by `stateId`. */
export async function loadLotsByState(
  client: Queryable,
  stateIds: readonly number[],
): Promise<Map<number, PortfolioPositionLotRow[]>> {
  const byState = new Map<number, PortfolioPositionLotRow[]>();
  if (stateIds.length === 0) return byState;
  const rows = await client
    .select({
      stateId: portfolioPositionLots.stateId,
      symbol: portfolioPositionLots.symbol,
      shares: portfolioPositionLots.shares,
      costBasis: portfolioPositionLots.costBasis,
      targetWeight: portfolioPositionLots.targetWeight,
      openedFromRoundId: portfolioPositionLots.openedFromRoundId,
      openedTradeDate: portfolioPositionLots.openedTradeDate,
      realizedPnl: portfolioPositionLots.realizedPnl,
      thesis: portfolioPositionLots.thesis,
    })
    .from(portfolioPositionLots)
    .where(inArray(portfolioPositionLots.stateId, [...stateIds]))
    .orderBy(asc(portfolioPositionLots.stateId), asc(portfolioPositionLots.symbol));
  for (const row of rows) {
    const list = byState.get(row.stateId) ?? [];
    list.push(row);
    byState.set(row.stateId, list);
  }
  return byState;
}

/**
 * Display name + strategy per `personaKey`.
 *
 * Both fields are per-persona constants rather than per-run values, so any run
 * of the persona carries the same pair; the rows are ordered by persona name so
 * the choice is deterministic instead of depending on scan order. A persona
 * that has never decided has no row, so callers must treat the label as optional
 * rather than inventing one from the key.
 */
export async function loadPersonaLabels(
  client: Queryable,
  simulationId: string,
): Promise<Map<string, { persona: string; strategy: string }>> {
  const rows = await client
    .select({
      agentKey: agentRuns.agentKey,
      persona: agentRuns.persona,
      strategy: agentRuns.strategy,
    })
    .from(agentRuns)
    .where(eq(agentRuns.simulationId, simulationId))
    .orderBy(asc(agentRuns.persona));
  const labels = new Map<string, { persona: string; strategy: string }>();
  for (const row of rows) {
    const personaKey = personaKeyOf(row.agentKey);
    if (!labels.has(personaKey)) {
      labels.set(personaKey, { persona: row.persona, strategy: row.strategy });
    }
  }
  return labels;
}

/* ------------------------------------------------------------------ *
 * writes
 * ------------------------------------------------------------------ */

export interface AppliedPlan {
  stateId: number;
  summary: StreamWritePlan["summary"];
}

/**
 * Write one plan out. `reset` first drops the stream's lots and equity rows,
 * which is what a full rebuild wants (the fold recomputed every row) and what an
 * incremental fold does NOT (it upserts only the rows it changed).
 */
export async function applyStreamPlan(
  client: Queryable,
  plan: StreamWritePlan,
  options: { reset: boolean },
): Promise<AppliedPlan | null> {
  if (plan.state === null) return null;
  const state = plan.state;

  if (options.reset) {
    const [current] = await client
      .select({ id: agentPortfolioState.id })
      .from(agentPortfolioState)
      .where(
        and(
          eq(agentPortfolioState.simulationId, state.simulationId),
          eq(agentPortfolioState.personaKey, state.personaKey),
          eq(agentPortfolioState.window, state.window),
        ),
      )
      .limit(1);
    if (current !== undefined) {
      await client
        .delete(portfolioPositionLots)
        .where(eq(portfolioPositionLots.stateId, current.id));
      await client.delete(portfolioEquityDaily).where(eq(portfolioEquityDaily.stateId, current.id));
    }
  }

  const [upserted] = await client
    .insert(agentPortfolioState)
    .values({ ...state, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [
        agentPortfolioState.simulationId,
        agentPortfolioState.personaKey,
        agentPortfolioState.window,
      ],
      set: { ...state, updatedAt: new Date() },
    })
    .returning({ id: agentPortfolioState.id });
  const stateId = upserted?.id;
  if (stateId === undefined) throw new Error("upsert of agent_portfolio_state returned no row");

  for (const lot of plan.lots) {
    await client
      .insert(portfolioPositionLots)
      .values({ stateId, ...lot, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [portfolioPositionLots.stateId, portfolioPositionLots.symbol],
        set: { ...lot, updatedAt: new Date() },
      });
  }
  if (!options.reset) {
    const symbols = plan.lots.map((lot) => lot.symbol);
    // A full liquidation yields zero lots, so the symbol list can legitimately be
    // empty — that is the case that must clear the table, not skip the cleanup.
    // Leaving the sold lots behind would make the next fold's `bookFromLots`
    // re-open positions the stream already sold.
    const scope = eq(portfolioPositionLots.stateId, stateId);
    const stale =
      symbols.length === 0 ? scope : and(scope, notInArray(portfolioPositionLots.symbol, symbols));
    await client.delete(portfolioPositionLots).where(stale);
  }
  if (plan.equity.length > 0) {
    await client
      .insert(portfolioEquityDaily)
      .values(plan.equity.map((point) => ({ stateId, ...point })))
      .onConflictDoUpdate({
        target: [portfolioEquityDaily.stateId, portfolioEquityDaily.tradeDate],
        set: {
          cash: sql`excluded.cash`,
          holdingsValue: sql`excluded.holdings_value`,
          totalValue: sql`excluded.total_value`,
          roundSeq: sql`excluded.round_seq`,
        },
      });
  }

  return { stateId, summary: plan.summary };
}

/**
 * Recompute one stream's cache from its round history, in one transaction.
 *
 * The `rebuildStream` of the design spec: `replace`, a delete-and-refold and a
 * cold rebuild all land here, so the cache can never diverge from the fold.
 */
export async function rebuildStream(
  dbClient: DbClient,
  key: StreamKey,
  basisCapital: number,
): Promise<AppliedPlan | null> {
  return dbClient.transaction((tx) => rebuildStreamTx(tx, key, basisCapital));
}

/** `rebuildStream` for a caller that already owns the transaction. */
export async function rebuildStreamTx(
  tx: Queryable,
  key: StreamKey,
  basisCapital: number,
): Promise<AppliedPlan | null> {
  const history = await loadStreamHistory(tx, key);
  if (history.length === 0) return null;
  const bars = await loadBarsBySymbol(tx, symbolsOfHistory(history));
  const plan = planChainRebuild({ key, basisCapital, rounds: toChainRounds(history), bars });
  return applyStreamPlan(tx, plan, { reset: true });
}

export interface FoldRoundInput {
  key: StreamKey;
  roundId: string;
  roundSeq: number;
  /** `asOfTradeDate` — the close the decision applies at. */
  decideTradeDate: string;
  targets: readonly DecisionTarget[];
  theses: ReadonlyMap<string, string>;
  basisCapital: number;
}

/**
 * Fold ONE completed round into the materialized state.
 *
 * Advances `seq`, re-marks the book, and appends the gap's equity points. Takes
 * the caller's transaction so the run insert and this fold commit together.
 */
export async function foldRunIntoStream(
  tx: Queryable,
  input: FoldRoundInput,
): Promise<AppliedPlan> {
  const state = await loadStreamState(tx, input.key);
  const lots = state === undefined ? [] : await loadStreamLots(tx, state.id);
  const symbols = new Set([
    ...lots.map((lot) => lot.symbol),
    ...input.targets.map((target) => target.symbol),
  ]);
  const bars = await loadBarsBySymbol(tx, [...symbols]);

  const plan = planRoundFold({
    key: input.key,
    basisCapital: input.basisCapital,
    currentState: state === undefined ? null : toStateSnapshot(state),
    currentLots: toLotSnapshots(lots),
    round: {
      roundId: input.roundId,
      roundSeq: input.roundSeq,
      decideTradeDate: input.decideTradeDate,
      targets: input.targets,
      theses: input.theses,
    },
    bars,
  });
  const applied = await applyStreamPlan(tx, plan, { reset: false });
  if (applied === null) throw new Error("round fold produced no state write");
  return applied;
}

export interface InsertRunAndFoldInput {
  simulationId: string;
  roundSeq: number;
  /** The chain basis: `simulations.initial_capital`, never the per-round value. */
  basisCapital: number;
  /** The decision's COMPLETE target book. */
  targets: readonly DecisionTarget[];
  theses: ReadonlyMap<string, string>;
  /** Entry fills: symbol → close on `asOfTradeDate`, buys only. */
  entryPrices: Readonly<Record<string, number>>;
  /** Symbol → `portfolioValue × targetWeight / close`, for `portfolio_positions`. */
  positions: readonly {
    symbol: string;
    targetWeight: number;
    shares: number;
    thesis: string | null;
  }[];
  /** The `agent_runs` row to insert. */
  run: {
    roundId: string;
    agentKey: string;
    persona: string;
    strategy: string;
    window: PortfolioWindow;
    /** Per-decision portfolio value the weights were applied to. */
    portfolioValue: number;
    rationale: string | null;
    decisionJson: unknown;
    replicateOf: string | null;
    startedAt: Date;
  };
}

export interface InsertRunAndFoldResult {
  agentRunId: number;
  positionsInserted: number;
  state: AppliedPlan["summary"];
}

export class DuplicateStreamRunError extends Error {
  constructor(roundId: string, agentKey: string) {
    super(
      `Agent run already exists for round "${roundId}" and agentKey "${agentKey}" — refusing to overwrite`,
    );
    this.name = "DuplicateStreamRunError";
  }
}

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";

/**
 * Insert one `agent_runs` row (+ its entry fills) AND fold the round into the
 * materialized state in ONE transaction (R5).
 *
 * All-or-nothing is the whole point: a run inserted without its state advance
 * would block every retry behind the duplicate-run guard, and the chain would
 * silently skip a round.
 */
export async function insertRunAndFold(
  dbClient: DbClient,
  input: InsertRunAndFoldInput,
): Promise<InsertRunAndFoldResult> {
  const { run, simulationId, roundSeq } = input;
  try {
    return await dbClient.transaction(async (tx) => {
      const existing = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(and(eq(agentRuns.roundId, run.roundId), eq(agentRuns.agentKey, run.agentKey)))
        .limit(1);
      if (existing.length > 0) throw new DuplicateStreamRunError(run.roundId, run.agentKey);

      // The round's decide date is authoritative for BOTH the entry fills and
      // the fold's mark, so the run and its state can never disagree.
      const decideTradeDate = await decideDateOf(tx, run.roundId);
      const completedAt = new Date();
      const [inserted] = await tx
        .insert(agentRuns)
        .values({
          roundId: run.roundId,
          simulationId,
          roundSeq,
          agentKey: run.agentKey,
          persona: run.persona,
          strategy: run.strategy,
          window: run.window,
          initialCapital: run.portfolioValue.toFixed(2),
          status: "completed",
          rationale: run.rationale,
          decisionJson: run.decisionJson,
          replicateOf: run.replicateOf,
          startedAt: run.startedAt,
          completedAt,
        })
        .returning({ id: agentRuns.id });
      if (inserted === undefined) throw new Error("insert of agent_runs returned no row");

      if (input.positions.length > 0) {
        await tx.insert(portfolioPositions).values(
          input.positions.map((position) => ({
            agentRunId: inserted.id,
            symbol: position.symbol,
            targetWeight: position.targetWeight.toFixed(6),
            shares: position.shares.toFixed(6),
            entryTradeDate: decideTradeDate,
            entryPrice: (input.entryPrices[position.symbol] ?? 0).toFixed(4),
            thesis: position.thesis,
          })),
        );
      }

      const applied = await foldRunIntoStream(tx, {
        key: { simulationId, personaKey: personaKeyOf(run.agentKey), window: run.window },
        roundId: run.roundId,
        roundSeq,
        decideTradeDate,
        targets: input.targets,
        theses: input.theses,
        basisCapital: input.basisCapital,
      });

      return {
        agentRunId: inserted.id,
        positionsInserted: input.positions.length,
        state: applied.summary,
      };
    });
  } catch (err) {
    if (err instanceof DuplicateStreamRunError) throw err;
    if (isUniqueViolation(err)) throw new DuplicateStreamRunError(run.roundId, run.agentKey);
    throw err;
  }
}

/**
 * Delete a finished round's decisions and re-fold the affected streams from the
 * remaining history, in one transaction (`replace=true`).
 *
 * Runs go first so `portfolio_positions` cascades; the streams are then rebuilt
 * wholesale, which is why a replaced mid-chain round leaves later rounds folded
 * on the shortened history — replace the newest round, which is the only one
 * the launch policy can produce.
 */
export async function replaceRoundInTx(
  tx: Queryable,
  input: { simulationId: string; roundIds: readonly string[] },
): Promise<StreamKey[]> {
  const affected: StreamKey[] = [];
  for (const roundId of input.roundIds) {
    const runs = await tx
      .select({ agentKey: agentRuns.agentKey, window: agentRuns.window })
      .from(agentRuns)
      .where(and(eq(agentRuns.roundId, roundId), eq(agentRuns.simulationId, input.simulationId)));
    await tx
      .delete(agentRuns)
      .where(and(eq(agentRuns.roundId, roundId), eq(agentRuns.simulationId, input.simulationId)));
    for (const run of runs) {
      affected.push({
        simulationId: input.simulationId,
        personaKey: personaKeyOf(run.agentKey),
        window: run.window,
      });
    }
  }

  const [sim] = await tx
    .select({ initialCapital: simulations.initialCapital })
    .from(simulations)
    .where(eq(simulations.simId, input.simulationId))
    .limit(1);
  const basis = Number.parseFloat(sim?.initialCapital ?? "0");

  for (const key of dedupeKeys(affected)) {
    await rebuildStreamTx(tx, key, basis);
  }
  return affected;
}

/* ------------------------------------------------------------------ *
 * envelope parsing (history only — the live path is typed)
 * ------------------------------------------------------------------ */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The complete target book of a stored envelope; `[]` when unreadable. */
export function parseEnvelopeTargets(decisionJson: unknown): DecisionTarget[] {
  if (!isRecord(decisionJson)) return [];
  const positions = decisionJson["positions"];
  if (!Array.isArray(positions)) return [];
  const targets: DecisionTarget[] = [];
  for (const entry of positions) {
    if (!isRecord(entry)) continue;
    const symbol = entry["symbol"];
    const targetWeight = entry["targetWeight"];
    if (typeof symbol !== "string" || symbol.length === 0) continue;
    if (typeof targetWeight !== "number" || !Number.isFinite(targetWeight)) continue;
    targets.push({ symbol, targetWeight });
  }
  return targets;
}

/** symbol → thesis of a stored envelope, for the lot rows. */
export function parseEnvelopeTheses(decisionJson: unknown): Map<string, string> {
  const theses = new Map<string, string>();
  if (!isRecord(decisionJson)) return theses;
  const positions = decisionJson["positions"];
  if (!Array.isArray(positions)) return theses;
  for (const entry of positions) {
    if (!isRecord(entry)) continue;
    const symbol = entry["symbol"];
    const thesis = entry["thesis"];
    if (typeof symbol !== "string" || typeof thesis !== "string") continue;
    theses.set(symbol, thesis);
  }
  return theses;
}

/** Persona key of an `agentKey` (`<personaKey>--<window>`). */
export function personaKeyOf(agentKey: string): string {
  const marker = agentKey.lastIndexOf("--");
  return marker === -1 ? agentKey : agentKey.slice(0, marker);
}

/* ------------------------------------------------------------------ *
 * internals
 * ------------------------------------------------------------------ */

const toChainRounds = (history: readonly StreamRoundRow[]): ChainRoundInput[] =>
  history.map((round) => ({
    roundId: round.roundId,
    roundSeq: round.roundSeq,
    decideTradeDate: round.decideTradeDate,
    targets: round.targets,
    theses: round.theses,
  }));

const symbolsOfHistory = (history: readonly StreamRoundRow[]): string[] => {
  const symbols = new Set<string>();
  for (const round of history) for (const target of round.targets) symbols.add(target.symbol);
  return [...symbols];
};

const dedupeKeys = (keys: readonly StreamKey[]): StreamKey[] => {
  const seen = new Map<string, StreamKey>();
  for (const key of keys) seen.set(`${key.personaKey}--${key.window}`, key);
  return [...seen.values()];
};

/**
 * `asOfTradeDate` of a round, read inside the caller's transaction so the fold
 * marks the same close the round was built from.
 */
async function decideDateOf(tx: Queryable, roundId: string): Promise<string> {
  const [job] = await tx
    .select({ asOfTradeDate: roundJobs.asOfTradeDate })
    .from(roundJobs)
    .where(eq(roundJobs.roundId, roundId))
    .limit(1);
  if (job?.asOfTradeDate == null) {
    throw new Error(`round "${roundId}" has no round_jobs.as_of_trade_date to fold at`);
  }
  return job.asOfTradeDate;
}
