/**
 * scoreRun tests — the blindness DoD gate plus output parsing.
 *
 * The blindness case is the important one: the fixture carries an outcome-laden
 * decision payload and fill fields next to the whitelist fields, and the test
 * asserts the ACTUAL prompt handed to the model contains none of it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompleteInput } from "./llmClient.js";
import { chatComplete } from "./llmClient.js";
import { buildBlindContext, buildJudgePrompt, JudgeOutputError, scoreRun } from "./scoreRun.js";
import type { BlindPosition, BlindRoundMeta, BlindRun } from "./scoreRun.js";

vi.mock("./llmClient.js", () => ({ chatComplete: vi.fn() }));

const mockedChat = vi.mocked(chatComplete);

beforeEach(() => {
  mockedChat.mockReset();
});

const COMPLETION = {
  scores: {
    c1_thesis_evidence_fit: 4,
    c2_internal_consistency: 3,
    c3_risk_logic_coherence: 5,
    c4_position_sizing_logic: 2,
    c5_macro_context_reasoning: 3,
  },
  overall: 4,
  verdict: "Grounded theses with one loose weight-to-conviction link; otherwise coherent.",
};

const BANNED_SUBSTRINGS = [
  "pnl",
  "realized",
  "equity",
  "benchmark",
  "drawdown",
  "sharpe",
  "return",
  "adjclose",
  "entryprice",
  "close",
  "equitycurve",
] as const;

const WHITELIST_FIELDS = [
  "personakey",
  "window",
  "roundid",
  "simulationid",
  "asoftradedate",
  "roundseq",
  "rationale",
  "symbol",
  "targetweight",
  "thesis",
] as const;

/** Whitelist fields PLUS an outcome payload that must never be serialized. */
const RAW_RUN = {
  runId: 42,
  agentKey: "dr-value--weekly",
  window: "weekly",
  roundSeq: 7,
  rationale:
    "Momentum is firm and the book stays concentrated in the two strongest names ahead of the central-bank meeting.",
  decisionJson: {
    pnl: 1234.5,
    realized_pnl: -400,
    equity: 104213.77,
    benchmark: "SPY",
    drawdownPct: -8.2,
    sharpe: 1.4,
    totalReturnPct: 4.3,
    adjClose: 151.2,
    entryPrice: 149.9,
    close: 150.1,
    equityCurve: [{ tradeDate: "2026-09-01", value: 100000 }],
  },
};

const RAW_POSITIONS = [
  {
    symbol: "NVDA",
    targetWeight: 0.6,
    thesis: "Earnings growth is accelerating and the trend remains intact across recent weeks.",
    entryPrice: 142.5,
    shares: 100,
    realizedPnl: 250,
    close: 143.1,
  },
  {
    symbol: "MSFT",
    targetWeight: 0.4,
    thesis: "Cloud demand holds up and the pullback looks orderly rather than structural.",
    entryPrice: 511.0,
    shares: 12,
    adjClose: 512.3,
  },
];

const run: BlindRun = RAW_RUN;
const positions: readonly BlindPosition[] = RAW_POSITIONS;
const meta: BlindRoundMeta = {
  roundId: "w7",
  simulationId: "sim-blind",
  asOfTradeDate: "2026-09-24",
};

describe("buildBlindContext", () => {
  it("serializes exactly the whitelist shape", () => {
    const parsed = JSON.parse(buildBlindContext(run, positions, meta)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "personaKey",
      "window",
      "roundId",
      "simulationId",
      "asOfTradeDate",
      "roundSeq",
      "rationale",
      "positions",
    ]);
    expect(parsed.personaKey).toBe("dr-value");
    const [first] = parsed.positions as Record<string, unknown>[];
    expect(Object.keys(first)).toEqual(["symbol", "targetWeight", "thesis"]);
  });

  it("drops every outcome-looking field carried alongside the whitelist", () => {
    const context = buildBlindContext(run, positions, meta).toLowerCase();
    for (const banned of BANNED_SUBSTRINGS) {
      expect(context).not.toContain(banned);
    }
  });
});

