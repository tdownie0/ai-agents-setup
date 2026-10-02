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

/** A stream's first round: it holds nothing, so the omission rule is vacuous. */
const NO_HOLDINGS: ReadonlySet<string> = new Set();

/** Validators for the default case, so each test states only what it varies. */
const BASE_OPTS = {
  universe: UNIVERSE,
  symbolsWithPrice: SYMBOLS_WITH_PRICE,
  heldSymbols: NO_HOLDINGS,
} as const;

function validEnvelope(overrides: Partial<DecisionEnvelope> = {}): DecisionEnvelope {
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    roundId: "round-2026-09-24",
    simulationId: "sim-baseline",
    roundSeq: 1,
    agent: {
      agentKey: "dr-value",
      persona: "Dr. Value",
      strategy: "deep-value",
      window: "monthly",
      portfolioValue: 100000,
      cash: 0,
      holdingsValue: 0,
      priorRoundId: null,
      roundSeq: 1,
    },
    rationale: "Market breadth is stretched; buying quality at a discount.",
    positions: [
      { symbol: "KO", targetWeight: 0.2, thesis: "Oversold staple, 28% off high." },
      { symbol: "PG", targetWeight: 0.2, thesis: "Defensive quality, low vol." },
      { symbol: "JNJ", targetWeight: 0.2, thesis: "Health Care leader stabilizing." },
      { symbol: "XOM", targetWeight: 0.2, thesis: "Hard-asset value with backstop." },
      { symbol: "CAT", targetWeight: 0.2, thesis: "Seller exhaustion after drawdown." },
    ],
    ...overrides,
  };
}

function expectValidationError(
  envelope: unknown,
  expectedFragment: string,
  expectedWindow?: "daily" | "weekly" | "monthly",
  heldSymbols: ReadonlySet<string> = NO_HOLDINGS,
): void {
  try {
    validateEnvelope(envelope, {
      ...BASE_OPTS,
      heldSymbols,
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
      ...BASE_OPTS,
    });
    expect(result).toEqual(envelope);
  });

  it("accepts exactly MIN_PICKS (5) positions", () => {
    const envelope = validEnvelope();
    expect(envelope.positions).toHaveLength(MIN_PICKS);
    expect(() =>
      validateEnvelope(envelope, {
        ...BASE_OPTS,
      }),
    ).not.toThrow();
  });

  it("accepts exactly MAX_PICKS (10) positions", () => {
    const positions = Array.from({ length: MAX_PICKS }, (_, i) => ({
      symbol: UNIVERSE[i],
      targetWeight: 0.1,
      thesis: `Thesis for symbol ${i}.`,
    }));
    const envelope = validEnvelope({ positions });
    expect(() =>
      validateEnvelope(envelope, {
        ...BASE_OPTS,
      }),
    ).not.toThrow();
  });

  it("accepts a weight sum of exactly 0.99 (lower tolerance bound)", () => {
    const positions = validEnvelope().positions.map((p, i) => ({
      ...p,
      targetWeight: i === 0 ? 0.19 : p.targetWeight,
    }));
    const envelope = validEnvelope({ positions });
    expect(() =>
      validateEnvelope(envelope, {
        ...BASE_OPTS,
      }),
    ).not.toThrow();
  });

  it("accepts a weight sum of exactly 1.01 (upper tolerance bound)", () => {
    const positions = validEnvelope().positions.map((p, i) => ({
      ...p,
      targetWeight: i === 0 ? 0.21 : p.targetWeight,
    }));
    const envelope = validEnvelope({ positions });
    expect(() =>
      validateEnvelope(envelope, {
        ...BASE_OPTS,
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
        ...BASE_OPTS,
      }),
    ).not.toThrow();
  });
});

describe("validateEnvelope — position count boundaries", () => {
  it("rejects 4 positions (below MIN_PICKS)", () => {
    const envelope = validEnvelope({ positions: validEnvelope().positions.slice(0, 4) });
    expectValidationError(envelope, "at least 5");
  });

  it("rejects 11 positions (above MAX_PICKS)", () => {
    const positions = Array.from({ length: MAX_PICKS + 1 }, (_, i) => ({
      symbol: UNIVERSE[i % UNIVERSE.length],
      targetWeight: 1 / (MAX_PICKS + 1),
      thesis: `Thesis ${i}.`,
    }));
    const envelope = validEnvelope({ positions });
    expectValidationError(envelope, "at most 10");
  });

  it("rejects a non-array positions field", () => {
    const envelope = validEnvelope({
      positions: "not-an-array" as unknown as DecisionEnvelope["positions"],
    });
    expectValidationError(envelope, "positions must be an array");
  });
});

