/**
 * Public surface of the analysis/decision layer (phase 1).
 *
 * Consumers import from this barrel only — internal module layout is not a
 * contract. See gate `contract-analysis-layer` for the full contract note.
 */

export type {
  AnalysisQuestion,
  AnalysisSnapshot,
  ChoiceQuestion,
  DecisionProvider,
  MetricBundle,
  NoulQuestion,
  ScoreQuestion,
  Signal,
} from "./types.js";
export { DeterministicProvider, computeSignal, generateQuestions } from "./deterministic.js";
export { createProvider, DECISION_PROVIDER_NAMES } from "./registry.js";
export type { DecisionProviderName } from "./registry.js";
