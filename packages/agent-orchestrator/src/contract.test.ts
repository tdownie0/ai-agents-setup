/**
 * Pure unit tests for the decision envelope contract — no DB, no spawn.
 */

import { describe, expect, it } from "vitest";
import {
  DECISION_SCHEMA_VERSION,
  DecisionValidationError,
  MAX_PICKS,
  MIN_PICKS,
  validateEnvelope,
  type DecisionEnvelope,
} from "./contract.js";

const UNIVERSE = [
  "AAPL",
  "MSFT",
  "NVDA",
  "GOOGL",
  "META",
  "AMZN",
  "TSLA",
  "JPM",
  "XOM",
  "KO",
  "PG",
  "JNJ",
  "CAT",
  "V",
  "MA",
];

const SYMBOLS_WITH_PRICE = new Set(UNIVERSE);

function validEnvelope(overrides: Partial<DecisionEnvelope> = {}): DecisionEnvelope {
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    roundId: "round-2026-09-24",
    agent: {
      agentKey: "dr-value",
      persona: "Dr. Value",
      strategy: "deep-value",
      window: "monthly",
      initialCapital: 100000,
    },
    rationale: "Market breadth is stretched; buying quality at a discount.",
    picks: [
      { symbol: "KO", weight: 0.2, thesis: "Oversold staple, 28% off high." },
      { symbol: "PG", weight: 0.2, thesis: "Defensive quality, low vol." },
      { symbol: "JNJ", weight: 0.2, thesis: "Health Care leader stabilizing." },
      { symbol: "XOM", weight: 0.2, thesis: "Hard-asset value with backstop." },
      { symbol: "CAT", weight: 0.2, thesis: "Seller exhaustion after drawdown." },
    ],
    ...overrides,
  };
}

function expectValidationError(
  envelope: unknown,
  expectedFragment: string,
  expectedWindow?: "daily" | "weekly" | "monthly",
): void {
  try {
    validateEnvelope(envelope, {
      universe: UNIVERSE,
      symbolsWithPrice: SYMBOLS_WITH_PRICE,
      ...(expectedWindow === undefined ? {} : { expectedWindow }),
    });
    expect.unreachable(`expected validation to fail with "${expectedFragment}"`);
  } catch (err) {
    expect(err).toBeInstanceOf(DecisionValidationError);
    const message = (err as DecisionValidationError).message;
    expect(message).toContain(expectedFragment);
  }
}

describe("validateEnvelope — happy path", () => {
  it("accepts a fully valid envelope", () => {
    const envelope = validEnvelope();
    const result = validateEnvelope(envelope, {
      universe: UNIVERSE,
      symbolsWithPrice: SYMBOLS_WITH_PRICE,
    });
    expect(result).toEqual(envelope);
  });

  it("accepts exactly MIN_PICKS (5) picks", () => {
    const envelope = validEnvelope();
    expect(envelope.picks).toHaveLength(MIN_PICKS);
    expect(() =>
      validateEnvelope(envelope, {
        universe: UNIVERSE,
        symbolsWithPrice: SYMBOLS_WITH_PRICE,
      }),
    ).not.toThrow();
  });

  it("accepts exactly MAX_PICKS (10) picks", () => {
    const picks = Array.from({ length: MAX_PICKS }, (_, i) => ({
      symbol: UNIVERSE[i],
      weight: 0.1,
      thesis: `Thesis for symbol ${i}.`,
    }));
    const envelope = validEnvelope({ picks });
    expect(() =>
      validateEnvelope(envelope, {
        universe: UNIVERSE,
        symbolsWithPrice: SYMBOLS_WITH_PRICE,
      }),
    ).not.toThrow();
  });

  it("accepts a weight sum of exactly 0.99 (lower tolerance bound)", () => {
    const picks = validEnvelope().picks.map((p, i) => ({
      ...p,
      weight: i === 0 ? 0.19 : p.weight,
    }));
    const envelope = validEnvelope({ picks });
    expect(() =>
      validateEnvelope(envelope, {
        universe: UNIVERSE,
        symbolsWithPrice: SYMBOLS_WITH_PRICE,
      }),
    ).not.toThrow();
  });

  it("accepts a weight sum of exactly 1.01 (upper tolerance bound)", () => {
    const picks = validEnvelope().picks.map((p, i) => ({
      ...p,
      weight: i === 0 ? 0.21 : p.weight,
    }));
    const envelope = validEnvelope({ picks });
    expect(() =>
      validateEnvelope(envelope, {
        universe: UNIVERSE,
        symbolsWithPrice: SYMBOLS_WITH_PRICE,
      }),
    ).not.toThrow();
  });

  it("accepts a replica envelope with replicateOf set", () => {
    const envelope = validEnvelope({
      agent: {
        ...validEnvelope().agent,
        agentKey: "dr-value#rep1",
        replicateOf: "dr-value",
      },
    });
    expect(() =>
      validateEnvelope(envelope, {
        universe: UNIVERSE,
        symbolsWithPrice: SYMBOLS_WITH_PRICE,
      }),
    ).not.toThrow();
  });
});