describe("validateEnvelope — weight sum tolerance", () => {
  it("rejects a weight sum of 0.989 (below tolerance)", () => {
    const positions = validEnvelope().positions.map((p, i) => ({
      ...p,
      targetWeight: i === 0 ? 0.189 : p.targetWeight,
    }));
    const envelope = validEnvelope({ positions });
    expectValidationError(envelope, "sum of buy targetWeights");
  });

  it("rejects a weight sum of 1.011 (above tolerance)", () => {
    const positions = validEnvelope().positions.map((p, i) => ({
      ...p,
      targetWeight: i === 0 ? 0.211 : p.targetWeight,
    }));
    const envelope = validEnvelope({ positions });
    expectValidationError(envelope, "sum of buy targetWeights");
  });
});

describe("validateEnvelope — symbol membership", () => {
  it("rejects a symbol not in the universe", () => {
    const envelope = validEnvelope({
      positions: [
        ...validEnvelope().positions.slice(0, 4),
        { symbol: "ZZZZ", targetWeight: 0.2, thesis: "Not a real ticker." },
      ],
    });
    expectValidationError(envelope, "not in the universe");
  });

  it("rejects a symbol in the universe but with no price data as of the decision date", () => {
    const envelope = validEnvelope({
      positions: [
        ...validEnvelope().positions.slice(0, 4),
        { symbol: "MSFT", targetWeight: 0.2, thesis: "No price data." },
      ],
    });
    const symbolsWithPrice = new Set(UNIVERSE.filter((s) => s !== "MSFT"));
    try {
      validateEnvelope(envelope, { ...BASE_OPTS, symbolsWithPrice });
      expect.unreachable('expected validation to fail with "no price data"');
    } catch (err) {
      expect(err).toBeInstanceOf(DecisionValidationError);
      expect((err as DecisionValidationError).message).toContain("no price data");
    }
  });

  it("rejects a duplicated symbol in positions", () => {
    const envelope = validEnvelope({
      positions: [
        ...validEnvelope().positions.slice(0, 4),
        { symbol: "KO", targetWeight: 0.2, thesis: "Duplicate of KO." },
      ],
    });
    expectValidationError(envelope, "duplicated");
  });
});

describe("validateEnvelope — per-position targetWeight rules", () => {
  it("rejects a targetWeight greater than 1", () => {
    const envelope = validEnvelope({
      positions: [
        ...validEnvelope().positions.slice(0, 4),
        { symbol: "V", targetWeight: 1.5, thesis: "Overweight." },
      ],
    });
    expectValidationError(envelope, "0 <= targetWeight <= 1");
  });

  it("rejects a negative targetWeight", () => {
    const envelope = validEnvelope({
      positions: [
        ...validEnvelope().positions.slice(0, 4),
        { symbol: "V", targetWeight: -0.1, thesis: "Negative weight." },
      ],
    });
    expectValidationError(envelope, "0 <= targetWeight <= 1");
  });

  it("rejects a NaN targetWeight", () => {
    const envelope = validEnvelope({
      positions: [
        ...validEnvelope().positions.slice(0, 4),
        { symbol: "V", targetWeight: Number.NaN, thesis: "NaN weight." },
      ],
    });
    expectValidationError(envelope, "finite number");
  });

  it("rejects an Infinity targetWeight", () => {
    const envelope = validEnvelope({
      positions: [
        ...validEnvelope().positions.slice(0, 4),
        { symbol: "V", targetWeight: Number.POSITIVE_INFINITY, thesis: "Inf weight." },
      ],
    });
    expectValidationError(envelope, "finite number");
  });

  it("rejects a string targetWeight", () => {
    const envelope = validEnvelope({
      positions: [
        ...validEnvelope().positions.slice(0, 4),
        { symbol: "V", targetWeight: "0.2" as unknown as number, thesis: "String weight." },
      ],
    });
    expectValidationError(envelope, "finite number");
  });
});

