/**
 * Blind "process" scoring: context construction, prompt assembly, and the
 * validate-don't-persist parse of the judge model's output.
 *
 * BLINDNESS IS A CONTRACT, NOT A CONVENTION: `buildBlindContext` assembles the
 * judge input from an explicit WHITELIST only — persona, window, round
 * identity, decision date, rationale, and per-position {symbol, targetWeight,
 * thesis}. It must never include prices/OHLC, PnL, returns, equity curves,
 * benchmark or drawdown figures, Sharpe or any risk metric, entry/fill prices,
 * realized PnL, or any other post-entry market data — so the judge scores the
 * REASONING PROCESS, never the outcome. Do not "helpfully" pass `decision_json`
 * or any metric table in here; the theses already embed the evidence the
 * analyst relied on, and no market-data join belongs on this path.
 */

import { chatComplete } from "./llmClient.js";
import { PROCESS_RUBRIC, validScores } from "./rubric.js";
import type { ProcessRubric, RubricScores } from "./rubric.js";

/** Malformed or off-rubric judge output — nothing is persisted when thrown. */
export class JudgeOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeOutputError";
  }
}

/** Whitelist: the run's own reasoning fields, nothing derived or outcome-y. */
export interface BlindRun {
  runId: number;
  agentKey: string;
  window: string;
  roundSeq: number;
  rationale: string | null;
}

/** Whitelist: a position as the analyst stated it, never its fill or result. */
export interface BlindPosition {
  symbol: string;
  targetWeight: number;
  thesis: string | null;
}

/** Whitelist: round identity and decision date — when it decided, not what happened after. */
export interface BlindRoundMeta {
  roundId: string;
  simulationId: string | null;
  asOfTradeDate: string | null;
}

export function buildBlindContext(
  run: BlindRun,
  positions: readonly BlindPosition[],
  meta: BlindRoundMeta,
): string {
  const marker = run.agentKey.lastIndexOf("--");
  const context = {
    personaKey: marker > 0 ? run.agentKey.slice(0, marker) : run.agentKey,
    window: run.window,
    roundId: meta.roundId,
    simulationId: meta.simulationId,
    asOfTradeDate: meta.asOfTradeDate,
    roundSeq: run.roundSeq,
    rationale: run.rationale,
    positions: positions.map((position) => ({
      symbol: position.symbol,
      targetWeight: position.targetWeight,
      thesis: position.thesis,
    })),
  };
  return JSON.stringify(context, null, 2);
}

export interface JudgePrompt {
  system: string;
  user: string;
}

function rubricBlock(rubric: ProcessRubric): string {
  const lines: string[] = [`Rubric version ${rubric.version}:`];
  rubric.criteria.forEach((criterion, index) => {
    lines.push(
      "",
      `C${index + 1} ${criterion.id} — ${criterion.name}`,
      `Question: ${criterion.question}`,
      "Anchors:",
      ` 1: ${criterion.anchors[1]}`,
      ` 2: ${criterion.anchors[2]}`,
      ` 3: ${criterion.anchors[3]}`,
      ` 4: ${criterion.anchors[4]}`,
      ` 5: ${criterion.anchors[5]}`,
    );
  });
  lines.push(
    "",
    `Overall — ${rubric.overall.name}`,
    `Question: ${rubric.overall.question}`,
    "Anchors:",
    ` 1: ${rubric.overall.anchors[1]}`,
    ` 2: ${rubric.overall.anchors[2]}`,
    ` 3: ${rubric.overall.anchors[3]}`,
    ` 4: ${rubric.overall.anchors[4]}`,
    ` 5: ${rubric.overall.anchors[5]}`,
    "",
    `Verdict — ${rubric.verdict.name}`,
    rubric.verdict.guidance,
  );
  return lines.join("\n");
}

export function buildJudgePrompt(
  blindContext: string,
  rubric: ProcessRubric = PROCESS_RUBRIC,
): JudgePrompt {
  const system = [
    "You are a process judge for portfolio-decision analyst runs.",
    "",
    "You are given ONLY a blind decision record: what the analyst said, what book it",
    "targeted, and when it decided. You are shown NO market outcomes — no prices, no",
    "fills, no performance, no risk metrics. Judge the QUALITY OF THE REASONING",
    "PROCESS and nothing else. Never speculate about how the decisions performed",
    "afterward. Never invent facts: grounding is assessed only against what the record",
    "itself shows.",
    "",
    "Score every criterion with an integer from 1 (worst) to 5 (best), using the",
    "anchors as the scale.",
    "",
    rubricBlock(rubric),
    "",
    "Output format: respond with ONLY one JSON object, with no prose and no markdown",
    "fences:",
    '{"scores":{"c1_thesis_evidence_fit":<1-5>,"c2_internal_consistency":<1-5>,"c3_risk_logic_coherence":<1-5>,"c4_position_sizing_logic":<1-5>,"c5_macro_context_reasoning":<1-5>},"overall":<1-5>,"verdict":"<a short paragraph>"}',
  ].join("\n");
  const user = `Blind decision record to evaluate:\n\n${blindContext}`;
  return { system, user };
}

export interface ScoreRunInput {
  run: BlindRun;
  positions: readonly BlindPosition[];
  meta: BlindRoundMeta;
  model?: string;
}

export interface RunScore {
  scores: Omit<RubricScores, "overall">;
  overall: number;
  verdict: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractJsonObject(raw: string): unknown {
  const unfenced = raw
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new JudgeOutputError(`judge output contained no JSON object: ${raw.slice(0, 200)}`);
  }
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new JudgeOutputError(`judge output was not parseable JSON: ${detail}`);
  }
}

function parseJudgeOutput(raw: string): RunScore {
  const parsed = extractJsonObject(raw);
  if (!isRecord(parsed)) {
    throw new JudgeOutputError("judge output must be a JSON object");
  }
  const { scores, overall, verdict } = parsed;
  if (!isRecord(scores)) {
    throw new JudgeOutputError('judge output must carry a "scores" object');
  }
  if (typeof verdict !== "string" || verdict.trim().length === 0) {
    throw new JudgeOutputError('judge output must carry a non-empty "verdict" string');
  }
  const combined = { ...scores, overall };
  if (!validScores(combined)) {
    throw new JudgeOutputError(
      `judge output scores are off-rubric — need integers 1-5 for exactly the five criterion ids and overall: ${JSON.stringify(combined)}`,
    );
  }
  return {
    scores: {
      c1_thesis_evidence_fit: combined.c1_thesis_evidence_fit,
      c2_internal_consistency: combined.c2_internal_consistency,
      c3_risk_logic_coherence: combined.c3_risk_logic_coherence,
      c4_position_sizing_logic: combined.c4_position_sizing_logic,
      c5_macro_context_reasoning: combined.c5_macro_context_reasoning,
    },
    overall: combined.overall,
    verdict,
  };
}

/**
 * Score one run: build the blind context, prompt the judge, and validate the
 * output against the rubric. A throw here means nothing is persisted.
 */
export async function scoreRun(input: ScoreRunInput): Promise<RunScore> {
  const context = buildBlindContext(input.run, input.positions, input.meta);
  const { system, user } = buildJudgePrompt(context);
  const completion = await chatComplete({
    system,
    user,
    ...(input.model !== undefined ? { model: input.model } : {}),
  });
  return parseJudgeOutput(completion);
}