describe("validateEnvelope — pick count boundaries", () => {
  it("rejects 4 picks (below MIN_PICKS)", () => {
    const envelope = validEnvelope({ picks: validEnvelope().picks.slice(0, 4) });
    expectValidationError(envelope, "at least 5");
  });

  it("rejects 11 picks (above MAX_PICKS)", () => {
    const picks = Array.from({ length: MAX_PICKS + 1 }, (_, i) => ({
      symbol: UNIVERSE[i % UNIVERSE.length],
      weight: 1 / (MAX_PICKS + 1),
      thesis: `Thesis ${i}.`,
    }));
    const envelope = validEnvelope({ picks });
    expectValidationError(envelope, "at most 10");
  });

  it("rejects a non-array picks field", () => {
    const envelope = validEnvelope({
      picks: "not-an-array" as unknown as DecisionEnvelope["picks"],
    });
    expectValidationError(envelope, "picks must be an array");
  });
});

describe("validateEnvelope — weight sum tolerance", () => {
  it("rejects a weight sum of 0.989 (below tolerance)", () => {
    const picks = validEnvelope().picks.map((p, i) => ({
      ...p,
      weight: i === 0 ? 0.189 : p.weight,
    }));
    const envelope = validEnvelope({ picks });
    expectValidationError(envelope, "sum of pick weights");
  });

  it("rejects a weight sum of 1.011 (above tolerance)", () => {
    const picks = validEnvelope().picks.map((p, i) => ({
      ...p,
      weight: i === 0 ? 0.211 : p.weight,
    }));
    const envelope = validEnvelope({ picks });
    expectValidationError(envelope, "sum of pick weights");
  });
});

describe("validateEnvelope — symbol membership", () => {
  it("rejects a symbol not in the universe", () => {
    const envelope = validEnvelope({
      picks: [
        ...validEnvelope().picks.slice(0, 4),
        { symbol: "ZZZZ", weight: 0.2, thesis: "Not a real ticker." },
      ],
    });
    expectValidationError(envelope, "not in the universe");
  });

  it("rejects a symbol in the universe but with no price data as of the decision date", () => {
    const envelope = validEnvelope({
      picks: [
        ...validEnvelope().picks.slice(0, 4),
        { symbol: "MSFT", weight: 0.2, thesis: "No price data." },
      ],
    });
    const symbolsWithPrice = new Set(UNIVERSE.filter((s) => s !== "MSFT"));
    try {
      validateEnvelope(envelope, { universe: UNIVERSE, symbolsWithPrice });
      expect.unreachable('expected validation to fail with "no price data"');
    } catch (err) {
      expect(err).toBeInstanceOf(DecisionValidationError);
      expect((err as DecisionValidationError).message).toContain("no price data");
    }
  });

  it("rejects a duplicated symbol in picks", () => {
    const envelope = validEnvelope({
      picks: [
        ...validEnvelope().picks.slice(0, 4),
        { symbol: "KO", weight: 0.2, thesis: "Duplicate of KO." },
      ],
    });
    expectValidationError(envelope, "duplicated");
  });
});

