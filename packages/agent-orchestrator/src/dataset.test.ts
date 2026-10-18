/**
 * Unit tests for the analyst dataset builder's as-of pinning.
 *
 * The DB is mocked at the module boundary: `buildDataset` reads the global
 * latest trade_date and per-symbol bars through the `db` singleton, so the
 * fake below answers both query shapes (the MAX probe and the per-symbol
 * `trade_date <= asOf` fetch) from an in-memory bar table. No Postgres.
 */

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeBar {
  symbol: string;
  tradeDate: string;
  close: number;
  adjClose: number | null;
  volume: number | null;
}

const state = vi.hoisted(() => ({ bars: [] as FakeBar[] }));

vi.mock("@model_md/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@model_md/database")>();
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();

  const select = () => {
    let joined = false;
    let whereParams: unknown[] = [];
    const chain = {
      from: () => chain,
      innerJoin: () => {
        joined = true;
        return chain;
      },
      where: (condition: unknown) => {
        try {
          whereParams = dialect.sqlToQuery(condition as never).params;
        } catch {
          whereParams = [];
        }
        return chain;
      },
      orderBy: () => chain,
      limit: () => {
        if (!joined) {
          const max = state.bars.reduce((m, b) => (b.tradeDate > m ? b.tradeDate : m), "");
          return Promise.resolve(max === "" ? [] : [{ maxTradeDate: max }]);
        }
        const [symbol, asOf] = whereParams as [string, string];
        const rows = state.bars
          .filter((b) => b.symbol === symbol && b.tradeDate <= asOf)
          .sort((a, b) => (a.tradeDate < b.tradeDate ? 1 : -1))
          .slice(0, 300)
          .map((b) => ({
            tradeDate: b.tradeDate,
            close: String(b.close),
            adjClose: b.adjClose === null ? null : String(b.adjClose),
            volume: b.volume,
          }));
        return Promise.resolve(rows);
      },
    };
    return chain;
  };

  return { ...actual, db: { select } };
});

import { buildDataset } from "./dataset.js";

function bar(symbol: string, tradeDate: string, close: number): FakeBar {
  return { symbol, tradeDate, close, adjClose: close, volume: 1000 };
}

