/**
 * Pure-function tests for the carryover routes.
 *
 * No database is touched: every case exercises the exported body parser. The
 * DB-backed create path (insert + 409 on a taken handle) is covered by the
 * workspace lifecycle verify in the feature environment.
 */

import { describe, expect, it } from "vitest";
import { parseCreateSimulationBody } from "./portfolioCarryover.js";

describe("parseCreateSimulationBody", () => {
  it("accepts a minimal payload and defaults capital and label", () => {
    expect(parseCreateSimulationBody({ simId: "sim-baseline" })).toEqual({
      simId: "sim-baseline",
      label: null,
      initialCapital: 100000,
    });
  });

  it("keeps an explicit chain basis and trims the handle", () => {
    expect(
      parseCreateSimulationBody({
        simId: "  sim-alt-2  ",
        label: "  Alt book  ",
        initialCapital: 25000,
      }),
    ).toEqual({ simId: "sim-alt-2", label: "Alt book", initialCapital: 25000 });
  });

  it("treats a blank label as absent", () => {
    expect(parseCreateSimulationBody({ simId: "sim-x", label: "   " }).label).toBeNull();
  });

  it("rejects a body that is not an object", () => {
    expect(() => parseCreateSimulationBody(null)).toThrow(/must be a JSON object/);
    expect(() => parseCreateSimulationBody([{ simId: "sim-x" }])).toThrow(/must be a JSON object/);
    expect(() => parseCreateSimulationBody("sim-x")).toThrow(/must be a JSON object/);
  });

  it("enforces the simId pattern", () => {
    for (const bad of ["baseline", "SIM-baseline", "-sim-x", "sim-BAD", "sim-", 42, null]) {
      expect(() => parseCreateSimulationBody({ simId: bad })).toThrow(/body\.simId must match/);
    }
  });

  it("rejects a non-positive or non-finite chain basis", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "100000"]) {
      expect(() => parseCreateSimulationBody({ simId: "sim-x", initialCapital: bad })).toThrow(
        /body\.initialCapital must be a positive number/,
      );
    }
  });

  it("rejects a non-string label", () => {
    expect(() => parseCreateSimulationBody({ simId: "sim-x", label: 7 })).toThrow(
      /body\.label must be a string/,
    );
  });

  it("accepts an explicit null label", () => {
    expect(parseCreateSimulationBody({ simId: "sim-x", label: null }).label).toBeNull();
  });
});

import { planChainRebuild } from "../portfolio/carryoverPlan.js";
import type { StreamKey } from "../portfolio/carryoverPlan.js";
import { parseRoundSeq, toSnapshotStream } from "./portfolioCarryover.js";

describe("parseRoundSeq", () => {
  it("accepts positive chain positions", () => {
    expect(parseRoundSeq("1")).toEqual({ roundSeq: 1 });
    expect(parseRoundSeq(" 12 ")).toEqual({ roundSeq: 12 });
  });

  it("rejects anything that is not a positive integer", () => {
    for (const bad of ["0", "-1", "1.5", "1e3", "abc", "", " ", "1,2", undefined]) {
      expect(parseRoundSeq(bad)).toHaveProperty("error");
    }
  });
});

describe("toSnapshotStream", () => {
  const key: StreamKey = {
    simulationId: "sim-baseline",
    personaKey: "dr-value",
    window: "daily",
  };
  const labels = new Map([["dr-value", { persona: "Value", strategy: "Deep value" }]]);
  const bars = new Map([
    [
      "AAA",
      [
        { tradeDate: "2026-10-01", close: 100 },
        { tradeDate: "2026-10-02", close: 110 },
        { tradeDate: "2026-10-03", close: 121 },
      ],
    ],
  ]);
  const round = (roundSeq: number, decideTradeDate: string) => ({
    roundId: `sim-baseline-000${roundSeq}`,
    roundSeq,
    decideTradeDate,
    targets: [{ symbol: "AAA", targetWeight: 1 }],
  });

  it("reports a stream that had not folded yet as untouched basis, not a total loss", () => {
    const plan = planChainRebuild({ key, basisCapital: 1000, rounds: [], bars });
    const row = toSnapshotStream(key, plan, 1000, labels, "2026-10-03");
    expect(row.seq).toBe(0);
    expect(row.cash).toBe(1000);
    expect(row.totalValue).toBe(1000);
    expect(row.returnPct).toBe(0);
    expect(row.openLots).toBe(0);
  });

  it("freezes the book at the requested round instead of the newest one", () => {
    const rounds = [round(1, "2026-10-01"), round(2, "2026-10-03")];
    const at1 = planChainRebuild({
      key,
      basisCapital: 1000,
      rounds: rounds.filter((r) => r.roundSeq <= 1),
      bars,
    });
    const at2 = planChainRebuild({ key, basisCapital: 1000, rounds, bars });

    const row1 = toSnapshotStream(key, at1, 1000, labels, "2026-10-01");
    const row2 = toSnapshotStream(key, at2, 1000, labels, "2026-10-03");

    expect(row1.seq).toBe(1);
    expect(row2.seq).toBe(2);
    expect(row1.totalValue).toBe(1000);
    expect(row2.totalValue).toBeCloseTo(1210, 6);
    expect(row1.openLots).toBe(1);
    expect(row1.agentKey).toBe("dr-value--daily");
    expect(row1.persona).toBe("Value");
  });
});
