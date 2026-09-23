/**
 * Ingest engine public contract (beads task vll.3).
 *
 * The engine consumes the `PriceSource` seam, the code-owned universe config,
 * and the Drizzle tables (`instruments`, `daily_prices`, `ingestion_runs`) to
 * fetch and persist daily OHLCV bars idempotently. Config flows in via
 * `IngestParams` — modules under `packages/market-data/src` NEVER read
 * `process.env`; only the CLI/route entrypoints do.
 */

import type { db } from "@model_md/database";
import type { RunType } from "@model_md/database";
import type { PriceSource } from "../sources/priceSource.js";
import type { UniverseEntry } from "../universe.js";

/** The Drizzle database client (`typeof db` from `@model_md/database`). */
export type DbClient = typeof db;

/**
 * Minimal transaction surface the per-symbol upsert helpers need. Both
 * `PgDatabase` and `PgTransaction` satisfy it structurally, so helpers work
 * against the engine's `db.transaction(...)` callback.
 */
export interface IngestTx {
  insert: DbClient["insert"];
  update: DbClient["update"];
}

/** Source name stamped on every persisted bar and ingestion run. */
export const INGEST_SOURCE = "yahoo" as const;

/**
 * Fixed advisory-lock key for single-flight ingestion. A literal bigint
 * constant (not derived from a string) so every process agrees on the key.
 */
export const INGEST_LOCK_KEY = 727112233445;

export interface IngestParams {
  /** Pluggable provider (YahooSource today, Twelve Data later). */
  source: PriceSource;
  /** Code-owned universe config (symbol/name/sector). */
  universe: readonly UniverseEntry[];
  /** Optional subset of universe symbols to ingest (uppercase tickers). */
  symbolFilter?: string[];
  /** Trailing window in years; omitted → the adapter's default window. */
  years?: number;
  /** Audit classification: "backfill" | "update" | "manual". */
  runType: RunType;
  /** Drizzle client for `instruments` / `daily_prices` / `ingestion_runs`. */
  db: DbClient;
}

/** One symbol whose ingest failed; the run continues with the rest. */
export interface SymbolFailure {
  symbol: string;
  error: string;
}

export interface IngestResult {
  /** `ingestion_runs.id` of the audited run. */
  runId: number;
  runType: RunType;
  symbolsRequested: number;
  symbolsSucceeded: number;
  recordsUpserted: number;
  failedSymbols: SymbolFailure[];
}

/**
 * Thrown by `runIngest` when the single-flight advisory lock is already held
 * by another ingestion run.
 */
export class ConcurrentRunError extends Error {
  constructor(message = "another ingestion run is in progress") {
    super(message);
    this.name = "ConcurrentRunError";
  }
}