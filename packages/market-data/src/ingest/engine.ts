/**
 * IngestEngine — orchestrates symbol-by-symbol fetching and persistence.
 *
 * Guarantees:
 * - Single-flight: a PostgreSQL advisory lock guards `runIngest`; a concurrent
 *   run gets a typed `ConcurrentRunError` (Oracle correction #7).
 * - ONE DB transaction per symbol: bars are fetched (network) outside the
 *   transaction, then the instrument upsert + bars upsert commit atomically; a
 *   failure mid-symbol rolls back only that symbol (Oracle correction #2).
 * - Idempotent full-window upsert: `ON CONFLICT (instrument_id, trade_date) DO
 *   UPDATE` self-heals adjusted-close restatements on re-fetch.
 * - Run audit: one `ingestion_runs` row per run, finalized (finished/failed)
 *   in a single transaction.
 * - Best-effort metadata enrichment: `fetchInstrumentMeta` failures never fail
 *   a symbol's ingest.
 */

import { eq, sql } from "drizzle-orm";
import { ingestionRuns } from "@model_md/database";
import type { InstrumentMeta } from "../types.js";
import type { PriceSource } from "../sources/priceSource.js";
import type { UniverseEntry } from "../universe.js";
import { mapBarsToRows, upsertBars, upsertInstrument } from "./upsert.js";
import {
  ConcurrentRunError,
  INGEST_LOCK_KEY,
  INGEST_SOURCE,
  type DbClient,
  type IngestParams,
  type IngestResult,
  type SymbolFailure,
} from "./types.js";

/** Acquire the single-flight advisory lock; false when another run holds it. */
async function tryAcquireLock(db: DbClient): Promise<boolean> {
  const [row] = await db.execute(sql`SELECT pg_try_advisory_lock(${INGEST_LOCK_KEY}) AS acquired`);
  return (row as { acquired?: boolean } | undefined)?.acquired === true;
}

/** Release the single-flight advisory lock (best-effort). */
async function releaseLock(db: DbClient): Promise<void> {
  try {
    await db.execute(sql`SELECT pg_advisory_unlock(${INGEST_LOCK_KEY})`);
  } catch (err) {
    // A dropped session releases the lock automatically; never mask the
    // original run outcome over a best-effort unlock.
    console.error(`[ingest] advisory lock release failed: ${toErrorMessage(err)}`);
  }
}

/** Best-effort metadata enrichment — must never fail a symbol's ingest. */
async function fetchMetaBestEffort(
  source: PriceSource,
  symbol: string,
): Promise<InstrumentMeta | null> {
  try {
    return await source.fetchInstrumentMeta(symbol);
  } catch {
    return null;
  }
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Apply the optional symbol filter (uppercase-normalized). */
function resolveSymbols(
  universe: readonly UniverseEntry[],
  symbolFilter: string[] | undefined,
): UniverseEntry[] {
  if (symbolFilter === undefined || symbolFilter.length === 0) {
    return [...universe];
  }
  const wanted = new Set(symbolFilter.map((symbol) => symbol.trim().toUpperCase()));
  return universe.filter((entry) => wanted.has(entry.symbol));
}

interface RunCounters {
  symbolsRequested: number;
  symbolsSucceeded: number;
  recordsUpserted: number;
}

type RunFinalization =
  | ({ status: "finished" } & RunCounters)
  | ({ status: "failed"; error: string } & RunCounters);

/** Final run-row update in ONE transaction (audit atomicity). */
async function finalizeRun(db: DbClient, runId: number, final: RunFinalization): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(ingestionRuns)
      .set({
        status: final.status,
        symbolsRequested: final.symbolsRequested,
        symbolsSucceeded: final.symbolsSucceeded,
        recordsUpserted: final.recordsUpserted,
        error: final.status === "failed" ? final.error : null,
        finishedAt: new Date(),
      })
      .where(eq(ingestionRuns.id, runId));
  });
}

/**
 * The ingestion engine. Construct once, call `runIngest` per run — both the
 * CLI scripts and the future POST /ingest route share this single entrypoint.
 */
export class IngestEngine {
  async runIngest(params: IngestParams): Promise<IngestResult> {
    const { source, universe, runType, db } = params;
    const years = params.years;
    const symbols = resolveSymbols(universe, params.symbolFilter);

    const acquired = await tryAcquireLock(db);
    if (!acquired) {
      throw new ConcurrentRunError();
    }

    let runId: number | undefined;
    let symbolsSucceeded = 0;
    let recordsUpserted = 0;
    const failedSymbols: SymbolFailure[] = [];

    try {
      const [run] = await db
        .insert(ingestionRuns)
        .values({ source: INGEST_SOURCE, runType, status: "running" })
        .returning({ id: ingestionRuns.id });
      if (run === undefined) {
        throw new Error("ingestion_runs insert returned no row");
      }
      runId = run.id;

      for (const entry of symbols) {
        try {
          const bars = await source.fetchDailyBars(
            entry.symbol,
            years === undefined ? undefined : { years },
          );
          const meta = await fetchMetaBestEffort(source, entry.symbol);
          await db.transaction(async (tx) => {
            const instrumentId = await upsertInstrument(tx, entry, meta);
            const rows = mapBarsToRows(instrumentId, bars);
            await upsertBars(tx, rows);
          });
          symbolsSucceeded += 1;
          recordsUpserted += bars.length;
        } catch (err) {
          failedSymbols.push({ symbol: entry.symbol, error: toErrorMessage(err) });
        }
      }

      const counters: RunCounters = {
        symbolsRequested: symbols.length,
        symbolsSucceeded,
        recordsUpserted,
      };
      await finalizeRun(db, runId, { status: "finished", ...counters });

      return {
        runId,
        runType,
        ...counters,
        failedSymbols,
      };
    } catch (err) {
      if (runId !== undefined) {
        await finalizeRun(db, runId, {
          status: "failed",
          error: toErrorMessage(err),
          symbolsRequested: symbols.length,
          symbolsSucceeded,
          recordsUpserted,
        });
      }
      throw err;
    } finally {
      await releaseLock(db);
    }
  }
}
