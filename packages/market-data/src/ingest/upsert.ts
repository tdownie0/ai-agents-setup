/**
 * Per-symbol persistence helpers for the ingest engine.
 *
 * Both helpers run inside ONE transaction per symbol (Oracle correction #2):
 * the instrument upsert and the bars upsert commit or roll back together, so a
 * failure mid-symbol never leaves a half-written instrument or partial bars.
 */

import { sql } from "drizzle-orm";
import { dailyPrices, instruments } from "@model_md/database";
import type { InstrumentMeta, PriceBar } from "../types.js";
import type { UniverseEntry } from "../universe.js";
import { INGEST_SOURCE, type IngestTx } from "./types.js";

/** Format a JS number for a numeric(12,4) column (postgres-js NUMERIC → string). */
function toNumericString(value: number): string {
  return value.toFixed(4);
}

/**
 * Build the instrument upsert query (lazy — call `.toSQL()` or `await` it).
 * Exposed separately so tests can assert the generated SQL.
 */
export function buildInstrumentUpsertQuery(
  tx: IngestTx,
  entry: UniverseEntry,
  meta: InstrumentMeta | null,
) {
  const name = meta?.name ?? entry.name;
  const sector = meta?.sector ?? entry.sector;
  const exchange = meta?.exchange ?? null;

  return tx
    .insert(instruments)
    .values({
      symbol: entry.symbol,
      name,
      sector,
      exchange,
      assetClass: "equity",
      isActive: true,
    })
    .onConflictDoUpdate({
      target: instruments.symbol,
      targetWhere: sql`${instruments.isActive} = true`,
      set: {
        name,
        sector,
        exchange,
        assetClass: "equity",
        isActive: true,
        updatedAt: new Date(),
      },
    })
    .returning({ id: instruments.id });
}

/**
 * Upsert one universe entry into `instruments`, honoring the partial unique
 * index `instruments_symbol_active_unique_idx (symbol) WHERE is_active = true`.
 *
 * `onConflictDoUpdate` with `target + targetWhere` matches the partial index
 * exactly: an existing ACTIVE row for the symbol gets its metadata refreshed
 * (so enrichment/config updates land), while an INACTIVE row does not conflict
 * and a fresh active row is inserted. Metadata falls back to the universe
 * config when enrichment returned nulls.
 */
export async function upsertInstrument(
  tx: IngestTx,
  entry: UniverseEntry,
  meta: InstrumentMeta | null,
): Promise<number> {
  const [row] = await buildInstrumentUpsertQuery(tx, entry, meta);

  if (row === undefined) {
    throw new Error(`instrument upsert returned no row for ${entry.symbol}`);
  }
  return row.id;
}

/** One `daily_prices` row ready for the idempotent upsert. */
export interface BarRow {
  instrumentId: number;
  tradeDate: string;
  open: string;
  high: string;
  low: string;
  close: string;
  adjClose: string;
  volume: number;
  source: string;
  fetchedAt: Date;
}

/** Map provider bars to `daily_prices` rows (numeric columns as strings). */
export function mapBarsToRows(instrumentId: number, bars: readonly PriceBar[]): BarRow[] {
  const fetchedAt = new Date();
  return bars.map((bar) => ({
    instrumentId,
    tradeDate: bar.tradeDate,
    open: toNumericString(bar.open),
    high: toNumericString(bar.high),
    low: toNumericString(bar.low),
    close: toNumericString(bar.close),
    adjClose: toNumericString(bar.adjClose),
    volume: bar.volume,
    source: INGEST_SOURCE,
    fetchedAt,
  }));
}

/**
 * Build the bars upsert query (lazy — call `.toSQL()` or `await` it).
 * Exposed separately so tests can assert the generated SQL.
 */
export function buildBarsUpsertQuery(tx: IngestTx, rows: readonly BarRow[]) {
  return tx
    .insert(dailyPrices)
    .values([...rows])
    .onConflictDoUpdate({
      target: [dailyPrices.instrumentId, dailyPrices.tradeDate],
      set: {
        open: sql`excluded.open`,
        high: sql`excluded.high`,
        low: sql`excluded.low`,
        close: sql`excluded.close`,
        adjClose: sql`excluded.adj_close`,
        volume: sql`excluded.volume`,
        source: sql`excluded.source`,
        fetchedAt: sql`excluded.fetched_at`,
      },
    });
}

/**
 * Idempotent full-window upsert of daily OHLCV bars.
 *
 * `INSERT ... ON CONFLICT (instrument_id, trade_date) DO UPDATE` overwrites
 * every OHLCV field from the freshly fetched window, so re-fetching self-heals
 * adjusted-close restatements (and any other provider corrections).
 */
export async function upsertBars(tx: IngestTx, rows: readonly BarRow[]): Promise<void> {
  if (rows.length === 0) return;
  await buildBarsUpsertQuery(tx, rows);
}
