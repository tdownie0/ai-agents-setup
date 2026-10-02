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
