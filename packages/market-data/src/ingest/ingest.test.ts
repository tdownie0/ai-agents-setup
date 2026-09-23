/**
 * Unit tests for the market-data ingest layer (beads task vll.6).
 *
 * Pure/unit only — NO live database, NO network:
 * - `mapBarsToRows` / SQL builders are exercised against the real Drizzle
 *   query builders via `.toSQL()` (string generation only, never executed).
 * - `IngestEngine.runIngest` runs against a fake `DbClient` (insert/update/
 *   execute/transaction all captured in-memory) and a fake `PriceSource`.
 *
 * CLI arg parsing (`src/cli/runCli.ts`) is deliberately NOT tested: `runCli`
 * reads `process.argv`/`process.exit` and is not part of the package's
 * exported surface for this task.
 */

import { describe, it, expect, vi } from "vitest";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { dailyPrices, db, ingestionRuns, instruments } from "@model_md/database";
import type { InstrumentMeta, PriceBar } from "../types.js";
import type { PriceSource } from "../sources/priceSource.js";
import type { UniverseEntry } from "../universe.js";
import {
  buildBarsUpsertQuery,
  buildInstrumentUpsertQuery,
  mapBarsToRows,
  type BarRow,
} from "./upsert.js";
import { IngestEngine } from "./engine.js";
import { ConcurrentRunError, INGEST_SOURCE, type DbClient } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dialect = new PgDialect();

/** Render a Drizzle `SQL` object (e.g. the advisory-lock queries) to text. */
function sqlText(query: unknown): string {
  if (query instanceof SQL) return dialect.sqlToQuery(query).sql;
  return String(query);
}

function asBarRows(value: unknown): readonly BarRow[] {
  if (!Array.isArray(value)) throw new Error("expected a bar-row batch");
  return value as readonly BarRow[];
}

function makeBars(symbol: string, count: number): PriceBar[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol,
    tradeDate: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10),
    open: 100 + i + 0.123456,
    high: 101 + i + 0.5,
    low: 99 + i + 0.25,
    close: 100 + i + 0.5,
    adjClose: 100 + i + 0.75,
    volume: 1_000 + i,
  }));
}

interface SourceOptions {
  /** Bars returned per symbol. Default 2. */
  barsPerSymbol?: number;
  /** Symbols whose `fetchDailyBars` rejects. */
  failSymbols?: ReadonlySet<string>;
  /** When true, `fetchInstrumentMeta` rejects (best-effort path). */
  metaThrows?: boolean;
}

/** Fake `PriceSource` — no network, all behavior injected. */
function createSource(opts: SourceOptions = {}): PriceSource & {
  fetchDailyBars: ReturnType<typeof vi.fn>;
  fetchInstrumentMeta: ReturnType<typeof vi.fn>;
} {
  const barsPerSymbol = opts.barsPerSymbol ?? 2;
  const failSymbols = opts.failSymbols ?? new Set<string>();
  return {
    fetchDailyBars: vi.fn(async (symbol: string) => {
      if (failSymbols.has(symbol)) {
        throw new Error(`fetch failed for ${symbol}`);
      }
      return makeBars(symbol, barsPerSymbol);
    }),
    fetchInstrumentMeta: vi.fn(async (symbol: string): Promise<InstrumentMeta> => {
      if (opts.metaThrows === true) {
        throw new Error("metadata enrichment boom");
      }
      return {
        symbol,
        name: `${symbol} Inc.`,
        sector: "Technology",
        exchange: "NASDAQ",
        assetClass: "equity",
      };
    }),
  };
}

const UNIVERSE: readonly UniverseEntry[] = [
  { symbol: "AAA", sector: "Information Technology", name: "Alpha" },
  { symbol: "BBB", sector: "Financials", name: "Beta" },
  { symbol: "CCC", sector: "Energy", name: "Gamma" },
];

interface EngineCaptures {
  /** SQL text of every `db.execute` call (advisory lock acquire/release). */
  execute: string[];
  /** Payload of the `ingestion_runs` "running" insert. */
  runInsertValues: unknown[];
  /** Payload of every `ingestion_runs` finalization `.set(...)`. */
  runUpdateSets: unknown[];
  /** Payload of every per-symbol `instruments` `.values(...)`. */
  txInstruments: unknown[];
  /** Payload of every per-symbol `daily_prices` `.values([...])`. */
  txBars: unknown[];
  /** How many times `db.transaction` ran (per-symbol + finalize). */
  transactionCount: number;
}

interface FakeDb {
  db: DbClient;
  captured: EngineCaptures;
}

interface FakeDbOptions {
  /** Advisory-lock acquisition result. Default true. */
  acquired?: boolean;
  /** `ingestion_runs.id` returned by the run insert; `null` → no row. */
  runInsertId?: number | null;
}

