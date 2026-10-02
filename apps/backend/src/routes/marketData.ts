import { Hono } from "hono";
import { and, asc, eq, gte, lte, max } from "drizzle-orm";
import { db, dailyPrices, instruments } from "@model_md/database";
import {
  ConcurrentRunError,
  DEFAULT_UNIVERSE,
  IngestEngine,
  subtractUnit,
  YahooSource,
} from "@model_md/market-data";
import type { DbClient } from "@model_md/market-data";
import { authMiddleware } from "../middleware/authMiddleware.js";

/**
 * Market-data RPC routes (beads task vll.4).
 *
 * Public reads: the code-owned 49-ticker universe, per-symbol daily bars
 * (optional ?start&end YYYY-MM-DD filters), and the latest bar per instrument.
 * POST /ingest is authenticated (Supabase JWT via authMiddleware) and wraps
 * the IngestEngine's advisory-lock single-flight run.
 *
 * Wire convention: numeric(12,4) OHLC columns arrive from postgres-js as
 * STRINGS and are returned as-is (the frontend parses them); volume is a JS
 * number (bigint mode "number"). Query helpers are exported for downstream
 * tests (beads task vll.6).
 */

/** One entry of the GET /universe response. */
export interface UniverseEntryWire {
  symbol: string;
  name: string;
  sector: string;
}

/** One daily bar of the GET /prices/:symbol response. */
export interface PriceBarWire {
  tradeDate: string;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  adjClose: string | null;
  volume: number | null;
  source: string;
}

/** One row of the GET /latest response. */
export interface LatestBarWire {
  symbol: string;
  name: string | null;
  tradeDate: string;
  close: string | null;
  adjClose: string | null;
  volume: number | null;
}

/** The code-owned universe, always fresh (never depends on DB enrichment). */
export function listUniverse(): UniverseEntryWire[] {
  return DEFAULT_UNIVERSE.map(({ symbol, name, sector }) => ({ symbol, name, sector }));
}

/**
 * Daily bars for one uppercase symbol, oldest-first. Returns [] when the
 * instrument is unknown OR has no bars in the optional ?start&end window.
 */
export async function fetchBars(
  dbClient: DbClient,
  symbol: string,
  range?: { start?: string; end?: string },
): Promise<PriceBarWire[]> {
  const [instrument] = await dbClient
    .select({ id: instruments.id })
    .from(instruments)
    .where(eq(instruments.symbol, symbol))
    .limit(1);
  if (instrument === undefined) return [];

  const conditions = [eq(dailyPrices.instrumentId, instrument.id)];
  if (range?.start !== undefined) conditions.push(gte(dailyPrices.tradeDate, range.start));
  if (range?.end !== undefined) conditions.push(lte(dailyPrices.tradeDate, range.end));

  return dbClient
    .select({
      tradeDate: dailyPrices.tradeDate,
      open: dailyPrices.open,
      high: dailyPrices.high,
      low: dailyPrices.low,
      close: dailyPrices.close,
      adjClose: dailyPrices.adjClose,
      volume: dailyPrices.volume,
      source: dailyPrices.source,
    })
    .from(dailyPrices)
    .where(and(...conditions))
    .orderBy(asc(dailyPrices.tradeDate));
}

/**
 * Most recent bar per instrument (max(trade_date)), ordered by symbol. Only
 * instruments with at least one bar appear.
 */
export async function fetchLatestBars(dbClient: DbClient): Promise<LatestBarWire[]> {
  const latest = dbClient
    .select({
      instrumentId: dailyPrices.instrumentId,
      maxDate: max(dailyPrices.tradeDate),
    })
    .from(dailyPrices)
    .groupBy(dailyPrices.instrumentId)
    .as("latest");

  return dbClient
    .select({
      symbol: instruments.symbol,
      name: instruments.name,
      tradeDate: dailyPrices.tradeDate,
      close: dailyPrices.close,
      adjClose: dailyPrices.adjClose,
      volume: dailyPrices.volume,
    })
    .from(instruments)
    .innerJoin(latest, eq(instruments.id, latest.instrumentId))
    .innerJoin(
      dailyPrices,
      and(eq(dailyPrices.instrumentId, instruments.id), eq(dailyPrices.tradeDate, latest.maxDate)),
    )
    .orderBy(instruments.symbol);
}

/** Parse the optional `years` body field; undefined when absent. */
export function parseYears(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("years must be a positive integer");
  }
  return parsed;
}

const marketDataApp = new Hono<{ Variables: { userId: string } }>()
  .get("/universe", (c) => c.json(listUniverse()))

  .get("/prices/:symbol", async (c) => {
    const symbol = c.req.param("symbol").trim().toUpperCase();
    const start = c.req.query("start");
    const end = c.req.query("end");
    const bars = await fetchBars(db, symbol, { start, end });
    if (bars.length === 0) {
      return c.json(
        {
          error: `No price data for symbol "${symbol}"`,
          hint: "run POST /api/market-data/ingest first",
        },
        404,
      );
    }
    return c.json(bars);
  })

  .get("/latest", async (c) => c.json(await fetchLatestBars(db)))

  .post("/ingest", authMiddleware, async (c) => {
    let years: number | undefined;
    const rawBody = await c.req.text();
    if (rawBody.trim().length > 0) {
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      if (typeof body === "object" && body !== null && "years" in body) {
        try {
          years = parseYears((body as { years?: unknown }).years);
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      }
    }

    const source = new YahooSource();
    const engine = new IngestEngine();
    try {
      const result = await engine.runIngest({
        source,
        universe: DEFAULT_UNIVERSE,
        runType: "manual",
        db,
        from: subtractUnit(new Date(), "years", years ?? 1),
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof ConcurrentRunError) {
        return c.json({ error: err.message }, 409);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

export default marketDataApp;
