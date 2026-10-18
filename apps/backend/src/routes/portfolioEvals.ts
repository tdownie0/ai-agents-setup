/**
 * Portfolio eval-harness read routes (beads task cpn.2).
 *
 *   GET /portfolio/trading-dates?start=YYYY-MM-DD&end=YYYY-MM-DD
 *   GET /portfolio/evals/:simId?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * The scoring half of the eval harness: score a completed simulation over an
 * arbitrary historical `[start, end]` window, ON READ, from the materialized
 * chain ledger. No new tables, no stored derived metrics — the same
 * no-snapshot-table philosophy the carryover reads follow (FEATURE_README §11.2).
 *
 * The route is thin by design: parse → load → call the pure `evalMetrics`
 * functions → respond. All metric math lives in `portfolio/evalMetrics.ts`.
 *
 * Wire convention, matching `routes/portfolioCarryover.ts`: computed portfolio
 * values are JSON numbers; only DB numeric strings are parsed, and only here at
 * the edge.
 */

import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Hono } from "hono";
import { agentRuns, dailyPrices, db, instruments, roundJobs } from "@model_md/database";
import type { PortfolioWindow } from "@model_md/database";
import { DEFAULT_UNIVERSE } from "@model_md/market-data";
import type { DbClient } from "@model_md/market-data";
import {
  loadEquityByState,
  loadSimulation,
  loadStreamStates,
  streamAgentKey,
} from "../portfolio/carryoverStore.js";
import {
  computeEqualWeightBenchmark,
  computeStreamEvalMetrics,
  sliceStreamEquity,
} from "../portfolio/evalMetrics.js";
import type {
  BenchmarkBar,
  BenchmarkBarsBySymbol,
  BenchmarkResult,
} from "../portfolio/evalMetrics.js";
import { parseSimId } from "./portfolioCarryover.js";

/** `GET /portfolio/trading-dates` response. */
export interface TradingDatesWire {
  tradeDates: string[];
}

/** One stream's scored window in `GET /portfolio/evals/:simId`. */
export interface EvalStreamWire {
  personaKey: string;
  window: PortfolioWindow;
  agentKey: string;
  periodStartValue: number | null;
  periodEndValue: number | null;
  totalReturnPct: number | null;
  annualizedVolPct: number | null;
  sharpe: number | null;
  maxDrawdownPct: number | null;
  /** Decisions this stream made with `round_jobs.as_of_trade_date` in `[start, end]`. */
  decisionCount: number;
  /** `"no book in period"` when the stream has no equity in the window, else `null`. */
  note: string | null;
}

/** `GET /portfolio/evals/:simId` response. */
export interface EvalWire {
  simulationId: string;
  start: string;
  end: string;
  /** Distinct `daily_prices.trade_date` in `[start, end]`. */
  tradingDays: number;
  benchmark: BenchmarkResult;
  streams: EvalStreamWire[];
}

