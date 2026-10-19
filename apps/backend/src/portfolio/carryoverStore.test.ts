/**
 * Write-path tests for the carryover store (beads task 800.4, W4).
 *
 * These run against a recording double rather than Postgres, because the
 * properties under test are not "what did the query return" but "which
 * statement did the writer decide to issue" and "was the fold atomic with the
 * run insert" — and both of those are decisions, not results.
 *
 * Two of them are regressions:
 *  - a full liquidation produces zero lots, which used to short-circuit the
 *    stale-lot cleanup and leave sold positions in the cache for the next fold
 *    to resurrect;
 *  - a fold that fails after the run row is written must abort the whole
 *    transaction, or the chain silently skips a round and every retry is then
 *    blocked behind the duplicate-run guard.
 */

import { getTableName, type SQL, type Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { agentPortfolioState, agentRuns, portfolioPositionLots } from "@model_md/database";
import type { DbClient } from "@model_md/market-data";
import {
  applyStreamPlan,
  insertRunAndFold,
  type InsertRunAndFoldInput,
  type Queryable,
} from "./carryoverStore.js";
import type { StreamWritePlan } from "./carryoverPlan.js";

const dialect = new PgDialect();
const LOTS = getTableName(portfolioPositionLots);
const STATE = getTableName(agentPortfolioState);
const RUNS = getTableName(agentRuns);

interface Statement {
  table: string;
  sql: string;
  params: unknown[];
}

interface FakeOptions {
  /** Canned SELECT rows, keyed by table name. */
  results?: Record<string, unknown[]>;
  /** Canned `id` for `INSERT … RETURNING id`, keyed by table name. */
  returningIds?: Record<string, number>;
  /** Make the write to this table fail, to exercise the rollback path. */
  failOn?: { table: string; error: Error };
}

type Op = "select" | "insert" | "delete";

/**
 * A Drizzle double: every builder method returns the client so the whole chain
 * is awaitable, and the terminal `then` answers from the canned results. Only
 * DELETEs are recorded, because those are the statements whose *shape* is the
 * assertion.
 */
class FakeTx {
  readonly deletes: Statement[] = [];
  readonly inserts: { table: string; values: unknown }[] = [];
  readonly #results: Record<string, unknown[]>;
  readonly #returningIds: Record<string, number>;
  readonly #failOn: FakeOptions["failOn"];
  #op: Op = "select";
  #table = "";
  #where: SQL | undefined;

  constructor(options: FakeOptions = {}) {
    this.#results = options.results ?? {};
    this.#returningIds = options.returningIds ?? {};
    this.#failOn = options.failOn;
  }

  select(): this {
    this.#op = "select";
    this.#where = undefined;
    return this;
  }

  from(table: Table): this {
    this.#table = getTableName(table);
    return this;
  }

  insert(table: Table): this {
    this.#op = "insert";
    this.#table = getTableName(table);
    this.#where = undefined;
    return this;
  }

  delete(table: Table): this {
    this.#op = "delete";
    this.#table = getTableName(table);
    this.#where = undefined;
    return this;
  }

  values(values?: unknown): this {
    if (this.#op === "insert") {
      this.inserts.push({ table: this.#table, values });
    }
    return this;
  }

  returning(): this {
    return this;
  }

  onConflictDoUpdate(): this {
    return this;
  }

  where(condition: SQL): this {
    this.#where = condition;
    return this;
  }

  limit(): this {
    return this;
  }

  orderBy(): this {
    return this;
  }

  innerJoin(): this {
    return this;
  }

  then<TResult = unknown>(
    onFulfilled?: ((value: unknown) => TResult | PromiseLike<TResult>) | null,
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): PromiseLike<TResult> {
    if (this.#op === "delete") {
      const query =
        this.#where === undefined
          ? { sql: "", params: [] as unknown[] }
          : dialect.sqlToQuery(this.#where);
      this.deletes.push({ table: this.#table, sql: query.sql, params: query.params });
    }
    if (this.#failOn !== undefined && this.#op === "insert" && this.#table === this.#failOn.table) {
      return Promise.reject(this.#failOn.error).then(onFulfilled, onRejected);
    }
    const value =
      this.#op === "insert"
        ? [{ id: this.#returningIds[this.#table] ?? 1 }]
        : (this.#results[this.#table] ?? []);
    return Promise.resolve(value).then(onFulfilled, onRejected);
  }
}

/**
 * Drizzle's `Queryable` is a `Pick` of generic builder methods whose signatures
 * a hand-written double cannot structurally satisfy, so the double crosses the
 * boundary in exactly one place per helper. Confined here on purpose: every call
 * site below is fully typechecked against the real signature.
 */
function asQueryable(tx: FakeTx): Queryable {
  return tx as unknown as Queryable;
}

/** A client whose `transaction` records the commit/rollback decision. */
class FakeDb {
  readonly log: string[] = [];
  constructor(readonly tx: FakeTx) {}

  transaction<TResult>(run: (tx: Queryable) => Promise<TResult>): Promise<TResult> {
    this.log.push("begin");
    return run(asQueryable(this.tx)).then(
      (value) => {
        this.log.push("commit");
        return value;
      },
      (error: unknown) => {
        this.log.push("rollback");
        throw error;
      },
    );
  }
}

function asDbClient(db: FakeDb): DbClient {
  return db as unknown as DbClient;
}

/* ------------------------------------------------------------------ *
 * applyStreamPlan
 * ------------------------------------------------------------------ */

function plan(overrides: Partial<StreamWritePlan> = {}): StreamWritePlan {
  return {
    state: {
      simulationId: "sim-t1",
      personaKey: "dr-value",
      window: "daily",
      seq: 3,
      lastTradeDate: "2026-01-16",
      lastRoundId: "r3",
      initialCapital: "100000.00",
      cash: "109918.8435",
      holdingsValue: "0.0000",
      totalValue: "109918.8435",
      targetJson: [],
    },
    lots: [],
    equity: [
      {
        tradeDate: "2026-01-16",
        cash: "109918.8435",
        holdingsValue: "0.0000",
        totalValue: "109918.8435",
        roundSeq: 3,
      },
    ],
    summary: {
      seq: 3,
      cash: 109918.8435,
      holdingsValue: 0,
      totalValue: 109918.8435,
      positionCount: 0,
    },
    ...overrides,
  };
}

function openLot(symbol: string): StreamWritePlan["lots"][number] {
  return {
    symbol,
    shares: "100.0000",
    costBasis: "100.0000",
    targetWeight: "0.5000",
    openedFromRoundId: "r1",
    openedTradeDate: "2026-01-05",
    lastTradeDate: "2026-01-16",
    lastPrice: "102.0000",
    realizedPnl: "0.0000",
    thesis: null,
  };
}

function lotDelete(tx: FakeTx): Statement | undefined {
  return tx.deletes.find((statement) => statement.table === LOTS);
}

describe("applyStreamPlan stale-lot cleanup", () => {
  it("clears the cache on a full liquidation instead of skipping the cleanup", async () => {
    const tx = new FakeTx();
    await applyStreamPlan(asQueryable(tx), plan(), { reset: false });

    const deletion = lotDelete(tx);
    expect(deletion).toBeDefined();
    expect(deletion?.sql).not.toContain("not in");
    expect(deletion?.sql).toContain("state_id");
  });

  it("keeps exactly the symbols the plan still holds", async () => {
    const tx = new FakeTx();
    await applyStreamPlan(asQueryable(tx), plan({ lots: [openLot("AAPL"), openLot("MSFT")] }), {
      reset: false,
    });

    const deletion = lotDelete(tx);
    expect(deletion?.sql).toContain("not in");
    expect(deletion?.params).toEqual(expect.arrayContaining([1, "AAPL", "MSFT"]));
  });

  it("does not re-delete by symbol when rebuilding, which already cleared the table", async () => {
    const tx = new FakeTx();
    await applyStreamPlan(asQueryable(tx), plan({ lots: [openLot("AAPL")] }), { reset: true });

    expect(tx.deletes).toEqual([]);
  });

  it("writes nothing for a stream that has never had a round", async () => {
    const tx = new FakeTx();
    const applied = await applyStreamPlan(asQueryable(tx), plan({ state: null }), { reset: false });

    expect(applied).toBeNull();
    expect(tx.deletes).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * insertRunAndFold — R5 atomicity
 * ------------------------------------------------------------------ */

const DECIDE_DATE = "2026-01-05";

/** Inputs whose fold is driven entirely by the canned rows in `FakeTx`. */
function runInput(overrides: Partial<InsertRunAndFoldInput> = {}): InsertRunAndFoldInput {
  return {
    simulationId: "sim-t1",
    roundSeq: 1,
    basisCapital: 100000,
    targets: [],
    theses: new Map(),
    entryPrices: {},
    positions: [],
    run: {
      roundId: "r1",
      agentKey: "dr-value--daily",
      persona: "Value",
      strategy: "fundamentals",
      window: "daily",
      portfolioValue: 100000,
      rationale: null,
      decisionJson: { targets: [] },
      replicateOf: null,
      startedAt: new Date(`${DECIDE_DATE}T00:00:00Z`),
    },
    ...overrides,
  };
}

/** A fold that starts from an empty stream and an empty bar set. */
function emptyStreamRows(): Record<string, unknown[]> {
  return {
    agent_runs: [],
    round_jobs: [{ asOfTradeDate: DECIDE_DATE }],
    agent_portfolio_state: [],
  };
}

describe("insertRunAndFold", () => {
  it("commits the run and its state advance together", async () => {
    const db = new FakeDb(
      new FakeTx({ results: emptyStreamRows(), returningIds: { agent_runs: 7 } }),
    );

    const result = await insertRunAndFold(asDbClient(db), runInput());

    expect(db.log).toEqual(["begin", "commit"]);
    expect(result.agentRunId).toBe(7);
    expect(result.state.seq).toBe(1);
    expect(result.state.totalValue).toBeCloseTo(100000, 6);
  });

  it("rolls the whole transaction back when the state fold fails", async () => {
    const boom = new Error("fold exploded");
    const db = new FakeDb(
      new FakeTx({ results: emptyStreamRows(), failOn: { table: STATE, error: boom } }),
    );

    await expect(insertRunAndFold(asDbClient(db), runInput())).rejects.toThrow("fold exploded");
    expect(db.log).toEqual(["begin", "rollback"]);
  });

  it("refuses a run whose stream state never advanced, rather than leaving it committed", async () => {
    // The failure is injected AFTER the agent_runs insert, so a writer that
    // committed the run anyway would deadlock every retry behind the
    // duplicate-run guard — this is the exact half-state R5 forbids.
    const db = new FakeDb(
      new FakeTx({
        results: emptyStreamRows(),
        failOn: { table: STATE, error: new Error("late failure") },
      }),
    );

    await expect(insertRunAndFold(asDbClient(db), runInput())).rejects.toThrow("late failure");
    expect(db.log).not.toContain("commit");
  });

  it("maps a unique violation from any step to the duplicate-run guard", async () => {
    const unique = Object.assign(new Error("duplicate key"), { code: "23505" });
    const db = new FakeDb(
      new FakeTx({ results: emptyStreamRows(), failOn: { table: STATE, error: unique } }),
    );

    await expect(insertRunAndFold(asDbClient(db), runInput())).rejects.toThrow(
      /already exists for round "r1"/,
    );
    expect(db.log).toEqual(["begin", "rollback"]);
  });

  it("rejects a round that has no decide date to fold at", async () => {
    const db = new FakeDb(new FakeTx({ results: { ...emptyStreamRows(), round_jobs: [] } }));

    await expect(insertRunAndFold(asDbClient(db), runInput())).rejects.toThrow(/as_of_trade_date/);
    expect(db.log).toEqual(["begin", "rollback"]);
  });

  it("carries the prompt-set stamps onto the agent_runs insert", async () => {
    const tx = new FakeTx({ results: emptyStreamRows(), returningIds: { agent_runs: 7 } });
    const db = new FakeDb(tx);
    const input = runInput();

    await insertRunAndFold(asDbClient(db), {
      ...input,
      run: { ...input.run, promptSetVersion: "v1", promptHash: "e3b0c44298fc" },
    });

    const runInsert = tx.inserts.find((statement) => statement.table === RUNS);
    expect(runInsert).toBeDefined();
    const values = runInsert?.values as Record<string, unknown>;
    expect(values.promptSetVersion).toBe("v1");
    expect(values.promptHash).toBe("e3b0c44298fc");
  });

  it("stores NULL stamps when the caller omits them, so unstamped orchestrators still insert", async () => {
    const tx = new FakeTx({ results: emptyStreamRows(), returningIds: { agent_runs: 7 } });
    const db = new FakeDb(tx);

    await insertRunAndFold(asDbClient(db), runInput());

    const runInsert = tx.inserts.find((statement) => statement.table === RUNS);
    expect(runInsert).toBeDefined();
    const values = runInsert?.values as Record<string, unknown>;
    expect(values.promptSetVersion).toBeNull();
    expect(values.promptHash).toBeNull();
  });
});