/**
 * In-memory `DbClient` stand-in. Every branch dispatches on the real Drizzle
 * table object identity, so the engine's query-building code paths run for
 * real while nothing is ever executed against Postgres.
 */
function createFakeDb(opts: FakeDbOptions = {}): FakeDb {
  const acquired = opts.acquired ?? true;
  const runInsertId = opts.runInsertId === undefined ? 42 : opts.runInsertId;
  let nextInstrumentId = 100;
  const captured: EngineCaptures = {
    execute: [],
    runInsertValues: [],
    runUpdateSets: [],
    txInstruments: [],
    txBars: [],
    transactionCount: 0,
  };

  const insert = (table: unknown): unknown => {
    const chain = {
      values: (values: unknown) => {
        if (table === ingestionRuns) captured.runInsertValues.push(values);
        else if (table === instruments) captured.txInstruments.push(values);
        else if (table === dailyPrices) captured.txBars.push(values);
        return chain;
      },
      onConflictDoUpdate: (_config: unknown) => chain,
      returning: (): Promise<unknown[]> => {
        if (table === ingestionRuns) {
          return Promise.resolve(runInsertId === null ? [] : [{ id: runInsertId }]);
        }
        if (table === instruments) {
          return Promise.resolve([{ id: nextInstrumentId++ }]);
        }
        return Promise.resolve([]);
      },
      // `await buildBarsUpsertQuery(...)` resolves the lazy insert chain.
      // oxlint-disable-next-line no-thenable -- mirrors drizzle's thenable lazy insert builder
      then: (
        onfulfilled?: ((value: unknown) => unknown) | null,
        onrejected?: ((reason: unknown) => unknown) | null,
      ): PromiseLike<unknown> => Promise.resolve<unknown>([]).then(onfulfilled, onrejected),
    };
    return chain;
  };

  const update = (table: unknown): unknown => {
    const chain = {
      set: (value: unknown) => {
        if (table === ingestionRuns) captured.runUpdateSets.push(value);
        return chain;
      },
      where: (_condition: unknown) => Promise.resolve<unknown[]>([]),
    };
    return chain;
  };

  const execute = (query: unknown): Promise<unknown[]> => {
    const text = sqlText(query);
    captured.execute.push(text);
    if (text.includes("pg_try_advisory_lock")) {
      return Promise.resolve([{ acquired }]);
    }
    if (text.includes("pg_advisory_unlock")) {
      return Promise.resolve([{ acquired: true }]);
    }
    return Promise.resolve([]);
  };

  const txFake = { insert, update };
  const fakeDb = {
    insert,
    update,
    execute,
    transaction: <T>(cb: (tx: typeof txFake) => Promise<T>): Promise<T> => {
      captured.transactionCount += 1;
      return cb(txFake);
    },
  };

  return { db: fakeDb as unknown as DbClient, captured };
}

// ---------------------------------------------------------------------------
// mapBarsToRows
// ---------------------------------------------------------------------------

