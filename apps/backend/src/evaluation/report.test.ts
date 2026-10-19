/**
 * buildEvalReport tests over an in-memory Drizzle double — no live DB, no
 * network. The double answers SELECTs by table name without emulating SQL
 * predicates, so fixtures are consistent with the query predicates (only the
 * requested sims, dates inside any provided bounds), exactly like the
 * judgeBatch double; grouping, stats, warnings, and the reused evalMetrics
 * math are asserted on the real code paths.
 */

import { getTableName, type Table } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  agentPortfolioState,
  agentRuns,
  portfolioEquityDaily,
  runEvalScores,
} from "@model_md/database";
import type { DbClient } from "@model_md/market-data";
import { buildEvalReport } from "./report.js";
import type {
  EvalReport,
  RawReportRunRow,
  ReportScoreRow,
  ReportStateRow,
} from "./reportAggregates.js";

const AGENT_RUNS = getTableName(agentRuns);
const RUN_EVAL_SCORES = getTableName(runEvalScores);
const STATE_TABLE = getTableName(agentPortfolioState);
const EQUITY_TABLE = getTableName(portfolioEquityDaily);

interface EquityFixtureRow {
  stateId: number;
  tradeDate: string;
  cash: string;
  holdingsValue: string;
  totalValue: string;
  roundSeq: number | null;
}

class FakeReportDb {
  readonly runs: RawReportRunRow[] = [];
  readonly scores: ReportScoreRow[] = [];
  readonly states: ReportStateRow[] = [];
  readonly equity: EquityFixtureRow[] = [];

  select(): FakeQuery {
    return new FakeQuery(this);
  }
}

class FakeQuery {
  readonly #db: FakeReportDb;
  #table = "";

  constructor(db: FakeReportDb) {
    this.#db = db;
  }

  from(table: Table): this {
    this.#table = getTableName(table);
    return this;
  }

  where(): this {
    return this;
  }

  innerJoin(): this {
    return this;
  }

  orderBy(): this {
    return this;
  }

