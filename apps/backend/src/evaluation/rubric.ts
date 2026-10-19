/**
 * The locked "process" judge rubric (v1) — reasoning quality only.
 *
 * The judge is BLIND to outcomes by construction: every criterion below is
 * phrased against what the run itself says (rationale, theses, weights), never
 * against prices or performance, so no anchor can smuggle an outcome signal
 * into the prompt. Keep it that way when editing anchors.
 */

/** Judge key persisted to `run_eval_scores.judge_key` for this judge. */
export const PROCESS_JUDGE_KEY = "process";

/** Rubric version persisted to `run_eval_scores.judge_version`. */
export const RUBRIC_VERSION = "1";

export const CRITERION_IDS = [
  "c1_thesis_evidence_fit",
  "c2_internal_consistency",
  "c3_risk_logic_coherence",
  "c4_position_sizing_logic",
  "c5_macro_context_reasoning",
] as const;

export type CriterionId = (typeof CRITERION_IDS)[number];

/** Anchored 1 (worst) to 5 (best) for every scored question. */
export interface RubricAnchors {
  1: string;
  2: string;
  3: string;
  4: string;
  5: string;
}

export interface RubricCriterion {
  id: CriterionId;
  name: string;
  question: string;
  anchors: RubricAnchors;
}

export interface ProcessRubric {
  judgeKey: string;
  version: string;
  criteria: readonly RubricCriterion[];
  overall: { name: string; question: string; anchors: RubricAnchors };
  verdict: { name: string; guidance: string };
}

export const PROCESS_RUBRIC: ProcessRubric = {
  judgeKey: PROCESS_JUDGE_KEY,
  version: RUBRIC_VERSION,
  criteria: [
    {
      id: "c1_thesis_evidence_fit",
      name: "Thesis-evidence fit",
      question:
        "Does each position's thesis bind to facts the analyst actually had at decision time?",
      anchors: {
        1: "A thesis contradicts or ignores observations available in the run; its claim is ungrounded.",
        2: "A thesis gestures at market conditions in generic terms, with little specific grounding.",
        3: "A thesis cites some specific observations, but the link to the chosen weight is loose.",
        4: "Theses are mostly derived from specific observations the analyst had, with minor leaps.",
        5: "Every thesis tightly derives its claim from specific, named observations in the run.",
      },
    },
    {
      id: "c2_internal_consistency",
      name: "Internal consistency",
      question:
        "Do the rationale, the per-position theses, and the target weights agree, and is the complete-book rule honored?",
      anchors: {
        1: "Rationale, theses, and weights contradict each other, or the complete-book rule is broken.",
        2: "Mostly aligned, but at least one clear mismatch: a thesis argues against its own weight, or a stated intent is absent from the book.",
        3: "Broad agreement with minor loose ends; one position is under-explained relative to the rest.",
        4: "Consistent across rationale, theses, and weights, with only small omissions.",
        5: "Fully coherent: the rationale, every thesis, and the complete target book agree with each other.",
      },
    },
    {
      id: "c3_risk_logic_coherence",
      name: "Risk-logic coherence",
      question:
        "Is the concentration, downside-risk, and rebalance-cadence reasoning sound and matched to the stated risk posture?",
      anchors: {
        1: "Risk choices are arbitrary: no coherent link between the stated posture and how concentrated or active the book is.",
        2: "A risk posture is mentioned but never applied to the book's concentration or cadence.",
        3: "Some coherent risk logic, though one dimension (concentration, downside protection, or cadence) is unreasoned.",
        4: "Sound risk reasoning across concentration, downside risk, and cadence, with a small gap.",
        5: "Explicit, coherent risk logic: concentration, downside risk, and cadence all follow from the stated posture.",
      },
    },
    {
      id: "c4_position_sizing_logic",
      name: "Position-sizing logic",
      question:
        "Do the target weights follow the analyst's own conviction ranking and relative magnitude?",
      anchors: {
        1: "Weights are unexplained or unrelated to any stated conviction.",
        2: "A ranking is implied, but the actual weight magnitudes do not track it.",
        3: "Roughly proportional to conviction; relative magnitudes are only loosely justified.",
        4: "Weights mostly track the conviction ranking; small inconsistencies in magnitude.",
        5: "Clear conviction-to-weight mapping: every weight's relative size is justified by stated conviction.",
      },
    },
    {
      id: "c5_macro_context_reasoning",
      name: "Macro-context reasoning",
      question:
        "Does the run engage the market regime and context for its window appropriately, without inventing facts?",
      anchors: {
        1: "Fabricates market facts, or ignores context relevant to the decision window.",
        2: "Mentions context in generic terms without connecting it to the decisions.",
        3: "Uses relevant context for some decisions; engagement is uneven or partly speculative.",
        4: "Grounded, relevant use of context across most of the book; no invented facts.",
        5: "Grounded and relevant: market context for the window shapes the decisions, with no invented facts.",
      },
    },
  ],
  overall: {
    name: "Holistic reasoning quality",
    question:
      "Given the five criteria, what single integer 1-5 best captures the overall quality of this run's reasoning process?",
    anchors: {
      1: "The reasoning process is fundamentally flawed: ungrounded, contradictory, or arbitrary.",
      2: "Weak process: some reasoning present, but largely generic or internally uneven.",
      3: "Adequate process: mostly grounded and coherent, with visible gaps.",
      4: "Strong process: grounded, coherent, and well-reasoned, with only minor gaps.",
      5: "Excellent process: tightly evidence-bound, fully coherent, and explicit throughout.",
    },
  },
  verdict: {
    name: "Verdict paragraph",
    guidance:
      "Write one short paragraph (3-5 sentences) summarizing the run's reasoning strengths and weaknesses, referencing criteria by id where useful. Judge only the reasoning process you can see — never speculate about how the decisions performed.",
  },
};

/** Exactly the five criterion ids plus `overall`, all integers 1-5. */
export type RubricScores = Record<CriterionId, number> & { overall: number };

/**
 * Type guard for a judge score object: it must carry exactly the five
 * criterion ids and `overall` — no extras, no gaps — each an integer 1-5.
 */
export function validScores(x: unknown): x is RubricScores {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const record = x as Record<string, unknown>;
  if (Object.keys(record).length !== CRITERION_IDS.length + 1) return false;
  for (const id of CRITERION_IDS) {
    if (!Object.hasOwn(record, id)) return false;
  }
  if (!Object.hasOwn(record, "overall")) return false;
  for (const value of Object.values(record)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5)
      return false;
  }
  return true;
}
