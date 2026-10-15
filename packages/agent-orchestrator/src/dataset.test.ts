/**
 * Unit tests for the analyst dataset builder's as-of pinning.
 *
 * The DB is mocked at the module boundary: `buildDataset` reads the global
 * latest trade_date and per-symbol bars through the `db` singleton, so the
 * fake below answers both query shapes (the MAX probe and the per-symbol
 * `trade_date <= asOf` fetch) from an in-memory bar table. No Postgres.
 */

import { mkdtemp, rm } from "node:fs/promises";
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

beforeEach(() => {
  state.bars = [];
});

describe("buildDataset as-of pinning", () => {
  it("defaults asOfTradeDate to the global MAX trade_date when no pin is given", async () => {
    state.bars = [bar("AAPL", "2024-01-02", 100), bar("AAPL", "2024-01-05", 105), bar("MSFT", "2024-01-04", 200)];
    await withTempDir(async (dir) => {
      const { dataset, summary } = await buildDataset({ roundId: "w1", outDir: dir });
      expect(dataset.asOfTradeDate).toBe("2024-01-05");
      expect(summary.asOfTradeDate).toBe("2024-01-05");
    });
  });

  it("uses the pinned asOfTradeDate verbatim", async () => {
    state.bars = [bar("AAPL", "2024-01-02", 100), bar("AAPL", "2024-01-05", 105)];
    await withTempDir(async (dir) => {
      const { dataset } = await buildDataset({ roundId: "w1", outDir: dir, asOfTradeDate: "2024-01-03" });
      expect(dataset.asOfTradeDate).toBe("2024-01-03");
    });
  });

  it("masks post-pin bars from every derived metric", async () => {
    const pre = Array.from({ length: 10 }, (_, i) => bar("AAPL", `2024-01-${String(i + 1).padStart(2, "0")}`, 100 + i));
    const post = bar("AAPL", "2024-01-11", 999);
    state.bars = [...pre, post];
    await withTempDir(async (dir) => {
      const { dataset } = await buildDataset({ roundId: "w1", outDir: dir, asOfTradeDate: "2024-01-10" });
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
      const { dataset } = await buildDataset({ roundId: "w1", outDir: dir, asOfTradeDate: isoDate(199) });
      const aapl = dataset.universe.find((u) => u.symbol === "AAPL")!;
      expect(aapl.sma50AboveSma200).toBe(false);
    });
  });

  it("throws when the pinned date predates every ingested bar", async () => {
    state.bars = [bar("AAPL", "2024-01-02", 100)];
    await withTempDir(async (dir) => {
      await expect(buildDataset({ roundId: "w1", outDir: dir, asOfTradeDate: "2020-01-01" })).rejects.toThrow(
        /No daily price data found on or before 2020-01-01/,
      );
    });
  });

  it("rejects a malformed asOfTradeDate", async () => {
    await withTempDir(async (dir) => {
      await expect(buildDataset({ roundId: "w1", outDir: dir, asOfTradeDate: "01/02/2024" })).rejects.toThrow(/YYYY-MM-DD/);
      await expect(buildDataset({ roundId: "w1", outDir: dir, asOfTradeDate: "2024-13-40" })).rejects.toThrow(/valid calendar date/);
    });
  });

  it("throws the existing no-data error when the table is empty", async () => {
    state.bars = [];
    await withTempDir(async (dir) => {
      await expect(buildDataset({ roundId: "w1", outDir: dir })).rejects.toThrow(/No daily price data found/);
    });
  });
});
