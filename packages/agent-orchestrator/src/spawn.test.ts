/**
 * Pure unit tests for the spawn module — arg-building, NDJSON parsing, and
 * JSON extraction. No subprocess is ever spawned here.
 */

import { describe, expect, it } from "vitest";
import { getPersona, WINDOW_CADENCE } from "./personas.js";
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
    const prompt = buildAnalystPrompt({
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
      const prompt = buildAnalystPrompt({
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
    const prompt = buildAnalystPrompt({
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
    const prompt = buildAnalystPrompt({
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
