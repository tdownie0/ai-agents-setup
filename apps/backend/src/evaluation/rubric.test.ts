/**
 * Rubric contract tests: the validator is the gate that keeps off-rubric model
 * output out of `run_eval_scores`, so every rejection class is pinned here.
 */

import { describe, expect, it } from "vitest";
import {
  CRITERION_IDS,
  PROCESS_JUDGE_KEY,
  PROCESS_RUBRIC,
  RUBRIC_VERSION,
  validScores,
} from "./rubric.js";

const VALID = {
  c1_thesis_evidence_fit: 4,
  c2_internal_consistency: 3,
  c3_risk_logic_coherence: 5,
  c4_position_sizing_logic: 2,
  c5_macro_context_reasoning: 3,
  overall: 4,
};

describe("validScores", () => {
  it("accepts a full valid score object", () => {
    expect(validScores(VALID)).toBe(true);
  });

  it("accepts the boundary values 1 and 5", () => {
    expect(
      validScores({
        c1_thesis_evidence_fit: 1,
        c2_internal_consistency: 5,
        c3_risk_logic_coherence: 1,
        c4_position_sizing_logic: 5,
        c5_macro_context_reasoning: 1,
        overall: 5,
      }),
    ).toBe(true);
  });

  it("rejects out-of-range scores below 1 and above 5", () => {
    expect(validScores({ ...VALID, c1_thesis_evidence_fit: 0 })).toBe(false);
    expect(validScores({ ...VALID, c3_risk_logic_coherence: 6 })).toBe(false);
    expect(validScores({ ...VALID, overall: 0 })).toBe(false);
  });

  it("rejects non-integer numbers and numeric strings", () => {
    expect(validScores({ ...VALID, c2_internal_consistency: 3.5 })).toBe(false);
    expect(validScores({ ...VALID, c4_position_sizing_logic: "4" })).toBe(false);
  });

  it("rejects a missing criterion", () => {
    const { c5_macro_context_reasoning: _omitted, ...missing } = VALID;
    expect(validScores(missing)).toBe(false);
  });

  it("rejects a missing overall", () => {
    const { overall: _omitted, ...missing } = VALID;
    expect(validScores(missing)).toBe(false);
  });

  it("rejects an extra unknown key", () => {
    expect(validScores({ ...VALID, c6_bonus: 3 })).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(validScores(null)).toBe(false);
    expect(validScores([1, 2, 3])).toBe(false);
    expect(validScores("4")).toBe(false);
  });
});

describe("PROCESS_RUBRIC", () => {
  it("pins the judge key and rubric version persisted with every score", () => {
    expect(PROCESS_RUBRIC.judgeKey).toBe(PROCESS_JUDGE_KEY);
    expect(PROCESS_JUDGE_KEY).toBe("process");
    expect(PROCESS_RUBRIC.version).toBe(RUBRIC_VERSION);
    expect(RUBRIC_VERSION).toBe("1");
  });

  it("defines exactly the five criterion ids in order", () => {
    expect(PROCESS_RUBRIC.criteria.map((criterion) => criterion.id)).toEqual([...CRITERION_IDS]);
    expect(PROCESS_RUBRIC.criteria).toHaveLength(5);
  });

  it("anchors every criterion and the overall rating at 1-5 with non-empty text", () => {
    const anchors = [
      ...PROCESS_RUBRIC.criteria.map((c) => c.anchors),
      PROCESS_RUBRIC.overall.anchors,
    ];
    for (const scale of anchors) {
      for (const level of [1, 2, 3, 4, 5] as const) {
        expect(scale[level].trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("carries verdict guidance", () => {
    expect(PROCESS_RUBRIC.verdict.guidance.trim().length).toBeGreaterThan(0);
  });
});