interface DateError {
  error: string;
  hint: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(text: string): boolean {
  return DATE_PATTERN.test(text) && !Number.isNaN(Date.parse(text));
}

/** Parse a required `YYYY-MM-DD` query param, or return the 400 body to hand back. */
export function parseRequiredDate(
  raw: string | undefined,
  name: string,
): { value: string } | { error: DateError } {
  const text = raw?.trim() ?? "";
  if (text.length === 0) {
    return {
      error: {
        error: `${name} query param is required`,
        hint: `${name} must be a YYYY-MM-DD date`,
      },
    };
  }
  if (!isValidDate(text)) {
    return {
      error: {
        error: `invalid ${name} ${JSON.stringify(raw ?? "")}`,
        hint: `${name} must be a YYYY-MM-DD date`,
      },
    };
  }
  return { value: text };
}

/** Parse an optional `YYYY-MM-DD` query param; absent means unbounded. */
export function parseOptionalDate(
  raw: string | undefined,
  name: string,
): { value: string | undefined } | { error: DateError } {
  const text = raw?.trim() ?? "";
  if (text.length === 0) return { value: undefined };
  if (!isValidDate(text)) {
    return {
      error: {
        error: `invalid ${name} ${JSON.stringify(raw ?? "")}`,
        hint: `${name} must be a YYYY-MM-DD date`,
      },
    };
  }
  return { value: text };
}

/** Distinct `daily_prices.trade_date` in `[start, end]` (either side optional), ascending. */
export async function loadTradingDates(
  client: DbClient,
  start?: string,
  end?: string,
): Promise<string[]> {
  const conditions: SQL[] = [];
  if (start !== undefined) conditions.push(gte(dailyPrices.tradeDate, start));
  if (end !== undefined) conditions.push(lte(dailyPrices.tradeDate, end));
  const rows = await client
    .select({ tradeDate: dailyPrices.tradeDate })
    .from(dailyPrices)
    .where(and(...conditions))
    .orderBy(asc(dailyPrices.tradeDate));
  return [...new Set(rows.map((row) => row.tradeDate))];
}

/** `adjClose` bars for `symbols` within `[start, end]`, keyed by symbol, oldest-first. */
export async function loadBenchmarkBars(
  client: DbClient,
  symbols: readonly string[],
  start: string,
  end: string,
): Promise<BenchmarkBarsBySymbol> {
  const map = new Map<string, BenchmarkBar[]>();
  if (symbols.length === 0) return map;
  const rows = await client
    .select({
      symbol: instruments.symbol,
      tradeDate: dailyPrices.tradeDate,
      adjClose: dailyPrices.adjClose,
    })
    .from(dailyPrices)
    .innerJoin(instruments, eq(dailyPrices.instrumentId, instruments.id))
    .where(
      and(
        inArray(instruments.symbol, [...symbols]),
        gte(dailyPrices.tradeDate, start),
        lte(dailyPrices.tradeDate, end),
      ),
    )
    .orderBy(asc(dailyPrices.tradeDate));
  for (const row of rows) {
    const list = map.get(row.symbol) ?? [];
    list.push({ tradeDate: row.tradeDate, adjClose: row.adjClose });
    map.set(row.symbol, list);
  }
  return map;
}

/**
 * Per-`agentKey` count of `agent_runs` whose round's `as_of_trade_date` is in
 * `[start, end]`. `agent_runs.round_id` has no FK to `round_jobs` (R6), so the
 * join is by value; a round with no `as_of_trade_date` cannot fall in the window
 * and is excluded by the range predicate.
 */
export async function loadDecisionCounts(
  client: DbClient,
  simulationId: string,
  start: string,
  end: string,
): Promise<Map<string, number>> {
  const rows = await client
    .select({ agentKey: agentRuns.agentKey, count: sql<number>`cast(count(*) as int)` })
    .from(agentRuns)
    .innerJoin(roundJobs, eq(agentRuns.roundId, roundJobs.roundId))
    .where(
      and(
        eq(agentRuns.simulationId, simulationId),
        gte(roundJobs.asOfTradeDate, start),
        lte(roundJobs.asOfTradeDate, end),
      ),
    )
    .groupBy(agentRuns.agentKey);
  return new Map(rows.map((row) => [row.agentKey, Number(row.count)]));
}

const portfolioEvalsApp = new Hono()
  .get("/trading-dates", async (c) => {
    const start = parseOptionalDate(c.req.query("start"), "start");
    if ("error" in start) return c.json(start.error, 400);
    const end = parseOptionalDate(c.req.query("end"), "end");
    if ("error" in end) return c.json(end.error, 400);
    const tradeDates = await loadTradingDates(db, start.value, end.value);
    return c.json({ tradeDates } satisfies TradingDatesWire);
  })

  .get("/evals/:simId", async (c) => {
    const parsed = parseSimId(c.req.param("simId"));
    if ("error" in parsed) return c.json(parsed.error, 400);
    const start = parseRequiredDate(c.req.query("start"), "start");
    if ("error" in start) return c.json(start.error, 400);
    const end = parseRequiredDate(c.req.query("end"), "end");
    if ("error" in end) return c.json(end.error, 400);

    const simulation = await loadSimulation(db, parsed.simId);
    if (simulation === undefined) {
      return c.json(
        {
          error: `unknown simulation ${JSON.stringify(parsed.simId)}`,
          hint: "List simulations with GET /api/portfolio/simulations.",
        },
        404,
      );
    }

    const [tradeDates, states] = await Promise.all([
      loadTradingDates(db, start.value, end.value),
      loadStreamStates(db, parsed.simId),
    ]);
    const [equityByState, decisionCounts, benchmarkBars] = await Promise.all([
      loadEquityByState(
        db,
        states.map((state) => state.id),
      ),
      loadDecisionCounts(db, parsed.simId, start.value, end.value),
      loadBenchmarkBars(
        db,
        DEFAULT_UNIVERSE.map((entry) => entry.symbol),
        start.value,
        end.value,
      ),
    ]);

    const benchmark = computeEqualWeightBenchmark(benchmarkBars, start.value, end.value);
    const streams = states.map((state) => {
      const agentKey = streamAgentKey({ personaKey: state.personaKey, window: state.window });
      const sliced = sliceStreamEquity(equityByState.get(state.id) ?? [], start.value, end.value);
      const metrics = computeStreamEvalMetrics(sliced);
      return {
        personaKey: state.personaKey,
        window: state.window,
        agentKey,
        periodStartValue: sliced?.periodStartValue ?? null,
        periodEndValue: sliced?.periodEndValue ?? null,
        totalReturnPct: metrics.totalReturnPct,
        annualizedVolPct: metrics.annualizedVolPct,
        sharpe: metrics.sharpe,
        maxDrawdownPct: metrics.maxDrawdownPct,
        decisionCount: decisionCounts.get(agentKey) ?? 0,
        note: sliced === null ? "no book in period" : null,
      } satisfies EvalStreamWire;
    });

    return c.json({
      simulationId: parsed.simId,
      start: start.value,
      end: end.value,
      tradingDays: tradeDates.length,
      benchmark,
      streams,
    } satisfies EvalWire);
  });

export default portfolioEvalsApp;