describe("validateEnvelope — sells (targetWeight === 0)", () => {
  const HELD: ReadonlySet<string> = new Set(["KO", "PG", "JNJ", "XOM", "CAT", "V"]);

  it("accepts a targetWeight of 0 as a liquidation of a held symbol", () => {
    const envelope = validEnvelope({
      positions: [
        ...validEnvelope().positions,
        { symbol: "V", targetWeight: 0, thesis: "Trend structure failed; exiting." },
      ],
    });
    expect(() => validateEnvelope(envelope, { ...BASE_OPTS, heldSymbols: HELD })).not.toThrow();
  });

  it("accepts a sell of a symbol that has no price as of the decision date", () => {
    const envelope = validEnvelope({
      positions: [
        ...validEnvelope().positions,
        { symbol: "V", targetWeight: 0, thesis: "Delisted from the feed; exiting anyway." },
      ],
    });
    const symbolsWithPrice = new Set(UNIVERSE.filter((s) => s !== "V"));
    expect(() =>
      validateEnvelope(envelope, { ...BASE_OPTS, symbolsWithPrice, heldSymbols: HELD }),
    ).not.toThrow();
  });

  it("accepts a sell of a symbol that is not in the universe at all", () => {
    const envelope = validEnvelope({
      positions: [
        ...validEnvelope().positions,
        { symbol: "V", targetWeight: 0, thesis: "Left the universe; exiting anyway." },
      ],
    });
    const universe = UNIVERSE.filter((s) => s !== "V");
    expect(() =>
      validateEnvelope(envelope, { ...BASE_OPTS, universe, heldSymbols: HELD }),
    ).not.toThrow();
  });

  it("rejects a sell of a symbol the stream does not hold", () => {
    const envelope = validEnvelope({
      positions: [
        ...validEnvelope().positions,
        { symbol: "V", targetWeight: 0, thesis: "Never held; cannot exit." },
      ],
    });
    const heldSymbols: ReadonlySet<string> = new Set(["KO", "PG", "JNJ", "XOM", "CAT"]);
    expectValidationError(envelope, "not in heldSymbols", undefined, heldSymbols);
  });

  it("does not count sell lines toward MIN_PICKS", () => {
    const envelope = validEnvelope({
      positions: [
        ...validEnvelope().positions.slice(0, 4),
        { symbol: "V", targetWeight: 0, thesis: "Exit." },
      ],
    });
    expectValidationError(envelope, "at least 5", undefined, HELD);
  });

  it("rejects a buy of a symbol with no price as of the decision date", () => {
    const envelope = validEnvelope({
      positions: [
        ...validEnvelope().positions.slice(0, 4),
        { symbol: "V", targetWeight: 0.2, thesis: "Buy with no price." },
      ],
    });
    const symbolsWithPrice = new Set(UNIVERSE.filter((s) => s !== "V"));
    try {
      validateEnvelope(envelope, { ...BASE_OPTS, symbolsWithPrice, heldSymbols: HELD });
      expect.unreachable('expected validation to fail with "no price data"');
    } catch (err) {
      expect(err).toBeInstanceOf(DecisionValidationError);
      expect((err as DecisionValidationError).message).toContain("no price data");
    }
  });
});

describe("validateEnvelope — the envelope is a complete target book", () => {
  it("rejects an envelope that omits a held symbol, naming it", () => {
    const envelope = validEnvelope({
      positions: [
        { symbol: "KO", targetWeight: 0.2, thesis: "Still the best staple." },
        { symbol: "PG", targetWeight: 0.2, thesis: "Still defensive." },
        { symbol: "JNJ", targetWeight: 0.2, thesis: "Still stabilising." },
        { symbol: "CAT", targetWeight: 0.2, thesis: "Seller exhaustion." },
        { symbol: "V", targetWeight: 0.2, thesis: "New entry replacing an exit." },
      ],
    });
    // XOM is held but has no line — the fold would read that silence as an exit.
    const heldSymbols: ReadonlySet<string> = new Set(["KO", "PG", "JNJ", "XOM", "CAT"]);
    try {
      validateEnvelope(envelope, { ...BASE_OPTS, heldSymbols });
      expect.unreachable('expected validation to fail with "omitted"');
    } catch (err) {
      expect(err).toBeInstanceOf(DecisionValidationError);
      const message = (err as DecisionValidationError).message;
      expect(message).toContain("omitted");
      expect(message).toContain("XOM");
      // Only the omission is named — the four present holdings are not.
      expect(message).not.toContain("KO,");
      expect(message).not.toContain("CAT,");
    }
  });

  it("accepts a book that keeps a holding at a reduced targetWeight", () => {
    const envelope = validEnvelope({
      agent: { ...validEnvelope().agent, cash: 40000, holdingsValue: 60000, roundSeq: 2 },
      roundSeq: 2,
      positions: [
        { symbol: "KO", targetWeight: 0.1, thesis: "Trimmed to half; redeployed to PG." },
        { symbol: "PG", targetWeight: 0.3, thesis: "Absorbs the trimmed weight." },
        { symbol: "JNJ", targetWeight: 0.2, thesis: "Unchanged." },
        { symbol: "XOM", targetWeight: 0.2, thesis: "Unchanged." },
        { symbol: "CAT", targetWeight: 0.2, thesis: "Unchanged." },
      ],
    });
    const heldSymbols: ReadonlySet<string> = new Set(["KO", "PG", "JNJ", "XOM", "CAT"]);
    expect(() => validateEnvelope(envelope, { ...BASE_OPTS, heldSymbols })).not.toThrow();
  });
});

