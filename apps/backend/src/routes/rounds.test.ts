/**
 * Pure-function and mount-level tests for the rounds orchestration routes.
 *
 * No database is touched here: every case exercises exported helpers or a
 * fetch() against the Hono app on a route that only reads the dataset file
 * (pointed at a temp dir). DB-backed behavior is covered by the workspace
 * lifecycle verify in the feature environment.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { extractEntryContext } from "@model_md/agent-orchestrator";
import type { AgentRun } from "@model_md/database";
import roundsApp, {
  classifyBooking,
  loadDatasetForRound,
  parseRoundId,
  parseRunInsertBody,
  resolveRoundsDir,
  RoundIdError,
  toDatasetStatusWire,
  toRunStatusWire,
  parseAsOfTradeDate,
  AsOfTradeDateError,
} from "./rounds.js";
import portfolioHandler from "./portfolio.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "rounds-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("parseRoundId", () => {
  it("accepts a plain identifier", () => {
    expect(parseRoundId("round-2026-09-22")).toBe("round-2026-09-22");
  });

  it("accepts dots, dashes, underscores, digits, mixed case", () => {
    expect(parseRoundId("W1.A_2026-09-22")).toBe("W1.A_2026-09-22");
  });

  it("rejects a path traversal attempt", () => {
    expect(() => parseRoundId("../etc/passwd")).toThrow(RoundIdError);
  });

  it("rejects a leading dot", () => {
    expect(() => parseRoundId(".hidden")).toThrow(RoundIdError);
  });

  it("rejects empty and non-string values", () => {
    expect(() => parseRoundId("")).toThrow(RoundIdError);
    expect(() => parseRoundId("   ")).toThrow(RoundIdError);
    expect(() => parseRoundId(42)).toThrow(RoundIdError);
    expect(() => parseRoundId(undefined)).toThrow(RoundIdError);
  });

  it("rejects a leftover slash anywhere", () => {
    expect(() => parseRoundId("a/b")).toThrow(RoundIdError);
  });
});

describe("resolveRoundsDir", () => {
  it("defaults to /app/rounds (backend container cwd = worktree root)", () => {
    expect(resolveRoundsDir({})).toBe("/app/rounds");
  });

  it("honors ROUNDS_DIR when set", () => {
    expect(resolveRoundsDir({ ROUNDS_DIR: "/tmp/rounds" })).toBe("/tmp/rounds");
  });

  it("ignores a blank ROUNDS_DIR", () => {
    expect(resolveRoundsDir({ ROUNDS_DIR: "   " })).toBe("/app/rounds");
  });
});

describe("toDatasetStatusWire", () => {
  it("flags dataReady and rounds coverage to 1dp", () => {
    const wire = toDatasetStatusWire({
      symbols: 49,
      symbolsWithData: 39,
      asOfTradeDate: "2026-09-22",
    });
    expect(wire.dataReady).toBe(true);
    expect(wire.coveragePct).toBe(79.6);
    expect(wire.asOfTradeDate).toBe("2026-09-22");
    expect(typeof wire.generatedAt).toBe("string");
  });

  it("not ready with zero symbols with data", () => {
    const wire = toDatasetStatusWire({ symbols: 49, symbolsWithData: 0, asOfTradeDate: null });
    expect(wire.dataReady).toBe(false);
    expect(wire.coveragePct).toBe(0);
  });
});

describe("toRunStatusWire", () => {
  const startedAt = new Date("2026-09-22T13:00:00.000Z");
  const completedAt = new Date("2026-09-22T13:05:00.000Z");

  function fakeRun(overrides: Partial<AgentRun> = {}): AgentRun {
    return {
      id: 7,
      roundId: "w1",
      agentKey: "dr-value",
      simulationId: null,
      roundSeq: 1,
      persona: "Deep Value",
      strategy: "Fundamental Value",
      window: "monthly",
      initialCapital: "100000.00",
      status: "completed",
      rationale: "Undervalued names",
      decisionJson: { schemaVersion: 1 },
      error: null,
      replicateOf: null,
      startedAt,
      completedAt,
      createdAt: startedAt,
      ...overrides,
    };
  }

  it("serializes dates to ISO strings and keeps raw numeric strings", () => {
    const wire = toRunStatusWire(fakeRun());
    expect(wire.runId).toBe(7);
    expect(wire.status).toBe("completed");
    expect(wire.initialCapital).toBe("100000.00");
    expect(wire.startedAt).toBe("2026-09-22T13:00:00.000Z");
    expect(wire.completedAt).toBe("2026-09-22T13:05:00.000Z");
    expect(wire.createdAt).toBe("2026-09-22T13:00:00.000Z");
    expect(wire.replicateOf).toBeNull();
  });

  it("handles null timestamps", () => {
    const wire = toRunStatusWire(fakeRun({ startedAt: null, completedAt: null }));
    expect(wire.startedAt).toBeNull();
    expect(wire.completedAt).toBeNull();
  });
});

describe("extractEntryContext (shared orchestrator helper)", () => {
  const dataset = {
    schemaVersion: 1,
    roundId: "w1",
    asOfTradeDate: "2026-09-22",
    generatedAt: "2026-09-24T00:00:00.000Z",
    universe: [
      { symbol: "AAPL", hasData: true, latestClose: 150.25 },
      { symbol: "MSFT", hasData: true, latestClose: null },
      { symbol: "TSLA", hasData: false, latestClose: null },
    ],
  };

  it("keeps only symbols with a finite close as entry prices", () => {
    const ctx = extractEntryContext(dataset as never);
    expect(ctx.asOfTradeDate).toBe("2026-09-22");
    expect(ctx.entryPrices).toEqual({ AAPL: 150.25 });
    expect(ctx.symbolsWithPrice.has("AAPL")).toBe(true);
    expect(ctx.symbolsWithPrice.has("MSFT")).toBe(false);
    expect(ctx.universe).toEqual(["AAPL", "MSFT", "TSLA"]);
  });
});

describe("loadDatasetForRound", () => {
  it("loads a persisted dataset", () =>
    withTempDir(async (dir) => {
      const roundId = "w1";
      await mkdir(join(dir, roundId), { recursive: true });
      await writeFile(
        join(dir, roundId, "dataset.json"),
        JSON.stringify({
          schemaVersion: 1,
          roundId,
          asOfTradeDate: "2026-09-22",
          generatedAt: "2026-09-24T00:00:00.000Z",
          universe: [],
        }),
        "utf8",
      );
      const dataset = await loadDatasetForRound(dir, roundId);
      expect(dataset.roundId).toBe("w1");
      expect(dataset.asOfTradeDate).toBe("2026-09-22");
    }));

  it("throws a clear error when the dataset is missing", () =>
    withTempDir(async (dir) => {
      await expect(loadDatasetForRound(dir, "nope")).rejects.toThrow(
        'dataset for round "nope" not found',
      );
    }));

  it("rejects an incompatible schema version", () =>
    withTempDir(async (dir) => {
      const roundId = "w2";
      await mkdir(join(dir, roundId), { recursive: true });
      await writeFile(
        join(dir, roundId, "dataset.json"),
        JSON.stringify({ schemaVersion: 99, roundId, asOfTradeDate: "2026-09-22", universe: [] }),
        "utf8",
      );
      await expect(loadDatasetForRound(dir, roundId)).rejects.toThrow("unexpected shape");
    }));

  it("rejects invalid JSON", () =>
    withTempDir(async (dir) => {
      const roundId = "w3";
      await mkdir(join(dir, roundId), { recursive: true });
      await writeFile(join(dir, roundId, "dataset.json"), "{not json", "utf8");
      await expect(loadDatasetForRound(dir, roundId)).rejects.toThrow("not valid JSON");
    }));
});

describe("parseRunInsertBody", () => {
  it("requires an object body", () => {
    expect(() => parseRunInsertBody(null)).toThrow("must be a JSON object");
    expect(() => parseRunInsertBody([1, 2])).toThrow("must be a JSON object");
  });

  it("requires the envelope key", () => {
    expect(() => parseRunInsertBody({ picks: [] })).toThrow("body.envelope is required");
  });

  it("returns the raw envelope untouched", () => {
    const envelope = { schemaVersion: 1 };
    expect(parseRunInsertBody({ envelope })).toEqual({ envelope });
  });
});

describe("classifyBooking", () => {
  it("rejects a round with no booking row", () => {
    expect(classifyBooking(null)).toEqual({ kind: "unbooked" });
  });

  it("routes a booking with no simulation to the legacy insert path", () => {
    expect(classifyBooking({ simulationId: null, roundSeq: 1, asOfTradeDate: null })).toEqual({
      kind: "legacy",
      roundSeq: 1,
    });
  });

  it("keeps a chained booking's identity for the fold path", () => {
    expect(
      classifyBooking({
        simulationId: "sim-a",
        roundSeq: 4,
        asOfTradeDate: "2026-09-24",
      }),
    ).toEqual({
      kind: "chained",
      simulationId: "sim-a",
      roundSeq: 4,
      asOfTradeDate: "2026-09-24",
    });
  });

  it("rejects a chained booking with no decide date to mark against", () => {
    expect(classifyBooking({ simulationId: "sim-a", roundSeq: 4, asOfTradeDate: null })).toEqual({
      kind: "undated",
      simulationId: "sim-a",
      roundSeq: 4,
    });
  });

  it("treats a dated booking as chained even at round 1", () => {
    expect(
      classifyBooking({ simulationId: "sim-a", roundSeq: 1, asOfTradeDate: "2026-09-24" }),
    ).toEqual({
      kind: "chained",
      simulationId: "sim-a",
      roundSeq: 1,
      asOfTradeDate: "2026-09-24",
    });
  });
});

describe("rounds mount", () => {
  it("coexists with the portfolio handler on the same prefix", () => {
    expect(() =>
      new Hono().route("/portfolio", portfolioHandler).route("/portfolio", roundsApp),
    ).not.toThrow();
  });

  it("GET /portfolio/rounds/:roundId/dataset returns 404 with a build hint when absent", async () => {
    const app = new Hono().route("/portfolio", roundsApp);
    const res = await app.request("/portfolio/rounds/empty-round/dataset", { method: "GET" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toContain("not found");
    expect(body.hint).toContain("POST /api/portfolio/rounds/empty-round/dataset");
  });

  it("GET /portfolio/rounds/:roundId/dataset returns the persisted payload when present", async () => {
    const app = new Hono().route("/portfolio", roundsApp);
    await withTempDir(async (dir) => {
      const roundId = "w-ready";
      await mkdir(join(dir, roundId), { recursive: true });
      await writeFile(
        join(dir, roundId, "dataset.json"),
        JSON.stringify({
          schemaVersion: 1,
          roundId,
          asOfTradeDate: "2026-09-22",
          generatedAt: "2026-09-24T00:00:00.000Z",
          universe: [],
        }),
        "utf8",
      );
      process.env.ROUNDS_DIR = dir;
      try {
        const res = await app.request(`/portfolio/rounds/${roundId}/dataset`, { method: "GET" });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { roundId: string; asOfTradeDate: string };
        expect(body.roundId).toBe(roundId);
        expect(body.asOfTradeDate).toBe("2026-09-22");
      } finally {
        delete process.env.ROUNDS_DIR;
      }
    });
  });

  it("GET /portfolio/rounds/:roundId/dataset rejects a traversal roundId with 400", async () => {
    const app = new Hono().route("/portfolio", roundsApp);
    const res = await app.request("/portfolio/rounds/..%2F..%2Fetc/dataset", { method: "GET" });
    expect(res.status).toBe(400);
  });
});

describe("parseAsOfTradeDate", () => {
  it("returns undefined for absent or null values", () => {
    expect(parseAsOfTradeDate(undefined)).toBeUndefined();
    expect(parseAsOfTradeDate(null)).toBeUndefined();
  });

  it("accepts a strict YYYY-MM-DD string", () => {
    expect(parseAsOfTradeDate("2026-09-22")).toBe("2026-09-22");
    expect(parseAsOfTradeDate(" 2026-09-22 ")).toBe("2026-09-22");
  });

  it("rejects non-string values", () => {
    expect(() => parseAsOfTradeDate(42)).toThrow(AsOfTradeDateError);
    expect(() => parseAsOfTradeDate({})).toThrow(AsOfTradeDateError);
    expect(() => parseAsOfTradeDate([])).toThrow(AsOfTradeDateError);
  });

  it("rejects malformed formats", () => {
    expect(() => parseAsOfTradeDate("09/22/2026")).toThrow(AsOfTradeDateError);
    expect(() => parseAsOfTradeDate("2026-9-22")).toThrow(AsOfTradeDateError);
    expect(() => parseAsOfTradeDate("2026-09-2")).toThrow(AsOfTradeDateError);
  });

  it("rejects invalid calendar dates", () => {
    expect(() => parseAsOfTradeDate("2026-02-30")).toThrow(AsOfTradeDateError);
    expect(() => parseAsOfTradeDate("2026-13-01")).toThrow(AsOfTradeDateError);
    expect(() => parseAsOfTradeDate("2026-00-01")).toThrow(AsOfTradeDateError);
  });
});