describe("buildJudgePrompt", () => {
  it("embeds the blind context in the user message and the rubric in the system message", () => {
    const { system, user } = buildJudgePrompt(buildBlindContext(run, positions, meta));
    expect(system).toContain("c1_thesis_evidence_fit");
    expect(system).toContain("c5_macro_context_reasoning");
    expect(system).toContain("overall");
    expect(user).toContain('"personaKey": "dr-value"');
  });
});

describe("scoreRun blindness (DoD gate)", () => {
  it("sends the model a prompt with no outcome data and every whitelist field", async () => {
    mockedChat.mockResolvedValueOnce(JSON.stringify(COMPLETION));
    await scoreRun({ run, positions, meta });

    const call = mockedChat.mock.calls[0]?.[0] as ChatCompleteInput;
    const prompt = `${call.system}\n${call.user}`.toLowerCase();
    for (const banned of BANNED_SUBSTRINGS) {
      expect(prompt).not.toContain(banned);
    }
    for (const field of WHITELIST_FIELDS) {
      expect(prompt).toContain(field);
    }
    expect(prompt).toContain("dr-value");
    expect(prompt).toContain("nvda");
    expect(prompt).toContain("2026-09-24");
  });
});

describe("scoreRun output parsing", () => {
  it("parses a fenced JSON completion", async () => {
    mockedChat.mockResolvedValueOnce(`\`\`\`json\n${JSON.stringify(COMPLETION)}\n\`\`\``);
    const result = await scoreRun({ run, positions, meta });
    expect(result.scores).toEqual(COMPLETION.scores);
    expect(result.overall).toBe(4);
    expect(result.verdict).toBe(COMPLETION.verdict);
  });

  it("extracts a JSON object embedded in surrounding prose", async () => {
    mockedChat.mockResolvedValueOnce(`Here is the judgment: ${JSON.stringify(COMPLETION)}`);
    const result = await scoreRun({ run, positions, meta });
    expect(result.overall).toBe(4);
  });

  it("throws JudgeOutputError on output with no JSON object", async () => {
    mockedChat.mockResolvedValue("the run looks fine overall");
    await expect(scoreRun({ run, positions, meta })).rejects.toThrow(JudgeOutputError);
    await expect(scoreRun({ run, positions, meta })).rejects.toThrow(/no JSON object/);
  });

  it("throws JudgeOutputError on unparseable JSON", async () => {
    mockedChat.mockResolvedValueOnce('{"scores": broken,}');
    await expect(scoreRun({ run, positions, meta })).rejects.toThrow(/not parseable JSON/);
  });

  it("throws JudgeOutputError on an out-of-range score instead of persisting garbage", async () => {
    mockedChat.mockResolvedValueOnce(
      JSON.stringify({
        ...COMPLETION,
        scores: { ...COMPLETION.scores, c1_thesis_evidence_fit: 9 },
      }),
    );
    await expect(scoreRun({ run, positions, meta })).rejects.toThrow(/off-rubric/);
  });

  it("throws JudgeOutputError when a criterion is missing", async () => {
    const { c3_risk_logic_coherence: _omitted, ...incomplete } = COMPLETION.scores;
    mockedChat.mockResolvedValueOnce(JSON.stringify({ ...COMPLETION, scores: incomplete }));
    await expect(scoreRun({ run, positions, meta })).rejects.toThrow(/off-rubric/);
  });

  it("throws JudgeOutputError when the verdict is missing", async () => {
    const { verdict: _omitted, ...noVerdict } = COMPLETION;
    mockedChat.mockResolvedValueOnce(JSON.stringify(noVerdict));
    await expect(scoreRun({ run, positions, meta })).rejects.toThrow(/verdict/);
  });

  it("passes an explicit model through to the chat client", async () => {
    mockedChat.mockResolvedValueOnce(JSON.stringify(COMPLETION));
    await scoreRun({ run, positions, meta, model: "custom/judge-model" });
    expect(mockedChat.mock.calls[0]?.[0].model).toBe("custom/judge-model");
  });
});