describe("validateEnvelope — anti-drift against the runner", () => {
  it("rejects a simulationId that is not the one the runner booked", () => {
    const envelope = validEnvelope();
    try {
      validateEnvelope(envelope, { ...BASE_OPTS, expectedSimulationId: "sim-other" });
      expect.unreachable('expected validation to fail with "simulationId"');
    } catch (err) {
      expect(err).toBeInstanceOf(DecisionValidationError);
      expect((err as DecisionValidationError).message).toContain(
        'simulationId must be "sim-other"',
      );
    }
  });

  it("rejects a roundSeq that is not the one the runner booked", () => {
    const envelope = validEnvelope();
    try {
      validateEnvelope(envelope, { ...BASE_OPTS, expectedRoundSeq: 7 });
      expect.unreachable('expected validation to fail with "roundSeq"');
    } catch (err) {
      expect(err).toBeInstanceOf(DecisionValidationError);
      expect((err as DecisionValidationError).message).toContain("roundSeq must be 7");
    }
  });

  it("rejects a non-integer roundSeq", () => {
    expectValidationError(
      { ...validEnvelope(), roundSeq: 1.5 },
      "roundSeq must be a positive integer",
    );
  });

  it("rejects agent.roundSeq that disagrees with the top-level roundSeq", () => {
    // Both copies are positive integers and match nothing the runner checked,
    // so without the cross-check this envelope validates and persists a
    // decisionJson contradicting the chain position it is folded at.
    const envelope = validEnvelope();
    expectValidationError(
      { ...envelope, agent: { ...envelope.agent, roundSeq: envelope.roundSeq + 1 } },
      "agent.roundSeq must equal envelope.roundSeq",
    );
  });

  it("accepts an envelope whose two roundSeq copies agree", () => {
    const envelope = validEnvelope({ roundSeq: 4 });
    expect(() =>
      validateEnvelope(
        { ...envelope, agent: { ...envelope.agent, roundSeq: 4 } },
        { ...BASE_OPTS, expectedRoundSeq: 4 },
      ),
    ).not.toThrow();
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
      ...BASE_OPTS,
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

  it("rejects a non-positive portfolioValue", () => {
    const envelope = validEnvelope({
      agent: { ...validEnvelope().agent, portfolioValue: 0 },
    });
    expectValidationError(envelope, "portfolioValue");
  });

  it("rejects a missing agent object", () => {
    const envelope = validEnvelope({ agent: undefined as never });
    expectValidationError(envelope, "agent must be an object");
  });
});

describe("validateEnvelope — envelope-level fields", () => {
  it("rejects a wrong schemaVersion", () => {
    expectValidationError({ ...validEnvelope(), schemaVersion: 1 }, "schemaVersion must be 2");
  });

  it("rejects a missing roundId", () => {
    const envelope = validEnvelope({ roundId: "" });
    expectValidationError(envelope, "roundId");
  });

  it("rejects a missing rationale", () => {
    const envelope = validEnvelope({ rationale: "" });
    expectValidationError(envelope, "rationale");
  });

  it("rejects a position with a missing thesis", () => {
    const envelope = validEnvelope({
      positions: [
        ...validEnvelope().positions.slice(0, 4),
        { symbol: "V", targetWeight: 0.2, thesis: "" },
      ],
    });
    expectValidationError(envelope, "thesis");
  });

  it("rejects a non-object envelope", () => {
    expectValidationError("not-an-object", "envelope must be a JSON object");
    expectValidationError(null, "envelope must be a JSON object");
    expectValidationError([1, 2, 3], "envelope must be a JSON object");
  });
});
