/**
 * Pure unit tests for the spawn module — arg-building, NDJSON parsing, and
 * JSON extraction. No subprocess is ever spawned here.
 */

import { describe, expect, it } from "vitest";
import type { DecisionHolding } from "./contract.js";
import { getPersona, WINDOW_CADENCE } from "./personas.js";
import { PROMPT_SET_VERSION } from "./promptVersion.js";
import {
  buildAnalystPrompt,
  buildSpawnArgs,
  extractJsonFromText,
  parseAnalystOutput,
} from "./spawn.js";

describe("buildSpawnArgs — the proven headless invocation", () => {
  it("builds exactly `opencode run --format json <prompt>`", () => {
    const prompt = "Analyze the dataset.";
    expect(buildSpawnArgs(prompt)).toEqual(["run", "--format", "json", prompt]);
  });

  it("keeps the prompt as a single argv element (no shell splitting)", () => {
    const prompt = 'Output ONLY a JSON object: {"schemaVersion": 1}';
    const args = buildSpawnArgs(prompt);
    expect(args).toHaveLength(4);
    expect(args[3]).toBe(prompt);
  });
});

describe("buildAnalystPrompt", () => {
  it("embeds the persona mandate, dataset path, asOf date, and strict output instruction", () => {
    const persona = getPersona("dr-value");
    const { prompt } = buildAnalystPrompt({
      persona,
      window: "monthly",
      agentKey: "dr-value--monthly",
      roundId: "round-1",
      datasetPath: "/rounds/round-1/dataset.json",
      asOfTradeDate: "2026-09-24",
      portfolioValue: 100000,
    });

    expect(prompt).toContain(
      persona.phdSystemPrompt.replace(/\{\{cadence\}\}/g, WINDOW_CADENCE.monthly),
    );
    expect(prompt).toContain("You are analyzing data as of 2026-09-24");
    expect(prompt).toContain("/rounds/round-1/dataset.json");
    expect(prompt).toContain("Output ONLY a single JSON object");
    expect(prompt).toContain('agentKey="dr-value--monthly"');
    expect(prompt).toContain('roundId="round-1"');
    expect(prompt).toContain("portfolioValue=100000");
    expect(prompt).toContain("Pick 5–10 symbols");
  });

  it("substitutes the assigned window cadence and pins agent.window in the example", () => {
    for (const window of ["daily", "weekly", "monthly"] as const) {
      const { prompt } = buildAnalystPrompt({
        persona: getPersona("dr-value"),
        window,
        agentKey: `dr-value--${window}`,
        roundId: "round-1",
        datasetPath: "/rounds/round-1/dataset.json",
        asOfTradeDate: "2026-09-24",
        portfolioValue: 100000,
      });

      expect(prompt).toContain(WINDOW_CADENCE[window]);
      expect(prompt).not.toContain("{{cadence}}");
      expect(prompt).toContain(`Your assigned rebalance window is "${window}"`);
      expect(prompt).toContain(`agent.window to exactly "${window}"`);
      expect(prompt).toContain(`"window": "${window}"`);
    }
  });

  it("annotates a replica run with replicateOf", () => {
    const { prompt } = buildAnalystPrompt({
      persona: getPersona("dr-value"),
      window: "monthly",
      agentKey: "dr-value--monthly#rep1",
      roundId: "round-1",
      datasetPath: "/rounds/round-1/dataset.json",
      asOfTradeDate: "2026-09-24",
      portfolioValue: 100000,
      replicateOf: "dr-value--monthly",
    });
    expect(prompt).toContain('consistency replica of "dr-value--monthly"');
  });

  it("appends the correction hint on retry", () => {
    const { prompt } = buildAnalystPrompt({
      persona: getPersona("dr-value"),
      window: "daily",
      agentKey: "dr-value--daily",
      roundId: "round-1",
      datasetPath: "/rounds/round-1/dataset.json",
      asOfTradeDate: "2026-09-24",
      portfolioValue: 100000,
      correctionHint: "Your previous output failed validation: weight sum was 0.5",
    });
    expect(prompt).toContain("CORRECTION FROM THE PREVIOUS ATTEMPT");
    expect(prompt).toContain("weight sum was 0.5");
  });
});

