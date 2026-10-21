/**
 * judgeBatch tests over an in-memory Drizzle double and a mocked `runPrompt`
 * (the MCP `run_prompt` transport) — no live network, no live DB. The double
 * answers the three reads (runs, positions, already-scored keys) by table name
 * and applies the insert/upsert by its natural key, which is exactly the
 * behavior the scored → skipped → force-rescored lifecycle depends on.
 */

import { getTableName, type Table } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuns, portfolioPositions, runEvalScores } from "@model_md/database";
import type { DbClient } from "@model_md/market-data";
import { assertJudgeTarget, JudgeTargetError, runJudgeBatch } from "./judgeBatch.js";
import { runPrompt } from "./mcpClient.js";

vi.mock("../env.js", () => ({
  env: {
    SUPABASE_URL: "http://supabase.test",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    DECISION_PROVIDER: "deterministic",
    JUDGE_MODEL: "test/judge-model",
    MCP_GATEWAY_URL: "http://mcp-gateway:8811/mcp",
    MCP_GATEWAY_AUTH_TOKEN: "test-token",
  },
}));

vi.mock("./mcpClient.js", () => ({ runPrompt: vi.fn() }));

const COMPLETION = {
  scores: {
    c1_thesis_evidence_fit: 4,
    c2_internal_consistency: 3,
    c3_risk_logic_coherence: 5,
    c4_position_sizing_logic: 2,
    c5_macro_context_reasoning: 3,
  },
  overall: 4,
  verdict: "Process looks coherent across the book.",
};

interface RunRow {
  id: number;
  roundId: string;
  simulationId: string | null;
  agentKey: string;
  window: string;
  roundSeq: number;
  rationale: string | null;
  asOfTradeDate: string | null;
}

interface PositionRow {
  agentRunId: number;
  symbol: string;
  targetWeight: string;
  thesis: string | null;
}

interface ScoreRow {
  agentRunId: number;
  judgeKey: string;
  judgeVersion: string;
  scores: Record<string, unknown>;
  verdict: string;
  judgeModel: string;
}

const AGENT_RUNS = getTableName(agentRuns);
const PORTFOLIO_POSITIONS = getTableName(portfolioPositions);
const RUN_EVAL_SCORES = getTableName(runEvalScores);

class FakeJudgeDb {
  readonly runs: RunRow[] = [];
  readonly positions: PositionRow[] = [];
  readonly scores: ScoreRow[] = [];
  readonly conflictCalls: { target?: unknown[]; set?: Record<string, unknown> }[] = [];

  select(): FakeQuery {
    return new FakeQuery(this);
  }

  insert(table: Table): FakeQuery {
    return new FakeQuery(this, "insert", getTableName(table));
  }

  upsertScore(values: Record<string, unknown>): void {
    const row = values as unknown as ScoreRow;
    const index = this.scores.findIndex(
      (existing) =>
        existing.agentRunId === row.agentRunId &&
        existing.judgeKey === row.judgeKey &&
        existing.judgeVersion === row.judgeVersion,
    );
    if (index >= 0) this.scores[index] = row;
    else this.scores.push(row);
  }
}

class FakeQuery {
  readonly #db: FakeJudgeDb;
  readonly #op: "select" | "insert";
  readonly #table: string;
  #values: Record<string, unknown> = {};
  #conflict: { target?: unknown[]; set?: Record<string, unknown> } | null = null;

  constructor(db: FakeJudgeDb, op: "select" | "insert" = "select", table = "") {
    this.#db = db;
    this.#op = op;
    this.#table = table;
  }

