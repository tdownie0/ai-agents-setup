import { sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Market-data ingestion pipeline tables: tradable instruments, daily OHLCV
 * bars, and operational ingestion run audits.
 *
 * `daily_prices.numeric` columns map to JS `string` at the wire boundary
 * (postgres-js returns NUMERIC as string) — RPC consumers must parse them.
 */

export const runTypes = {
  backfill: "backfill",
  update: "update",
  manual: "manual",
} as const;

export type RunType = (typeof runTypes)[keyof typeof runTypes];

export const runStatuses = {
  running: "running",
  finished: "finished",
  failed: "failed",
} as const;

export type RunStatus = (typeof runStatuses)[keyof typeof runStatuses];

/**
 * Tradable instruments. Surrogate PK because tickers change and get reused —
 * `symbol` is never the PK.
 */
export const instruments = pgTable(
  "instruments",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    name: text("name"),
    sector: text("sector"),
    exchange: text("exchange"),
    assetClass: text("asset_class").notNull().default("equity"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // Partial unique: only active rows compete for a symbol (callers pass
    // uppercase; stored as-is).
    uniqueIndex("instruments_symbol_active_unique_idx")
      .on(table.symbol)
      .where(sql`${table.isActive} = true`),
  ],
);

export type Instrument = InferSelectModel<typeof instruments>;

/**
 * Daily OHLCV bars per instrument — the idempotent-upsert target for the
 * ingestion pipeline (unique on instrument_id + trade_date).
 *
 * numeric(12,4) OHLC columns come back as JS `string` at the wire boundary;
 * RPC consumers must parse before arithmetic.
 */
export const dailyPrices = pgTable(
  "daily_prices",
  {
    id: serial("id").primaryKey(),
    instrumentId: integer("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "cascade" }),
    /**
     * US equity session calendar date (America/New_York close date); never
     * derived from UTC.
     */
    tradeDate: date("trade_date").notNull(),
    open: numeric("open", { precision: 12, scale: 4 }),
    high: numeric("high", { precision: 12, scale: 4 }),
    low: numeric("low", { precision: 12, scale: 4 }),
    close: numeric("close", { precision: 12, scale: 4 }),
    adjClose: numeric("adj_close", { precision: 12, scale: 4 }),
    // mode: "number" so JSON-RPC serialization never hits BigInt.
    volume: bigint("volume", { mode: "number" }),
    source: text("source").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("daily_prices_instrument_trade_date_unique_idx").on(
      table.instrumentId,
      table.tradeDate,
    ),
  ],
);

export type DailyPrice = InferSelectModel<typeof dailyPrices>;

/** Operational audit of one ingestion run (backfill/update/manual). */
export const ingestionRuns = pgTable("ingestion_runs", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(),
  runType: text("run_type").notNull().$type<RunType>(),
  status: text("status").notNull().$type<RunStatus>(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  symbolsRequested: integer("symbols_requested"),
  symbolsSucceeded: integer("symbols_succeeded"),
  recordsUpserted: integer("records_upserted"),
  error: text("error"),
});

export type IngestionRun = InferSelectModel<typeof ingestionRuns>;