describe("parseAnalystOutput — NDJSON event stream", () => {
  it("takes the LAST text event from a realistic opencode stream", () => {
    const stdout = [
      JSON.stringify({ type: "session", sessionId: "ses_abc" }),
      JSON.stringify({ type: "message", message: { role: "user" } }),
      JSON.stringify({
        type: "text",
        part: { type: "text", text: "Let me read the dataset first." },
      }),
      JSON.stringify({
        type: "text",
        part: { type: "text", text: '{"schemaVersion":1,"roundId":"r1"}' },
      }),
      JSON.stringify({ type: "done", sessionId: "ses_abc" }),
    ].join("\n");

    expect(parseAnalystOutput(stdout)).toBe('{"schemaVersion":1,"roundId":"r1"}');
  });

  it("handles the flat `text` field variant (no `part`)", () => {
    const stdout = [
      JSON.stringify({ type: "text", text: "first" }),
      JSON.stringify({ type: "text", text: "second" }),
    ].join("\n");
    expect(parseAnalystOutput(stdout)).toBe("second");
  });

  it("ignores non-JSON lines and non-text events", () => {
    const stdout = [
      "some stray log line",
      JSON.stringify({ type: "step-start", step: { id: 1 } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "the answer" } }),
    ].join("\n");
    expect(parseAnalystOutput(stdout)).toBe("the answer");
  });

  it("throws when no text event is present", () => {
    const stdout = [
      JSON.stringify({ type: "session", sessionId: "ses_abc" }),
      JSON.stringify({ type: "done", sessionId: "ses_abc" }),
    ].join("\n");
    expect(() => parseAnalystOutput(stdout)).toThrow(/No text event found/);
  });
});

