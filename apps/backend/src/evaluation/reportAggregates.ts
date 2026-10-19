/**
 * Pure aggregation for the eval comparison report (beads task …-ijg).
 *
 * Turns already-loaded rows into the `GET /portfolio/evals/report` payload:
 * groups matched runs by (personaKey, promptSetVersion), summarizes the
 * judge's `run_eval_scores` rows per criterion, averages the deterministic
 * stream metrics across replicate sims, and attaches the low-n warnings that
 * make small-sample comparisons honest. No DB access here — `report.ts`
 * loads rows, this module does the math, and `portfolio/evalMetrics.ts`
 * (imported below) does the per-stream scoring.
 */

import type { PortfolioWindow } from "@model_md/database";
import type { EquityRow, StreamEvalMetrics } from "../portfolio/evalMetrics.js";
import { computeStreamEvalMetrics, sliceStreamEquity } from "../portfolio/evalMetrics.js";
import { personaKeyOf } from "../portfolio/carryoverStore.js";
import { RUBRIC_VERSION, validScores } from "./rubric.js";
import type { CriterionId, RubricScores } from "./rubric.js";

/* ------------------------------------------------------------------ *
 * wire shape
 * ------------------------------------------------------------------ */

/** One judge score key: the five rubric criteria plus `overall`. */
export type ScoreId = CriterionId | "overall";