function isoDate(dayOffset: number): string {
  const d = new Date(Date.UTC(2023, 0, 1 + dayOffset));
  return d.toISOString().slice(0, 10);
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dataset-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function cachePathFor(dir: string, asOfTradeDate: string): string {
  return join(dir, ".dataset-cache", `${asOfTradeDate}.json`);
}

beforeEach(() => {
  state.bars = [];
});

describe("buildDataset as-of pinning", () => {
  it("defaults asOfTradeDate to the global MAX trade_date when no pin is given", async () => {
    state.bars = [
      bar("AAPL", "2024-01-02", 100),
      bar("AAPL", "2024-01-05", 105),
      bar("MSFT", "2024-01-04", 200),
    ];
    await withTempDir(async (dir) => {
      const { dataset, summary } = await buildDataset({ roundId: "w1", outDir: dir });
      expect(dataset.asOfTradeDate).toBe("2024-01-05");
      expect(summary.asOfTradeDate).toBe("2024-01-05");
    });
  });

  it("uses the pinned asOfTradeDate verbatim", async () => {
    state.bars = [bar("AAPL", "2024-01-02", 100), bar("AAPL", "2024-01-05", 105)];
    await withTempDir(async (dir) => {
      const { dataset } = await buildDataset({
        roundId: "w1",
        outDir: dir,
        asOfTradeDate: "2024-01-03",
      });
      expect(dataset.asOfTradeDate).toBe("2024-01-03");
    });
  });

  it("masks post-pin bars from every derived metric", async () => {
    const pre = Array.from({ length: 10 }, (_, i) =>
      bar("AAPL", `2024-01-${String(i + 1).padStart(2, "0")}`, 100 + i),
    );
    const post = bar("AAPL", "2024-01-11", 999);
    state.bars = [...pre, post];
    await withTempDir(async (dir) => {
      const { dataset } = await buildDataset({
        roundId: "w1",
        outDir: dir,
        asOfTradeDate: "2024-01-10",
      });
      const aapl = dataset.universe.find((u) => u.symbol === "AAPL")!;
      expect(aapl.latestClose).toBe(109);
      expect(aapl.returns1d).toBeCloseTo((109 / 108 - 1) * 100, 2);
      expect(aapl.high52w).toBe(109);
    });
  });

  it("keeps sma50AboveSma200 false when pinning masks a post-pin crossover", async () => {
    const pre = Array.from({ length: 200 }, (_, i) => bar("AAPL", isoDate(i), 100));
    const post = Array.from({ length: 50 }, (_, i) => bar("AAPL", isoDate(200 + i), 1000));
    state.bars = [...pre, post];
    await withTempDir(async (dir) => {
      const { dataset } = await buildDataset({
        roundId: "w1",
        outDir: dir,
        asOfTradeDate: isoDate(199),
      });
      const aapl = dataset.universe.find((u) => u.symbol === "AAPL")!;
      expect(aapl.sma50AboveSma200).toBe(false);
    });
  });

  it("throws when the pinned date predates every ingested bar", async () => {
    state.bars = [bar("AAPL", "2024-01-02", 100)];
    await withTempDir(async (dir) => {
      await expect(
        buildDataset({ roundId: "w1", outDir: dir, asOfTradeDate: "2020-01-01" }),
      ).rejects.toThrow(/No daily price data found on or before 2020-01-01/);
    });
  });

  it("rejects a malformed asOfTradeDate", async () => {
    await withTempDir(async (dir) => {
      await expect(
        buildDataset({ roundId: "w1", outDir: dir, asOfTradeDate: "01/02/2024" }),
      ).rejects.toThrow(/YYYY-MM-DD/);
      await expect(
        buildDataset({ roundId: "w1", outDir: dir, asOfTradeDate: "2024-13-40" }),
      ).rejects.toThrow(/valid calendar date/);
    });
  });

  it("throws the existing no-data error when the table is empty", async () => {
    state.bars = [];
    await withTempDir(async (dir) => {
      await expect(buildDataset({ roundId: "w1", outDir: dir })).rejects.toThrow(
        /No daily price data found/,
      );
    });
  });
});

describe("buildDataset per-date dataset cache", () => {
  const AS_OF = "2024-01-10";

  beforeEach(() => {
    state.bars = [
      bar("AAPL", "2024-01-09", 100),
      bar("AAPL", "2024-01-10", 110),
      bar("MSFT", "2024-01-10", 200),
    ];
  });

  it("reuses the cached universe for the same pinned date instead of re-querying the DB", async () => {
    await withTempDir(async (dir) => {
      const first = await buildDataset({ roundId: "r1", outDir: dir, asOfTradeDate: AS_OF });
      expect(first.summary.cached).toBe(false);
      const firstUniverse = structuredClone(first.dataset.universe);

      state.bars = [bar("AAPL", "2024-01-10", 9999), bar("MSFT", "2024-01-10", 1)];

      const second = await buildDataset({ roundId: "r2", outDir: dir, asOfTradeDate: AS_OF });
      expect(second.summary.cached).toBe(true);
      expect(second.dataset.universe).toEqual(firstUniverse);
      expect(second.dataset.universe.find((u) => u.symbol === "AAPL")?.latestClose).toBe(110);
    });
  });

  it("rebuilds the per-round dataset.json with the NEW roundId on a cache hit", async () => {
    await withTempDir(async (dir) => {
      await buildDataset({ roundId: "r1", outDir: dir, asOfTradeDate: AS_OF });
      const second = await buildDataset({ roundId: "r2", outDir: dir, asOfTradeDate: AS_OF });

      expect(second.summary.cached).toBe(true);
      expect(second.dataset.roundId).toBe("r2");
      expect(second.summary.datasetPath).toBe(join(dir, "r2", "dataset.json"));

      const written = JSON.parse(await readFile(join(dir, "r2", "dataset.json"), "utf8")) as Record<
        string,
        unknown
      >;
      expect(written.roundId).toBe("r2");
      expect(written.asOfTradeDate).toBe(AS_OF);
      expect(typeof written.generatedAt).toBe("string");
      expect(Array.isArray(written.universe)).toBe(true);
    });
  });

  it("invalidates the cache when the cached schemaVersion does not match", async () => {
    await withTempDir(async (dir) => {
      await buildDataset({ roundId: "r1", outDir: dir, asOfTradeDate: AS_OF });

      const cachePath = cachePathFor(dir, AS_OF);
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as Record<string, unknown>;
      cached.schemaVersion = 999;
      await writeFile(cachePath, JSON.stringify(cached), "utf8");

      state.bars = [bar("AAPL", "2024-01-10", 555)];

      const second = await buildDataset({ roundId: "r2", outDir: dir, asOfTradeDate: AS_OF });
      expect(second.summary.cached).toBe(false);
      expect(second.dataset.universe.find((u) => u.symbol === "AAPL")?.latestClose).toBe(555);
    });
  });

  it("invalidates the cache when the universeFingerprint does not match", async () => {
    await withTempDir(async (dir) => {
      await buildDataset({ roundId: "r1", outDir: dir, asOfTradeDate: AS_OF });

      const cachePath = cachePathFor(dir, AS_OF);
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as Record<string, unknown>;
      cached.universeFingerprint = "not-the-current-universe-hash";
      await writeFile(cachePath, JSON.stringify(cached), "utf8");

      state.bars = [bar("AAPL", "2024-01-10", 777)];

      const second = await buildDataset({ roundId: "r2", outDir: dir, asOfTradeDate: AS_OF });
      expect(second.summary.cached).toBe(false);
      expect(second.dataset.universe.find((u) => u.symbol === "AAPL")?.latestClose).toBe(777);
    });
  });

  it("treats a corrupt cache file as a miss and still builds", async () => {
    await withTempDir(async (dir) => {
      const cachePath = cachePathFor(dir, AS_OF);
      await mkdir(join(dir, ".dataset-cache"), { recursive: true });
      await writeFile(cachePath, "{ this is not json", "utf8");

      const result = await buildDataset({ roundId: "r1", outDir: dir, asOfTradeDate: AS_OF });
      expect(result.summary.cached).toBe(false);
      expect(result.dataset.universe.length).toBeGreaterThan(0);
      expect(result.summary.symbolsWithData).toBeGreaterThan(0);
    });
  });

  it("neither reads nor writes the cache when useCache is false", async () => {
    await withTempDir(async (dir) => {
      const first = await buildDataset({
        roundId: "r1",
        outDir: dir,
        asOfTradeDate: AS_OF,
        useCache: false,
      });
      expect(first.summary.cached).toBe(false);
      await expect(access(cachePathFor(dir, AS_OF))).rejects.toThrow();

      state.bars = [bar("AAPL", "2024-01-10", 42)];

      const second = await buildDataset({
        roundId: "r2",
        outDir: dir,
        asOfTradeDate: AS_OF,
        useCache: false,
      });
      expect(second.summary.cached).toBe(false);
      expect(second.dataset.universe.find((u) => u.symbol === "AAPL")?.latestClose).toBe(42);
      await expect(access(cachePathFor(dir, AS_OF))).rejects.toThrow();
    });
  });

  it("throws the predates-every-bar error and leaves no cache file behind", async () => {
    await withTempDir(async (dir) => {
      await expect(
        buildDataset({ roundId: "r1", outDir: dir, asOfTradeDate: "2020-01-01" }),
      ).rejects.toThrow(/predates every ingested bar/);
      await expect(access(cachePathFor(dir, "2020-01-01"))).rejects.toThrow();
    });
  });

  it("does not use the cache on the unpinned/live path", async () => {
    await withTempDir(async (dir) => {
      const first = await buildDataset({ roundId: "r1", outDir: dir });
      expect(first.summary.cached).toBe(false);
      expect(first.dataset.asOfTradeDate).toBe(AS_OF);
      await expect(access(cachePathFor(dir, AS_OF))).rejects.toThrow();

      state.bars = [bar("AAPL", "2024-01-10", 42)];

      const second = await buildDataset({ roundId: "r2", outDir: dir });
      expect(second.summary.cached).toBe(false);
      expect(second.dataset.universe.find((u) => u.symbol === "AAPL")?.latestClose).toBe(42);
      await expect(access(cachePathFor(dir, AS_OF))).rejects.toThrow();

      await buildDataset({ roundId: "p1", outDir: dir, asOfTradeDate: AS_OF });
      await expect(access(cachePathFor(dir, AS_OF))).resolves.toBeUndefined();

      state.bars = [bar("AAPL", "2024-01-10", 7)];

      const live = await buildDataset({ roundId: "r3", outDir: dir });
      expect(live.summary.cached).toBe(false);
      expect(live.dataset.universe.find((u) => u.symbol === "AAPL")?.latestClose).toBe(7);
    });
  });
});