  from(table: Table): this {
    return new FakeQuery(this.#db, this.#op, getTableName(table)) as unknown as this;
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

  values(values: Record<string, unknown>): this {
    this.#values = values;
    return this;
  }

  onConflictDoUpdate(config: { target?: unknown[]; set?: Record<string, unknown> }): this {
    this.#conflict = config;
    return this;
  }

  then<TResult = unknown>(
    onFulfilled?: ((value: unknown) => TResult | PromiseLike<TResult>) | null,
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): PromiseLike<TResult> {
    const run = (): unknown => {
      if (this.#op === "insert") {
        if (this.#conflict === null) {
          // Strict: a plain INSERT of an existing natural key is a unique
          // violation in Postgres, so a dropped `.onConflictDoUpdate()` in the
          // source must fail here rather than silently upsert.
          const row = this.#values as unknown as ScoreRow;
          const duplicate = this.#db.scores.some(
            (existing) =>
              existing.agentRunId === row.agentRunId &&
              existing.judgeKey === row.judgeKey &&
              existing.judgeVersion === row.judgeVersion,
          );
          if (duplicate) {
            throw Object.assign(new Error("duplicate key value violates unique constraint"), {
              code: "23505",
            });
          }
          this.#db.scores.push(row);
          return [];
        }
        this.#db.conflictCalls.push(this.#conflict);
        this.#db.upsertScore(this.#values);
        return [];
      }
      switch (this.#table) {
        case AGENT_RUNS:
          return this.#db.runs;
        case PORTFOLIO_POSITIONS:
          return this.#db.positions;
        case RUN_EVAL_SCORES:
          return this.#db.scores;
        default:
          return [];
      }
    };
    return Promise.resolve().then(run).then(onFulfilled, onRejected);
  }
}

function asDbClient(fake: FakeJudgeDb): DbClient {
  return fake as unknown as DbClient;
}

function runRow(id: number, agentKey: string): RunRow {
  return {
    id,
    roundId: `round-${id}`,
    simulationId: "sim-t1",
    agentKey,
    window: "daily",
    roundSeq: id,
    rationale: `Rationale for run ${id}: concentrated book on the two strongest trends.`,
    asOfTradeDate: "2026-09-24",
  };
}

function okRunPrompt(): { text: string; attempts: number } {
  return { text: JSON.stringify(COMPLETION), attempts: 1 };
}

const runPromptMock = vi.mocked(runPrompt);

beforeEach(() => {
  runPromptMock.mockResolvedValue(okRunPrompt());
});

afterEach(() => {
  vi.clearAllMocks();
});

function seededDb(): FakeJudgeDb {
  const fake = new FakeJudgeDb();
  fake.runs.push(runRow(1, "dr-value--daily"), runRow(2, "dr-momentum--daily"));
  fake.positions.push(
    { agentRunId: 1, symbol: "NVDA", targetWeight: "0.600000", thesis: "Trend stays intact." },
    { agentRunId: 1, symbol: "MSFT", targetWeight: "0.400000", thesis: "Demand holds up." },
    { agentRunId: 2, symbol: "AMD", targetWeight: "1.000000", thesis: "Momentum leads the book." },
  );
  return fake;
}

describe("assertJudgeTarget", () => {
  it("requires exactly one target", () => {
    expect(() => assertJudgeTarget({})).toThrow(JudgeTargetError);
    expect(() => assertJudgeTarget({})).toThrow(/exactly one/);
    expect(() => assertJudgeTarget({ simulationId: "sim-a", roundIds: ["r1"] })).toThrow(
      /exactly one/,
    );
  });

  it("validates the simulation id pattern and round id entries", () => {
    expect(() => assertJudgeTarget({ simulationId: "nope" })).toThrow(/must match/);
    expect(() => assertJudgeTarget({ roundIds: [] })).toThrow(/non-empty/);
    expect(() => assertJudgeTarget({ roundIds: ["  "] })).toThrow(/roundIds\[0\]/);
  });
});

describe("runJudgeBatch", () => {
  it("scores every target run and persists one rubric-v1 row per run", async () => {
    const fake = seededDb();
    const result = await runJudgeBatch(asDbClient(fake), { simulationId: "sim-t1" });

    expect(result.judgeKey).toBe("process");
    expect(result.judgeVersion).toBe("1");
    expect(result.model).toBe("test/judge-model");
    expect(result.summary).toEqual({ scored: 2, skipped: 0, errors: 0 });
    expect(result.results.map((entry) => entry.status)).toEqual(["scored", "scored"]);
    expect(runPromptMock).toHaveBeenCalledTimes(2);
    expect(runPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "test/judge-model" }),
    );

    expect(fake.scores).toHaveLength(2);
    for (const row of fake.scores) {
      expect(row.judgeKey).toBe("process");
      expect(row.judgeVersion).toBe("1");
      expect(row.judgeModel).toBe("test/judge-model");
      expect(row.scores).toEqual({ ...COMPLETION.scores, overall: COMPLETION.overall });
      expect(row.verdict).toBe(COMPLETION.verdict);
    }
  });

  it("skips already-scored runs on a repeat of the same batch without calling the model", async () => {
    const fake = seededDb();
    await runJudgeBatch(asDbClient(fake), { simulationId: "sim-t1" });
    const callsAfterFirst = runPromptMock.mock.calls.length;

    const second = await runJudgeBatch(asDbClient(fake), { simulationId: "sim-t1" });

    expect(second.summary).toEqual({ scored: 0, skipped: 2, errors: 0 });
    expect(second.results.every((entry) => entry.status === "skipped")).toBe(true);
    expect(runPromptMock.mock.calls.length).toBe(callsAfterFirst);
    expect(fake.scores).toHaveLength(2);
  });

  it("targets the upsert at the (agentRunId, judgeKey, judgeVersion) unique index", async () => {
    const fake = seededDb();
    await runJudgeBatch(asDbClient(fake), { simulationId: "sim-t1" });

    expect(fake.conflictCalls).toHaveLength(2);
    for (const call of fake.conflictCalls) {
      expect(call.target).toEqual([
        runEvalScores.agentRunId,
        runEvalScores.judgeKey,
        runEvalScores.judgeVersion,
      ]);
    }
  });

  it("force=true re-scores and upserts in place with the model actually used", async () => {
    const fake = seededDb();
    await runJudgeBatch(asDbClient(fake), { simulationId: "sim-t1" });

    const forced = await runJudgeBatch(asDbClient(fake), {
      simulationId: "sim-t1",
      force: true,
      judgeModel: "alt/judge-model",
    });

    expect(forced.summary).toEqual({ scored: 2, skipped: 0, errors: 0 });
    expect(forced.model).toBe("alt/judge-model");
    expect(fake.scores).toHaveLength(2);
    for (const row of fake.scores) {
      expect(row.judgeModel).toBe("alt/judge-model");
    }
  });

  it("records a failed gateway run as an error without persisting", async () => {
    const fake = seededDb();
    runPromptMock.mockRejectedValueOnce(new Error("run_prompt failed: bad request"));

    const result = await runJudgeBatch(asDbClient(fake), { roundIds: ["round-1", "round-2"] });

    expect(result.summary).toEqual({ scored: 1, skipped: 0, errors: 1 });
    expect(result.results[0]?.status).toBe("error");
    expect(result.results[0]?.error).toContain("bad request");
    expect(fake.scores).toHaveLength(1);
    expect(fake.scores[0]?.agentRunId).toBe(2);
  });

  it("rejects a malformed target before touching the database", async () => {
    const fake = seededDb();
    await expect(runJudgeBatch(asDbClient(fake), {})).rejects.toThrow(/exactly one/);
    expect(fake.scores).toHaveLength(0);
  });
});