/** Distribution of one score across a group's scored runs; `null` when nobody scored. */
export interface CriterionStats {
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

export interface JudgeSummary {
  judgeModels: string[];
  criteria: Record<ScoreId, CriterionStats>;
}

/** Means of a group's stream metrics across replicate sims (`null` = no contributor). */
export interface WindowMetricsSummary {
  totalReturnPct: number | null;
  annualizedVolPct: number | null;
  sharpe: number | null;
  maxDrawdownPct: number | null;
  simCount: number;
}

export interface EvalReportWindow {
  /** Group runs whose `window` is this bucket (date range applied by SQL). */
  runs: number;
  /** Distinct sims among those runs. */
  replicates: number;
  metrics: WindowMetricsSummary;
}

export type EvalReportWarningCode = "replicates_lt_3" | "trading_days_lt_20";

export interface EvalReportGroupRef {
  personaKey: string;
  promptSetVersion: string | null;
}

export interface EvalReportGroup extends EvalReportGroupRef {
  runs: number;
  /** Runs with a `run_eval_scores` row for the requested `judgeKey`. */
  scoredRuns: number;
  unscoredRuns: number;
  /** Distinct sims among the group's runs (one fresh sim per replicate). */
  replicates: number;
  /** Distinct round decide dates among the group's runs. */
  tradingDays: number;
  /** Distinct non-null `prompt_hash` values in the group — drift detection. */
  promptHashes: string[];
  judge: JudgeSummary;
  windows: Record<PortfolioWindow, EvalReportWindow>;
  warnings: EvalReportWarningCode[];
}

export interface EvalReportWarning {
  group: EvalReportGroupRef;
  code: EvalReportWarningCode;
  message: string;
}

export interface EvalReport {
  /** Effective inclusive bounds actually applied (`null` only when nothing matched and none were given). */
  start: string | null;
  end: string | null;
  judgeKey: string;
  simIds: string[];
  groups: EvalReportGroup[];
  /** One entry per (group, code) — the same codes the groups list, with context. */
  warnings: EvalReportWarning[];
}

/* ------------------------------------------------------------------ *
 * row shapes handed to the assembly
 * ------------------------------------------------------------------ */

/** A matched `agent_runs` row with its round's decide date, nullable columns as stored. */
export interface RawReportRunRow {
  id: number;
  simulationId: string | null;
  agentKey: string;
  window: PortfolioWindow;
  promptSetVersion: string | null;
  promptHash: string | null;
  asOfTradeDate: string | null;
}

/** A run usable for grouping: it belongs to a sim and has a decide date (nulls dropped at the boundary). */
export interface ReportRunRow {
  id: number;
  simulationId: string;
  agentKey: string;
  window: PortfolioWindow;
  promptSetVersion: string | null;
  promptHash: string | null;
  asOfTradeDate: string;
}

/** A `run_eval_scores` row for the requested `judgeKey` (scores kept `unknown` until validated). */
export interface ReportScoreRow {
  agentRunId: number;
  judgeVersion: string;
  judgeModel: string;
  scores: unknown;
}

/** An `agent_portfolio_state` row: one materialized (sim, persona, window) stream. */
export interface ReportStateRow {
  id: number;
  simulationId: string;
  personaKey: string;
  window: PortfolioWindow;
}

/** One group sim's (persona, window) stream sliced to the effective range and scored. */
export interface WindowSample {
  simulationId: string;
  personaKey: string;
  window: PortfolioWindow;
  metrics: StreamEvalMetrics;
}

export interface AssembleEvalReportInput {
  simIds: readonly string[];
  judgeKey: string;
  start: string;
  end: string;
  runs: readonly ReportRunRow[];
  scoreRows: readonly ReportScoreRow[];
  samples: readonly WindowSample[];
}

/* ------------------------------------------------------------------ *
 * thresholds & helpers
 * ------------------------------------------------------------------ */

const REPLICATES_THRESHOLD = 3;
const TRADING_DAYS_THRESHOLD = 20;

const ALL_WINDOWS: PortfolioWindow[] = ["daily", "weekly", "monthly"];

/** Every mean in the payload is rounded to 4 decimals to keep payloads compact. */
export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** mean/median/min/max over the values; median of an even count = average of the middle two. */
export function summarize(values: readonly number[]): CriterionStats {
  if (values.length === 0) return { mean: null, median: null, min: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const mean = sorted.reduce((acc, value) => acc + value, 0) / sorted.length;
  return { mean: round4(mean), median, min: sorted[0], max: sorted[sorted.length - 1] };
}

const meanOrNull = (values: readonly (number | null)[]): number | null => {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return round4(present.reduce((acc, value) => acc + value, 0) / present.length);
};

/** Stable group key: (personaKey, promptSetVersion) — `null` version included as-is. */
const groupKey = (personaKey: string, promptSetVersion: string | null): string =>
  JSON.stringify([personaKey, promptSetVersion]);

/** Stable stream key: (simId, personaKey, window). */
export const stateKey = (
  simulationId: string,
  personaKey: string,
  window: PortfolioWindow,
): string => JSON.stringify([simulationId, personaKey, window]);

/**
 * Pick the one score row for a run when several `judgeVersions` exist under
 * the same `judgeKey`: PREFER RUBRIC_VERSION (the rubric this service
 * currently emits), else the highest version lexicographically (byte order).
 * The unique index allows at most one row per (run, judgeKey, judgeVersion),
 * so the version alone decides — no tie-break on `createdAt` is needed.
 */
export function selectScoreRow(rows: readonly ReportScoreRow[]): ReportScoreRow | undefined {
  let best: ReportScoreRow | undefined;
  for (const row of rows) {
    if (row.judgeVersion === RUBRIC_VERSION) return row;
    if (best === undefined || row.judgeVersion > best.judgeVersion) best = row;
  }
  return best;
}

/** Collapse raw score rows to at most one selected row per run (rule above). */
export function selectedScoresByRun(rows: readonly ReportScoreRow[]): Map<number, ReportScoreRow> {
  const byRun = new Map<number, ReportScoreRow[]>();
  for (const row of rows) {
    const list = byRun.get(row.agentRunId) ?? [];
    list.push(row);
    byRun.set(row.agentRunId, list);
  }
  const selected = new Map<number, ReportScoreRow>();
  for (const [runId, list] of byRun) {
    const row = selectScoreRow(list);
    if (row !== undefined) selected.set(runId, row);
  }
  return selected;
}

/** One warning message per (code, count) — states that deltas below the threshold are noise. */
export function warningMessage(code: EvalReportWarningCode, count: number): string {
  return code === "replicates_lt_3"
    ? `replicates=${count} below ${REPLICATES_THRESHOLD}: deltas below ${REPLICATES_THRESHOLD} replicates are noise`
    : `tradingDays=${count} below ${TRADING_DAYS_THRESHOLD}: deltas below ${TRADING_DAYS_THRESHOLD} trading days are noise`;
}

/* ------------------------------------------------------------------ *
 * stream metrics (reuses evalMetrics — never reimplemented here)
 * ------------------------------------------------------------------ */

/**
 * Slice + score every candidate stream in `[start, end]`. Candidates are the
 * states `report.ts` matched against `neededStateKeys`, so a stream with no
 * materialized state simply has no sample.
 */
export function computeWindowSamples(
  states: readonly ReportStateRow[],
  equityByState: ReadonlyMap<number, readonly EquityRow[]>,
  start: string,
  end: string,
): WindowSample[] {
  return states.map((state) => ({
    simulationId: state.simulationId,
    personaKey: state.personaKey,
    window: state.window,
    metrics: computeStreamEvalMetrics(
      sliceStreamEquity(equityByState.get(state.id) ?? [], start, end),
    ),
  }));
}

/**
 * (simId, personaKey, window) keys `report.ts` must fetch equity for: every
 * group sim × every portfolio window for each grouped persona. A group sim
 * whose stream was never materialized just yields no sample downstream.
 */
export function neededStateKeys(runs: readonly ReportRunRow[]): Set<string> {
  const simsByGroup = new Map<string, { personaKey: string; sims: Set<string> }>();
  for (const run of runs) {
    const personaKey = personaKeyOf(run.agentKey);
    const key = groupKey(personaKey, run.promptSetVersion);
    const entry = simsByGroup.get(key) ?? { personaKey, sims: new Set<string>() };
    entry.sims.add(run.simulationId);
    simsByGroup.set(key, entry);
  }
  const keys = new Set<string>();
  for (const entry of simsByGroup.values()) {
    for (const simulationId of entry.sims) {
      for (const window of ALL_WINDOWS) {
        keys.add(stateKey(simulationId, entry.personaKey, window));
      }
    }
  }
  return keys;
}

/* ------------------------------------------------------------------ *
 * assembly
 * ------------------------------------------------------------------ */

const summarizeScores = (usable: readonly RubricScores[]): Record<ScoreId, CriterionStats> => ({
  c1_thesis_evidence_fit: summarize(usable.map((score) => score.c1_thesis_evidence_fit)),
  c2_internal_consistency: summarize(usable.map((score) => score.c2_internal_consistency)),
  c3_risk_logic_coherence: summarize(usable.map((score) => score.c3_risk_logic_coherence)),
  c4_position_sizing_logic: summarize(usable.map((score) => score.c4_position_sizing_logic)),
  c5_macro_context_reasoning: summarize(usable.map((score) => score.c5_macro_context_reasoning)),
  overall: summarize(usable.map((score) => score.overall)),
});

interface GroupBucket {
  personaKey: string;
  promptSetVersion: string | null;
  runs: ReportRunRow[];
}

function buildGroup(
  bucket: GroupBucket,
  selectedByRun: ReadonlyMap<number, ReportScoreRow>,
  samplesByKey: ReadonlyMap<string, StreamEvalMetrics>,
): EvalReportGroup {
  const { runs } = bucket;
  const sims = new Set(runs.map((run) => run.simulationId));
  const tradingDays = new Set(runs.map((run) => run.asOfTradeDate));
  const scoredRows = runs
    .map((run) => selectedByRun.get(run.id))
    .filter((row): row is ReportScoreRow => row !== undefined);
  // Judge stats read the scores the chosen version actually persisted; rows
  // whose jsonb fails the rubric's guard contribute nothing numeric (the
  // upsert only ever writes valid scores, so this is a data-integrity net).
  const usable = scoredRows.map((row) => row.scores).filter(validScores);

  return {
    personaKey: bucket.personaKey,
    promptSetVersion: bucket.promptSetVersion,
    runs: runs.length,
    scoredRuns: scoredRows.length,
    unscoredRuns: runs.length - scoredRows.length,
    replicates: sims.size,
    tradingDays: tradingDays.size,
    promptHashes: [
      ...new Set(runs.map((run) => run.promptHash).filter((hash) => hash !== null)),
    ].sort(),
    judge: {
      judgeModels: [...new Set(scoredRows.map((row) => row.judgeModel))].sort(),
      criteria: summarizeScores(usable),
    },
    windows: buildWindows(bucket, sims, samplesByKey),
    warnings: buildGroupWarnings(sims.size, tradingDays.size),
  };
}

function buildWindows(
  bucket: GroupBucket,
  groupSims: ReadonlySet<string>,
  samplesByKey: ReadonlyMap<string, StreamEvalMetrics>,
): Record<PortfolioWindow, EvalReportWindow> {
  const build = (window: PortfolioWindow): EvalReportWindow => {
    const windowRuns = bucket.runs.filter((run) => run.window === window);
    const windowSims = new Set(windowRuns.map((run) => run.simulationId));
    const streams = [...groupSims]
      .map((simulationId) => samplesByKey.get(stateKey(simulationId, bucket.personaKey, window)))
      .filter((metrics): metrics is StreamEvalMetrics => metrics !== undefined);
    return {
      runs: windowRuns.length,
      replicates: windowSims.size,
      metrics: {
        totalReturnPct: meanOrNull(streams.map((stream) => stream.totalReturnPct)),
        annualizedVolPct: meanOrNull(streams.map((stream) => stream.annualizedVolPct)),
        sharpe: meanOrNull(streams.map((stream) => stream.sharpe)),
        maxDrawdownPct: meanOrNull(streams.map((stream) => stream.maxDrawdownPct)),
        simCount: streams.length,
      },
    };
  };
  return { daily: build("daily"), weekly: build("weekly"), monthly: build("monthly") };
}

function buildGroupWarnings(replicates: number, tradingDays: number): EvalReportWarningCode[] {
  const codes: EvalReportWarningCode[] = [];
  if (replicates < REPLICATES_THRESHOLD) codes.push("replicates_lt_3");
  if (tradingDays < TRADING_DAYS_THRESHOLD) codes.push("trading_days_lt_20");
  return codes;
}

/** Turn loaded rows into the locked `EvalReport` payload. Pure. */
export function assembleEvalReport(input: AssembleEvalReportInput): EvalReport {
  const selectedByRun = selectedScoresByRun(input.scoreRows);
  const samplesByKey = new Map<string, StreamEvalMetrics>();
  for (const sample of input.samples) {
    samplesByKey.set(
      stateKey(sample.simulationId, sample.personaKey, sample.window),
      sample.metrics,
    );
  }

  const buckets = new Map<string, GroupBucket>();
  for (const run of input.runs) {
    const personaKey = personaKeyOf(run.agentKey);
    const key = groupKey(personaKey, run.promptSetVersion);
    const bucket = buckets.get(key) ?? {
      personaKey,
      promptSetVersion: run.promptSetVersion,
      runs: [],
    };
    bucket.runs.push(run);
    buckets.set(key, bucket);
  }

  const groups = [...buckets.values()]
    .map((bucket) => buildGroup(bucket, selectedByRun, samplesByKey))
    .sort((a, b) =>
      a.personaKey === b.personaKey
        ? (a.promptSetVersion ?? "").localeCompare(b.promptSetVersion ?? "")
        : a.personaKey.localeCompare(b.personaKey),
    );

  const warnings: EvalReportWarning[] = [];
  for (const group of groups) {
    for (const code of group.warnings) {
      const count = code === "replicates_lt_3" ? group.replicates : group.tradingDays;
      warnings.push({
        group: { personaKey: group.personaKey, promptSetVersion: group.promptSetVersion },
        code,
        message: warningMessage(code, count),
      });
    }
  }

  return {
    start: input.start,
    end: input.end,
    judgeKey: input.judgeKey,
    simIds: [...input.simIds],
    groups,
    warnings,
  };
}