describe("validateEnvelope — per-pick weight rules", () => {
  it("rejects a weight of 0", () => {
    const envelope = validEnvelope({
      picks: [
        ...validEnvelope().picks.slice(0, 4),
        { symbol: "V", weight: 0, thesis: "Zero weight." },
      ],
    });
    expectValidationError(envelope, "0 < weight <= 1");
  });

  it("rejects a weight greater than 1", () => {
    const envelope = validEnvelope({
      picks: [
        ...validEnvelope().picks.slice(0, 4),
        { symbol: "V", weight: 1.5, thesis: "Overweight." },
      ],
    });
    expectValidationError(envelope, "0 < weight <= 1");
  });

  it("rejects a NaN weight", () => {
    const envelope = validEnvelope({
      picks: [
        ...validEnvelope().picks.slice(0, 4),
        { symbol: "V", weight: Number.NaN, thesis: "NaN weight." },
      ],
    });
    expectValidationError(envelope, "finite number");
  });

  it("rejects an Infinity weight", () => {
    const envelope = validEnvelope({
      picks: [
        ...validEnvelope().picks.slice(0, 4),
        { symbol: "V", weight: Number.POSITIVE_INFINITY, thesis: "Inf weight." },
      ],
    });
    expectValidationError(envelope, "finite number");
  });

  it("rejects a string weight", () => {
    const envelope = validEnvelope({
      picks: [
        ...validEnvelope().picks.slice(0, 4),
        { symbol: "V", weight: "0.2" as unknown as number, thesis: "String weight." },
      ],
    });
    expectValidationError(envelope, "finite number");
  });
});

describe("validateEnvelope — agent fields", () => {
  it("rejects an invalid window", () => {
    const envelope = validEnvelope({
      agent: { ...validEnvelope().agent, window: "yearly" as never },
    });
    expectValidationError(envelope, "window must be one of daily|weekly|monthly");
  });

  it("accepts an envelope whose window matches the round's expectedWindow", () => {
    const envelope = validEnvelope();
    const result = validateEnvelope(envelope, {
      universe: UNIVERSE,
      symbolsWithPrice: SYMBOLS_WITH_PRICE,
      expectedWindow: "monthly",
    });
    expect(result).toEqual(envelope);
  });

  it("rejects a window that contradicts the round's expectedWindow", () => {
    const envelope = validEnvelope();
    expectValidationError(envelope, 'window must be "daily"', "daily");
  });

  it("rejects an agentKey with uppercase letters", () => {
    const envelope = validEnvelope({
      agent: { ...validEnvelope().agent, agentKey: "Dr-Value" },
    });
    expectValidationError(envelope, "must match");
  });

  it("rejects an agentKey shorter than 3 chars", () => {
    const envelope = validEnvelope({
      agent: { ...validEnvelope().agent, agentKey: "ab" },
    });
    expectValidationError(envelope, "must match");
  });

  it("rejects an agentKey with invalid characters", () => {
    const envelope = validEnvelope({
      agent: { ...validEnvelope().agent, agentKey: "dr_value!" },
    });
    expectValidationError(envelope, "must match");
  });

  it("rejects a non-positive initialCapital", () => {
    const envelope = validEnvelope({
      agent: { ...validEnvelope().agent, initialCapital: 0 },
    });
    expectValidationError(envelope, "initialCapital");
  });

  it("rejects a missing agent object", () => {
    const envelope = validEnvelope({ agent: undefined as never });
    expectValidationError(envelope, "agent must be an object");
  });
});

describe("validateEnvelope — envelope-level fields", () => {
  it("rejects a wrong schemaVersion", () => {
    const envelope = validEnvelope({ schemaVersion: 2 });
    expectValidationError(envelope, "schemaVersion must be 1");
  });

  it("rejects a missing roundId", () => {
    const envelope = validEnvelope({ roundId: "" });
    expectValidationError(envelope, "roundId");
  });

  it("rejects a missing rationale", () => {
    const envelope = validEnvelope({ rationale: "" });
    expectValidationError(envelope, "rationale");
  });

  it("rejects a pick with a missing thesis", () => {
    const envelope = validEnvelope({
      picks: [...validEnvelope().picks.slice(0, 4), { symbol: "V", weight: 0.2, thesis: "" }],
    });
    expectValidationError(envelope, "thesis");
  });

  it("rejects a non-object envelope", () => {
    expectValidationError("not-an-object", "envelope must be a JSON object");
    expectValidationError(null, "envelope must be a JSON object");
    expectValidationError([1, 2, 3], "envelope must be a JSON object");
  });
});