describe("extractJsonFromText", () => {
  it("parses plain JSON", () => {
    expect(extractJsonFromText('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips markdown code fences", () => {
    const text = '```json\n{"a":1}\n```';
    expect(extractJsonFromText(text)).toEqual({ a: 1 });
  });

  it("strips fences without a language tag", () => {
    const text = '```\n{"a":1}\n```';
    expect(extractJsonFromText(text)).toEqual({ a: 1 });
  });

  it("strips fences with surrounding prose", () => {
    const text = 'Here is my decision:\n```json\n{"a":1}\n```\nThat is all.';
    expect(extractJsonFromText(text)).toEqual({ a: 1 });
  });

  it("throws on invalid JSON", () => {
    expect(() => extractJsonFromText("not json at all")).toThrow();
  });
});

/**
 * The analyst's prompt is one of the two real channels carryover travels down:
 * whatever book the fold carried is rendered into the next round's instructions.
 * These pin that channel. Same persona, same dataset, same as-of date — the only
 * variable is the carried book, so any divergence traces back to carryover.
 */
describe("buildAnalystPrompt — the carried book reaches the analyst", () => {
  const persona = getPersona("dr-value");
  const base = {
    persona,
    window: "daily",
    agentKey: "dr-value--daily",
    roundId: "round-2",
    datasetPath: "/rounds/sim-baseline-0002/dataset.json",
    asOfTradeDate: "2026-09-25",
  } as const;

  /**
   * A fixture book, not market data: 600 shares of a ticker no persona text
   * mentions, so any appearance of it in the prompt can only have arrived via
   * the carried holdings passed in.
   */
  const carried: DecisionHolding[] = [
    {
      symbol: "ACME",
      shares: 600,
      costBasis: 100,
      lastPrice: 104,
      marketValue: 62400,
      weight: 62400 / 102800,
      holdingDays: 4,
      unrealizedPnlPct: 4,
    },
  ];

  const carriedOpts = {
    ...base,
    simulationId: "sim-baseline",
    roundSeq: 2,
    priorRoundId: "round-1",
    cash: 40400,
    holdingsValue: 62400,
    portfolioValue: 102800,
    holdings: carried,
  };

  it("states the carried book, its mark, and the chain position", () => {
    const { prompt } = buildAnalystPrompt(carriedOpts);

    expect(prompt).toContain("HOLDINGS (your carried book, marked at this decision date)");
    expect(prompt).toContain("ACME");
    expect(prompt).toContain("portfolioValue=102800");
    expect(prompt).toContain("cash=40400.00");
    expect(prompt).toContain("holdingsValue=62400.00");
    expect(prompt).toContain("roundSeq=2");
    expect(prompt).toContain('priorRoundId="round-1"');
  });

  it("tells a first-round analyst it holds nothing instead of silently omitting the book", () => {
    const { prompt } = buildAnalystPrompt({ ...base, portfolioValue: 100000, holdings: [] });

    expect(prompt).toContain("This is its first decision round");
    expect(prompt).toContain("roundSeq=1");
    expect(prompt).toContain("priorRoundId=null");
    expect(prompt).not.toContain("ACME");
  });

  it("hands the analyst a different input when ONLY the carried book differs", () => {
    // Only `holdings` varies. The pinned holdingsValue no longer matching the book
    // is deliberate — holding it constant is what isolates the rendering channel.
    const pinned = {
      ...carriedOpts,
      cash: 40400,
      holdingsValue: 62400,
      portfolioValue: 102800,
    };

    const withBook = buildAnalystPrompt({ ...pinned, holdings: carried }).prompt;
    const withoutBook = buildAnalystPrompt({ ...pinned, holdings: [] }).prompt;

    expect(withBook).not.toEqual(withoutBook);
    expect(withBook).toContain("ACME");
    expect(withoutBook).not.toContain("ACME");
  });
});

/**
 * The prompt-set stamp: every run records WHICH prompt produced it — a global
 * version label plus a content hash of the static rendered template. The hash
 * must be stable across runs of the same prompt set and sensitive to any
 * prompt-set change, while staying blind to per-run inputs.
 */
describe("buildAnalystPrompt — prompt-set stamping", () => {
  const base = {
    persona: getPersona("dr-value"),
    window: "daily",
    agentKey: "dr-value--daily",
    roundId: "round-1",
    datasetPath: "/rounds/round-1/dataset.json",
    asOfTradeDate: "2026-09-24",
    portfolioValue: 100000,
  } as const;

  const otherHolding: DecisionHolding = {
    symbol: "ACME",
    shares: 600,
    costBasis: 100,
    lastPrice: 104,
    marketValue: 62400,
    weight: 0.6,
    holdingDays: 4,
    unrealizedPnlPct: 4,
  };

  it("stamps a non-empty PROMPT_SET_VERSION matching /^v\\d+$/", () => {
    expect(PROMPT_SET_VERSION).toMatch(/^v\d+$/);
    expect(PROMPT_SET_VERSION.length).toBeGreaterThan(0);
    expect(buildAnalystPrompt(base).promptSetVersion).toBe(PROMPT_SET_VERSION);
  });

  it("returns a 64-char lowercase hex sha256", () => {
    expect(buildAnalystPrompt(base).promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces an identical hash when the inputs are identical", () => {
    const first = buildAnalystPrompt(base);
    const second = buildAnalystPrompt(base);
    expect(second.promptHash).toBe(first.promptHash);
    expect(second.prompt).toBe(first.prompt);
  });

  it("produces different hashes for different personas", () => {
    const other = buildAnalystPrompt({
      ...base,
      persona: getPersona("dr-momentum"),
      agentKey: "dr-momentum--daily",
    });
    expect(other.promptHash).not.toBe(buildAnalystPrompt(base).promptHash);
  });

  it("produces different hashes when the window (and therefore cadence) differs", () => {
    const weekly = buildAnalystPrompt({ ...base, window: "weekly", agentKey: "dr-value--weekly" });
    expect(weekly.promptHash).not.toBe(buildAnalystPrompt(base).promptHash);
  });

  it("excludes volatile per-run inputs from the hash while the prompt itself changes", () => {
    const first = buildAnalystPrompt(base);
    const variant = buildAnalystPrompt({
      ...base,
      roundId: "round-99",
      portfolioValue: 250000,
      asOfTradeDate: "2026-10-01",
      simulationId: "sim-other",
      roundSeq: 7,
      holdings: [otherHolding],
      correctionHint: "Your previous output failed validation: weight sum was 0.5",
    });

    expect(variant.promptHash).toBe(first.promptHash);
    expect(variant.prompt).not.toBe(first.prompt);
    expect(variant.prompt).toContain("round-99");
  });
});