  then<TResult = unknown>(
    onFulfilled?: ((value: unknown) => TResult | PromiseLike<TResult>) | null,
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): PromiseLike<TResult> {
    switch (this.#table) {
      case AGENT_RUNS:
        return Promise.resolve(this.#db.runs).then(onFulfilled, onRejected);
      case RUN_EVAL_SCORES:
        return Promise.resolve(this.#db.scores).then(onFulfilled, onRejected);
      case STATE_TABLE:
        return Promise.resolve(this.#db.states).then(onFulfilled, onRejected);
      case EQUITY_TABLE:
        return Promise.resolve(this.#db.equity).then(onFulfilled, onRejected);
      default:
        return Promise.resolve([]).then(onFulfilled, onRejected);
    }
  }
}

function asDbClient(fake: FakeReportDb): DbClient {
  return fake as unknown as DbClient;
}

const dateAt = (day: number): string => `2026-03-${String(day).padStart(2, "0")}`;

interface RunSpec {
  id: number;
  simId: string;
  agentKey: string;
  date: string;
  promptSetVersion: string | null;
  promptHash: string | null;
  window?: RawReportRunRow["window"];
}

function runRow(spec: RunSpec): RawReportRunRow {
  return {
    id: spec.id,
    simulationId: spec.simId,
    agentKey: spec.agentKey,
    window: spec.window ?? "daily",
    promptSetVersion: spec.promptSetVersion,
    promptHash: spec.promptHash,
    asOfTradeDate: spec.date,
  };
}

interface ScoreSpec {
  runId: number;
  judgeVersion: string;
  judgeModel: string;
  score: number;
}

function scoreRow(spec: ScoreSpec): ReportScoreRow {
  return {
    agentRunId: spec.runId,
    judgeVersion: spec.judgeVersion,
    judgeModel: spec.judgeModel,
    scores: {
      c1_thesis_evidence_fit: spec.score,
      c2_internal_consistency: spec.score,
      c3_risk_logic_coherence: spec.score,
      c4_position_sizing_logic: spec.score,
      c5_macro_context_reasoning: spec.score,
      overall: spec.score,
    },
  };
}

function groupOf(report: EvalReport, version: string | null) {
  const group = report.groups.find((entry) => entry.promptSetVersion === version);
  if (group === undefined) throw new Error(`no group for version ${String(version)}`);
  return group;
}

describe("buildEvalReport grouping", () => {
  function comparisonDb(): FakeReportDb {
    const fake = new FakeReportDb();
    // v1: three replicates × 20 decide dates, persona dr-value.
    for (const [simIndex, simId] of ["sim-a", "sim-b", "sim-c"].entries()) {
      const hash = simId === "sim-c" ? "hash-aaa" : simId === "sim-a" ? "hash-aaa" : "hash-bbb";
      for (let day = 1; day <= 20; day += 1) {
        fake.runs.push(
          runRow({
            id: simIndex * 20 + day,
            simId,
            agentKey: "dr-value--daily",
            date: dateAt(day),
            promptSetVersion: "v1",
            promptHash: hash,
          }),
        );
      }
    }
    // v2: one replicate × 5 decide dates, same persona — the compared version.
    for (let day = 1; day <= 5; day += 1) {
      fake.runs.push(
        runRow({
          id: 60 + day,
          simId: "sim-x",
          agentKey: "dr-value--daily",
          date: dateAt(day),
          promptSetVersion: "v2",
          promptHash: "hash-ccc",
        }),
      );
    }
    // Score sim-a's first 19 runs with a 1..5 cycle; score every v2 run.
    for (let day = 1; day <= 19; day += 1) {
      fake.scores.push({
        ...scoreRow({ runId: day, judgeVersion: "1", judgeModel: "model-x", score: 4 }),
        scores: {
          c1_thesis_evidence_fit: ((day - 1) % 5) + 1,
          c2_internal_consistency: 4,
          c3_risk_logic_coherence: 3,
          c4_position_sizing_logic: 2,
          c5_macro_context_reasoning: 5,
          overall: 4,
        },
      });
    }
    for (let day = 1; day <= 5; day += 1) {
      fake.scores.push(
        scoreRow({ runId: 60 + day, judgeVersion: "1", judgeModel: "model-y", score: 3 }),
      );
    }
    return fake;
  }

  const SIM_IDS = ["sim-a", "sim-b", "sim-c", "sim-x"];

  it("groups runs by persona × prompt version with counts, replicates, dates, and hashes", async () => {
    const report = await buildEvalReport(asDbClient(comparisonDb()), { simIds: SIM_IDS });

    expect(report.judgeKey).toBe("process");
    expect(report.simIds).toEqual(SIM_IDS);
    expect(report.start).toBe("2026-03-01");
    expect(report.end).toBe("2026-03-20");
    expect(report.groups.map((group) => group.promptSetVersion)).toEqual(["v1", "v2"]);

    const v1 = groupOf(report, "v1");
    expect(v1.personaKey).toBe("dr-value");
    expect(v1.runs).toBe(60);
    expect(v1.scoredRuns).toBe(19);
    expect(v1.unscoredRuns).toBe(41);
    expect(v1.replicates).toBe(3);
    expect(v1.tradingDays).toBe(20);
    expect(v1.promptHashes).toEqual(["hash-aaa", "hash-bbb"]);
    expect(v1.warnings).toEqual([]);
    expect(v1.windows.daily).toMatchObject({ runs: 60, replicates: 3 });

    const v2 = groupOf(report, "v2");
    expect(v2.runs).toBe(5);
    expect(v2.scoredRuns).toBe(5);
    expect(v2.unscoredRuns).toBe(0);
    expect(v2.replicates).toBe(1);
    expect(v2.tradingDays).toBe(5);
    expect(v2.promptHashes).toEqual(["hash-ccc"]);
    expect(v2.warnings).toEqual(["replicates_lt_3", "trading_days_lt_20"]);
  });

  it("summarizes each criterion with mean/median/min/max over the group's scored runs", async () => {
    const report = await buildEvalReport(asDbClient(comparisonDb()), { simIds: SIM_IDS });

    const v1 = groupOf(report, "v1");
    expect(v1.judge.judgeModels).toEqual(["model-x"]);
    // c1 cycles 1..5 across 19 scored runs: sum 55 → mean 55/19 rounded to 4 dp.
    expect(v1.judge.criteria.c1_thesis_evidence_fit).toEqual({
      mean: 2.8947,
      median: 3,
      min: 1,
      max: 5,
    });
    expect(v1.judge.criteria.c2_internal_consistency).toEqual({
      mean: 4,
      median: 4,
      min: 4,
      max: 4,
    });
    expect(v1.judge.criteria.c5_macro_context_reasoning).toEqual({
      mean: 5,
      median: 5,
      min: 5,
      max: 5,
    });
    expect(v1.judge.criteria.overall).toEqual({ mean: 4, median: 4, min: 4, max: 4 });
    expect(Object.keys(v1.judge.criteria)).toEqual([
      "c1_thesis_evidence_fit",
      "c2_internal_consistency",
      "c3_risk_logic_coherence",
      "c4_position_sizing_logic",
      "c5_macro_context_reasoning",
      "overall",
    ]);

    const v2 = groupOf(report, "v2");
    expect(v2.judge.judgeModels).toEqual(["model-y"]);
    expect(v2.judge.criteria.overall).toEqual({ mean: 3, median: 3, min: 3, max: 3 });
  });

  it("emits low-n warnings with noise messaging only on the small group", async () => {
    const report = await buildEvalReport(asDbClient(comparisonDb()), { simIds: SIM_IDS });

    expect(report.warnings).toHaveLength(2);
    expect(report.warnings.every((warning) => warning.group.promptSetVersion === "v2")).toBe(true);
    expect(report.warnings.map((warning) => warning.code)).toEqual([
      "replicates_lt_3",
      "trading_days_lt_20",
    ]);
    expect(report.warnings[0]?.message).toBe(
      "replicates=1 below 3: deltas below 3 replicates are noise",
    );
    expect(report.warnings[1]?.message).toBe(
      "tradingDays=5 below 20: deltas below 20 trading days are noise",
    );
    expect(report.warnings[0]?.group.personaKey).toBe("dr-value");
  });

  it("echoes provided bounds as the effective range", async () => {
    const fake = new FakeReportDb();
    fake.runs.push(
      runRow({
        id: 1,
        simId: "sim-solo",
        agentKey: "dr-value--daily",
        date: "2026-04-07",
        promptSetVersion: null,
        promptHash: null,
      }),
    );
    const report = await buildEvalReport(asDbClient(fake), {
      simIds: ["sim-solo"],
      start: "2026-04-01",
      end: "2026-04-30",
    });
    expect(report.start).toBe("2026-04-01");
    expect(report.end).toBe("2026-04-30");
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]?.promptSetVersion).toBeNull();
  });

  it("returns an empty report when no runs match", async () => {
    const fake = new FakeReportDb();
    const unbounded = await buildEvalReport(asDbClient(fake), { simIds: ["sim-none"] });
    expect(unbounded).toEqual({
      start: null,
      end: null,
      judgeKey: "process",
      simIds: ["sim-none"],
      groups: [],
      warnings: [],
    });

    const bounded = await buildEvalReport(asDbClient(fake), {
      simIds: ["sim-none"],
      start: "2026-03-01",
      end: "2026-03-20",
      judgeKey: "custom",
    });
    expect(bounded.start).toBe("2026-03-01");
    expect(bounded.end).toBe("2026-03-20");
    expect(bounded.judgeKey).toBe("custom");
    expect(bounded.groups).toEqual([]);
    expect(bounded.warnings).toEqual([]);
  });
});

describe("buildEvalReport score-row selection", () => {
  it("prefers RUBRIC_VERSION, else the highest judgeVersion, per run", async () => {
    const fake = new FakeReportDb();
    fake.runs.push(
      runRow({
        id: 101,
        simId: "sim-p",
        agentKey: "dr-value--daily",
        date: "2026-04-01",
        promptSetVersion: null,
        promptHash: null,
      }),
      runRow({
        id: 102,
        simId: "sim-p",
        agentKey: "dr-value--daily",
        date: "2026-04-02",
        promptSetVersion: null,
        promptHash: null,
      }),
    );
    fake.scores.push(
      scoreRow({ runId: 101, judgeVersion: "0.9", judgeModel: "old-model", score: 1 }),
      scoreRow({ runId: 101, judgeVersion: "2", judgeModel: "future-model", score: 5 }),
      scoreRow({ runId: 102, judgeVersion: "1", judgeModel: "current-model", score: 2 }),
      scoreRow({ runId: 102, judgeVersion: "2", judgeModel: "future-model", score: 4 }),
    );

    const report = await buildEvalReport(asDbClient(fake), { simIds: ["sim-p"] });
    const group = report.groups[0];
    expect(group?.scoredRuns).toBe(2);
    // run 101 has no "1" → highest ("2", score 5); run 102 prefers "1" (score 2) over "2".
    expect(group?.judge.criteria.overall).toEqual({ mean: 3.5, median: 3.5, min: 2, max: 5 });
    expect(group?.judge.judgeModels).toEqual(["current-model", "future-model"]);
  });
});

describe("buildEvalReport window metrics (reuses evalMetrics)", () => {
  function metricsDb(): FakeReportDb {
    const fake = new FakeReportDb();
    for (const [index, simId] of ["sim-1", "sim-2", "sim-3"].entries()) {
      fake.runs.push(
        runRow({
          id: index + 1,
          simId,
          agentKey: "dr-value--daily",
          date: "2026-03-10",
          promptSetVersion: "v1",
          promptHash: null,
        }),
      );
    }
    // sim-3 has runs but no materialized stream — it must not inflate simCount.
    fake.states.push(
      { id: 101, simulationId: "sim-1", personaKey: "dr-value", window: "daily" },
      { id: 102, simulationId: "sim-2", personaKey: "dr-value", window: "daily" },
    );
    const equity = (stateId: number, values: readonly [string, number][]): EquityFixtureRow[] =>
      values.map(([tradeDate, totalValue]) => ({
        stateId,
        tradeDate,
        cash: "0",
        holdingsValue: String(totalValue),
        totalValue: String(totalValue),
        roundSeq: 1,
      }));
    // +10% per step: series returns are constant, so vol/sharpe read 0 with
    // a single measured return; total return is (121/100 − 1).
    fake.equity.push(
      ...equity(101, [
        ["2026-03-01", 100],
        ["2026-03-11", 110],
        ["2026-03-20", 121],
      ]),
    );
    // −10% per step, monotonic: drawdown −10%, total return (81/100 − 1).
    fake.equity.push(
      ...equity(102, [
        ["2026-03-01", 100],
        ["2026-03-11", 90],
        ["2026-03-20", 81],
      ]),
    );
    return fake;
  }

  const OPTS = {
    simIds: ["sim-1", "sim-2", "sim-3"],
    start: "2026-03-01",
    end: "2026-03-20",
  };

  it("averages evalMetrics output across the group's streams and counts contributing sims", async () => {
    const report = await buildEvalReport(asDbClient(metricsDb()), OPTS);
    const daily = report.groups[0]?.windows.daily;

    expect(daily?.runs).toBe(3);
    expect(daily?.replicates).toBe(3);
    expect(daily?.metrics.simCount).toBe(2);
    // mean of +21% and −19%
    expect(daily?.metrics.totalReturnPct).toBe(1);
    // mean of drawdowns 0 and −10
    expect(daily?.metrics.maxDrawdownPct).toBe(-5);
    // one measured return per stream → ranking reports 0 vol/Sharpe, not null
    expect(daily?.metrics.annualizedVolPct).toBe(0);
    expect(daily?.metrics.sharpe).toBe(0);
  });

  it("leaves windows without a stream empty instead of fabricating numbers", async () => {
    const report = await buildEvalReport(asDbClient(metricsDb()), OPTS);
    const weekly = report.groups[0]?.windows.weekly;

    expect(weekly).toEqual({
      runs: 0,
      replicates: 0,
      metrics: {
        totalReturnPct: null,
        annualizedVolPct: null,
        sharpe: null,
        maxDrawdownPct: null,
        simCount: 0,
      },
    });
    expect(report.groups[0]?.windows.monthly?.metrics.simCount).toBe(0);
  });

  it("slices the equity curve to the effective bounds, not the whole chain", async () => {
    const report = await buildEvalReport(asDbClient(metricsDb()), {
      ...OPTS,
      start: "2026-03-11",
    });
    // baseline moves to the 03-11 row: sim-1 110 → 121 = +10%, sim-2 90 → 81 = −10%
    expect(report.start).toBe("2026-03-11");
    expect(report.groups[0]?.windows.daily.metrics.totalReturnPct).toBe(0);
  });
});

describe("buildEvalReport aggregation gaps", () => {
  it("dedups prompt hashes, sorts them regardless of run order, and drops nulls", async () => {
    const fake = new FakeReportDb();
    // First-seen order is zzz, null, aaa, zzz — result must be the sorted distinct pair.
    fake.runs.push(
      runRow({
        id: 1,
        simId: "sim-h1",
        agentKey: "dr-value--daily",
        date: dateAt(1),
        promptSetVersion: "v1",
        promptHash: "hash-zzz",
      }),
      runRow({
        id: 2,
        simId: "sim-h2",
        agentKey: "dr-value--daily",
        date: dateAt(2),
        promptSetVersion: "v1",
        promptHash: null,
      }),
      runRow({
        id: 3,
        simId: "sim-h3",
        agentKey: "dr-value--daily",
        date: dateAt(3),
        promptSetVersion: "v1",
        promptHash: "hash-aaa",
      }),
      runRow({
        id: 4,
        simId: "sim-h1",
        agentKey: "dr-value--daily",
        date: dateAt(4),
        promptSetVersion: "v1",
        promptHash: "hash-zzz",
      }),
    );

    const report = await buildEvalReport(asDbClient(fake), {
      simIds: ["sim-h1", "sim-h2", "sim-h3"],
    });
    expect(report.groups[0]?.promptHashes).toEqual(["hash-aaa", "hash-zzz"]);
  });

  it("keeps different personas in separate groups at the same prompt version", async () => {
    const fake = new FakeReportDb();
    fake.runs.push(
      runRow({
        id: 1,
        simId: "sim-p1",
        agentKey: "dr-value--daily",
        date: dateAt(1),
        promptSetVersion: "v1",
        promptHash: null,
      }),
      runRow({
        id: 2,
        simId: "sim-p2",
        agentKey: "dr-momentum--daily",
        date: dateAt(1),
        promptSetVersion: "v1",
        promptHash: null,
      }),
    );

    const report = await buildEvalReport(asDbClient(fake), { simIds: ["sim-p1", "sim-p2"] });
    expect(report.groups.map((group) => group.personaKey)).toEqual(["dr-momentum", "dr-value"]);
    expect(report.groups.every((group) => group.promptSetVersion === "v1")).toBe(true);
    expect(report.groups.map((group) => group.runs)).toEqual([1, 1]);
  });

  it("splits the same persona's legacy (null-version) runs from stamped ones", async () => {
    const fake = new FakeReportDb();
    fake.runs.push(
      runRow({
        id: 1,
        simId: "sim-l",
        agentKey: "dr-value--daily",
        date: dateAt(1),
        promptSetVersion: null,
        promptHash: null,
      }),
      runRow({
        id: 2,
        simId: "sim-v",
        agentKey: "dr-value--daily",
        date: dateAt(1),
        promptSetVersion: "v1",
        promptHash: null,
      }),
    );

    const report = await buildEvalReport(asDbClient(fake), { simIds: ["sim-l", "sim-v"] });
    expect(report.groups.map((group) => group.promptSetVersion)).toEqual([null, "v1"]);
    expect(report.groups.map((group) => group.personaKey)).toEqual(["dr-value", "dr-value"]);
  });

  it("emits only the warning that actually fires when the other threshold is met", async () => {
    // 3 replicates × 5 decide dates: enough replicates, too few days.
    const enoughReplicates = new FakeReportDb();
    for (const [simIndex, simId] of ["sim-r1", "sim-r2", "sim-r3"].entries()) {
      for (let day = 1; day <= 5; day += 1) {
        enoughReplicates.runs.push(
          runRow({
            id: simIndex * 5 + day,
            simId,
            agentKey: "dr-value--daily",
            date: dateAt(day),
            promptSetVersion: "v1",
            promptHash: null,
          }),
        );
      }
    }
    const smallRange = await buildEvalReport(asDbClient(enoughReplicates), {
      simIds: ["sim-r1", "sim-r2", "sim-r3"],
    });
    expect(smallRange.groups[0]?.warnings).toEqual(["trading_days_lt_20"]);
    expect(smallRange.warnings.map((warning) => warning.code)).toEqual(["trading_days_lt_20"]);

    // 2 replicates × 20 decide dates: enough days, too few replicates.
    const fewReplicates = new FakeReportDb();
    for (const [simIndex, simId] of ["sim-q1", "sim-q2"].entries()) {
      for (let day = 1; day <= 20; day += 1) {
        fewReplicates.runs.push(
          runRow({
            id: simIndex * 20 + day,
            simId,
            agentKey: "dr-value--daily",
            date: dateAt(day),
            promptSetVersion: "v1",
            promptHash: null,
          }),
        );
      }
    }
    const longRange = await buildEvalReport(asDbClient(fewReplicates), {
      simIds: ["sim-q1", "sim-q2"],
    });
    expect(longRange.groups[0]?.warnings).toEqual(["replicates_lt_3"]);
    expect(longRange.warnings.map((warning) => warning.code)).toEqual(["replicates_lt_3"]);
  });

  it("summarizes an unscored group as null stats rather than zeros", async () => {
    const fake = new FakeReportDb();
    fake.runs.push(
      runRow({
        id: 1,
        simId: "sim-n1",
        agentKey: "dr-value--daily",
        date: dateAt(1),
        promptSetVersion: "v1",
        promptHash: null,
      }),
      runRow({
        id: 2,
        simId: "sim-n2",
        agentKey: "dr-value--daily",
        date: dateAt(2),
        promptSetVersion: "v1",
        promptHash: null,
      }),
      runRow({
        id: 3,
        simId: "sim-n3",
        agentKey: "dr-value--daily",
        date: dateAt(3),
        promptSetVersion: "v1",
        promptHash: null,
      }),
    );

    const report = await buildEvalReport(asDbClient(fake), {
      simIds: ["sim-n1", "sim-n2", "sim-n3"],
    });
    const group = report.groups[0];
    expect(group?.scoredRuns).toBe(0);
    expect(group?.unscoredRuns).toBe(3);
    expect(group?.judge.judgeModels).toEqual([]);
    expect(group?.judge.criteria.overall).toEqual({
      mean: null,
      median: null,
      min: null,
      max: null,
    });
    expect(group?.judge.criteria.c1_thesis_evidence_fit).toEqual({
      mean: null,
      median: null,
      min: null,
      max: null,
    });
  });
});