describe("mapBarsToRows", () => {
  const bars: readonly PriceBar[] = [
    {
      symbol: "AAA",
      tradeDate: "2024-01-02",
      open: 100.123456,
      high: 101.5,
      low: 0.1,
      close: 1234.56789,
      adjClose: 1,
      volume: 12_345,
    },
    {
      symbol: "AAA",
      tradeDate: "2024-01-03",
      open: 42.424242,
      high: 50,
      low: 40,
      close: 45,
      adjClose: 44.5,
      volume: 0,
    },
  ];

  it("maps every bar to a row with numeric columns as toFixed(4) strings", () => {
    const rows = mapBarsToRows(7, bars);
    expect(rows).toHaveLength(2);

    const [first, second] = rows;
    expect(first.tradeDate).toBe("2024-01-02");
    expect(first.open).toBe("100.1235");
    expect(first.high).toBe("101.5000");
    expect(first.low).toBe("0.1000");
    expect(first.close).toBe("1234.5679");
    expect(first.adjClose).toBe("1.0000");
    expect(second.open).toBe("42.4242");
    expect(second.close).toBe("45.0000");
    expect(second.adjClose).toBe("44.5000");
  });

  it("passes volume through as a JS number and stamps instrumentId", () => {
    const rows = mapBarsToRows(7, bars);
    const [first, second] = rows;
    expect(first.instrumentId).toBe(7);
    expect(second.instrumentId).toBe(7);
    expect(first.volume).toBe(12_345);
    expect(typeof first.volume).toBe("number");
    expect(second.volume).toBe(0);
  });

  it("stamps the yahoo source and one shared fetchedAt Date on all rows", () => {
    const rows = mapBarsToRows(7, bars);
    expect(INGEST_SOURCE).toBe("yahoo");
    for (const row of rows) {
      expect(row.source).toBe("yahoo");
      expect(row.fetchedAt).toBeInstanceOf(Date);
    }
    expect(rows[0].fetchedAt).toBe(rows[1].fetchedAt);
    expect(rows.map((row) => row.tradeDate)).toEqual(["2024-01-02", "2024-01-03"]);
  });

  it("returns an empty array for an empty bar window", () => {
    expect(mapBarsToRows(1, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildInstrumentUpsertQuery
// ---------------------------------------------------------------------------

describe("buildInstrumentUpsertQuery", () => {
  const entry: UniverseEntry = {
    symbol: "AAA",
    sector: "Information Technology",
    name: "Universe Name",
  };
  const meta: InstrumentMeta = {
    symbol: "AAA",
    name: "Enriched Name",
    sector: "Communication Services",
    exchange: "NASDAQ",
    assetClass: "equity",
  };

  it("generates an upsert targeting the partial active-symbol unique index", () => {
    const query = buildInstrumentUpsertQuery(db, entry, meta);
    const { sql: text } = query.toSQL();
    expect(text).toContain(
      'on conflict ("symbol") where "instruments"."is_active" = true do update set',
    );
    expect(text).toContain('insert into "instruments"');
    expect(text).toContain('returning "id"');
  });

  it("prefers enriched metadata over the universe entry", () => {
    const query = buildInstrumentUpsertQuery(db, entry, meta);
    const { params } = query.toSQL();
    expect(params).toContain("Enriched Name");
    expect(params).toContain("Communication Services");
    expect(params).toContain("NASDAQ");
    expect(params).not.toContain("Universe Name");
  });

  it("falls back to universe values when enrichment returned null", () => {
    const query = buildInstrumentUpsertQuery(db, entry, null);
    const { params } = query.toSQL();
    expect(params).toContain("Universe Name");
    expect(params).toContain("Information Technology");
    expect(params).not.toContain("Enriched Name");
  });
});

// ---------------------------------------------------------------------------
// buildBarsUpsertQuery
// ---------------------------------------------------------------------------

describe("buildBarsUpsertQuery", () => {
  it("upserts on (instrument_id, trade_date) from excluded.* for every price", () => {
    const rows: BarRow[] = mapBarsToRows(3, makeBars("AAA", 2));
    const query = buildBarsUpsertQuery(db, rows);
    const { sql: text } = query.toSQL();
    expect(text).toContain('insert into "daily_prices"');
    expect(text).toContain('on conflict ("instrument_id","trade_date") do update set');
    for (const ref of [
      "excluded.open",
      "excluded.high",
      "excluded.low",
      "excluded.close",
      "excluded.adj_close",
      "excluded.volume",
      "excluded.source",
      "excluded.fetched_at",
    ]) {
      expect(text).toContain(ref);
    }
  });
});

// ---------------------------------------------------------------------------
// IngestEngine.runIngest
// ---------------------------------------------------------------------------

describe("IngestEngine.runIngest", () => {
  it("happy path: run audit row, per-symbol transactions, finished counters", async () => {
    const { db: fakeDb, captured } = createFakeDb({ runInsertId: 42 });
    const source = createSource({ barsPerSymbol: 2 });
    const engine = new IngestEngine();

    const result = await engine.runIngest({
      source,
      universe: UNIVERSE,
      years: 5,
      runType: "backfill",
      db: fakeDb,
    });

    expect(result).toEqual({
      runId: 42,
      runType: "backfill",
      symbolsRequested: 3,
      symbolsSucceeded: 3,
      recordsUpserted: 6,
      failedSymbols: [],
    });

    // Run audit: one "running" insert …
    expect(captured.runInsertValues).toEqual([
      { source: "yahoo", runType: "backfill", status: "running" },
    ]);
    // … finalized once with matching counters.
    expect(captured.runUpdateSets).toHaveLength(1);
    expect(captured.runUpdateSets[0]).toMatchObject({
      status: "finished",
      symbolsRequested: 3,
      symbolsSucceeded: 3,
      recordsUpserted: 6,
      error: null,
    });

    // Fetching: 3 symbols, years window forwarded, enrichment attempted.
    expect(source.fetchDailyBars).toHaveBeenCalledTimes(3);
    expect(source.fetchDailyBars).toHaveBeenCalledWith("AAA", { years: 5 });
    expect(source.fetchInstrumentMeta).toHaveBeenCalledTimes(3);

    // ONE transaction per symbol + ONE finalization transaction.
    expect(captured.transactionCount).toBe(4);

    // Per-symbol inserts: 3 instruments, 3 bar batches with sequential ids.
    expect(captured.txInstruments).toHaveLength(3);
    expect(captured.txInstruments[0]).toMatchObject({ symbol: "AAA" });
    expect(captured.txInstruments[1]).toMatchObject({ symbol: "BBB" });
    expect(captured.txInstruments[2]).toMatchObject({ symbol: "CCC" });
    expect(captured.txBars).toHaveLength(3);
    const firstBatch = asBarRows(captured.txBars[0]);
    expect(firstBatch).toHaveLength(2);
    expect(firstBatch[0]).toMatchObject({ instrumentId: 100, source: "yahoo" });
    expect(asBarRows(captured.txBars[1])[0]).toMatchObject({ instrumentId: 101 });
    expect(asBarRows(captured.txBars[2])[0]).toMatchObject({ instrumentId: 102 });

    // Advisory lock acquired first, released last.
    expect(captured.execute[0]).toContain("pg_try_advisory_lock");
    expect(captured.execute.at(-1)).toContain("pg_advisory_unlock");
    expect(captured.execute).toHaveLength(2);
  });

  it("single-flight: throws ConcurrentRunError without touching ingestion_runs", async () => {
    const { db: fakeDb, captured } = createFakeDb({ acquired: false });
    const source = createSource();
    const engine = new IngestEngine();

    const error = await engine
      .runIngest({
        source,
        universe: UNIVERSE,
        runType: "manual",
        db: fakeDb,
      })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ConcurrentRunError);
    expect(error).toMatchObject({
      name: "ConcurrentRunError",
      message: "another ingestion run is in progress",
    });
    // No run insert attempted, no fetches, and no unlock (we never owned it).
    expect(captured.runInsertValues).toHaveLength(0);
    expect(captured.execute).toHaveLength(1);
    expect(captured.execute[0]).toContain("pg_try_advisory_lock");
    expect(source.fetchDailyBars).not.toHaveBeenCalled();
  });

  it("symbol failure isolation: one failing symbol does not fail the run", async () => {
    const { db: fakeDb, captured } = createFakeDb({ runInsertId: 7 });
    const source = createSource({ failSymbols: new Set(["BBB"]) });
    const engine = new IngestEngine();

    const result = await engine.runIngest({
      source,
      universe: UNIVERSE,
      runType: "update",
      db: fakeDb,
    });

    expect(result.runId).toBe(7);
    expect(result.symbolsRequested).toBe(3);
    expect(result.symbolsSucceeded).toBe(2);
    expect(result.recordsUpserted).toBe(4);
    expect(result.failedSymbols).toEqual([{ symbol: "BBB", error: "fetch failed for BBB" }]);

    // The failing symbol never reached a transaction; the run still finished.
    expect(captured.txBars).toHaveLength(2);
    expect(captured.txInstruments).toHaveLength(2);
    expect(captured.runUpdateSets).toHaveLength(1);
    expect(captured.runUpdateSets[0]).toMatchObject({
      status: "finished",
      symbolsSucceeded: 2,
      recordsUpserted: 4,
    });
    expect(source.fetchDailyBars).toHaveBeenCalledTimes(3);
    expect(captured.execute.at(-1)).toContain("pg_advisory_unlock");
  });

  it("releases the advisory lock in finally even when the run fails", async () => {
    // Run-insert returning no row forces the catch path (runId stays undefined).
    const { db: fakeDb, captured } = createFakeDb({ runInsertId: null });
    const source = createSource();
    const engine = new IngestEngine();

    const error = await engine
      .runIngest({
        source,
        universe: UNIVERSE,
        runType: "manual",
        db: fakeDb,
      })
      .catch((err: unknown) => err);

    expect(error).toMatchObject({ message: "ingestion_runs insert returned no row" });
    // Lock: acquired once, released once, in finally.
    expect(captured.execute).toHaveLength(2);
    expect(captured.execute[0]).toContain("pg_try_advisory_lock");
    expect(captured.execute[1]).toContain("pg_advisory_unlock");
    // No finalization (runId never set) and no per-symbol work.
    expect(captured.runUpdateSets).toHaveLength(0);
    expect(captured.txBars).toHaveLength(0);
    expect(source.fetchDailyBars).not.toHaveBeenCalled();
  });

  it("never fails a symbol when metadata enrichment throws (best-effort)", async () => {
    const { db: fakeDb, captured } = createFakeDb({ runInsertId: 9 });
    const source = createSource({ metaThrows: true, barsPerSymbol: 1 });
    const engine = new IngestEngine();

    const result = await engine.runIngest({
      source,
      universe: [UNIVERSE[0]],
      runType: "manual",
      db: fakeDb,
    });

    expect(result.symbolsSucceeded).toBe(1);
    expect(result.recordsUpserted).toBe(1);
    expect(result.failedSymbols).toEqual([]);
    expect(captured.runUpdateSets[0]).toMatchObject({ status: "finished" });
  });
});
