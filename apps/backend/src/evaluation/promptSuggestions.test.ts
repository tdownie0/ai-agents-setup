/**
 * promptSuggestions tests over an in-memory Drizzle double and a mocked
 * `fetch` — no live network, no live DB. The double answers the reads
 * (existing suggestion, failure digest, list) by table name and applies the
 * insert/upsert by the full unique key, which is exactly the behavior the
 * generated → skipped → force-regenerated lifecycle depends on.
 */

import { getTableName, type Table } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuns, promptSuggestions } from "@model_md/database";
import type { DbClient } from "@model_md/market-data";
import { getPromptSetDefinition, PROMPT_SET_VERSION } from "@model_md/agent-orchestrator";
import type { AnalystWindow } from "@model_md/agent-orchestrator";
import { listSuggestions, runSuggestionBatch } from "./promptSuggestions.js";

vi.mock("../env.js", () => ({
  env: {
    SUPABASE_URL: "http://supabase.test",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    DECISION_PROVIDER: "deterministic",
    JUDGE_API_KEY: "test-judge-key",
    JUDGE_API_BASE: "https://judge.test/api/v1",
    JUDGE_MODEL: "test/critic-model",
  },
}));

const COMPLETION = {
  critiques: "The complete-book rule leaves an omission ambiguous.",
  proposals: [
    {
      component: "complete_book_rule",
      kind: "clarify",
      severity: "high",
      problem: "Omitted holdings are not addressed.",
      currentText: "every symbol listed in HOLDINGS MUST have a line in positions.",
      proposedText: "every symbol listed in HOLDINGS MUST have a line in positions.",
      rationale: "Removes the ambiguity behind the failures.",
    },
  ],
};

interface SuggestionRow {
  id: number;
  personaKey: string;
  window: string;
  promptSetVersion: string;
  sourcePromptHash: string;
  judgeKey: string;
  judgeVersion: string;
  critiques: string;
  proposals: unknown;
  judgeModel: string;
  createdAt: Date;
}

interface FailureRow {
  agentKey: string;
  promptSetVersion: string | null;
  status: string;
  error: string | null;
}

const AGENT_RUNS = getTableName(agentRuns);
const PROMPT_SUGGESTIONS = getTableName(promptSuggestions);

class FakeSuggestionDb {
  readonly suggestions: SuggestionRow[] = [];
  readonly failures: FailureRow[] = [];
  readonly conflictCalls: { target?: unknown[]; set?: Record<string, unknown> }[] = [];
  #nextId = 1;

  select(): FakeQuery {
    return new FakeQuery(this);
  }

  insert(table: Table): FakeQuery {
    return new FakeQuery(this, "insert", getTableName(table));
  }

  upsertSuggestion(values: Record<string, unknown>): number {
    const row = values as unknown as Omit<SuggestionRow, "id" | "createdAt">;
    const index = this.suggestions.findIndex(
      (existing) =>
        existing.personaKey === row.personaKey &&
        existing.window === row.window &&
        existing.promptSetVersion === row.promptSetVersion &&
        existing.sourcePromptHash === row.sourcePromptHash &&
        existing.judgeKey === row.judgeKey &&
        existing.judgeVersion === row.judgeVersion,
    );
    if (index >= 0) {
      const id = this.suggestions[index]?.id ?? this.#nextId++;
      this.suggestions[index] = { ...row, id, createdAt: new Date() };
      return id;
    }
    const id = this.#nextId++;
    this.suggestions.push({ ...row, id, createdAt: new Date() });
    return id;
  }
}

class FakeQuery {
  readonly #db: FakeSuggestionDb;
  readonly #op: "select" | "insert";
  readonly #table: string;
  #values: Record<string, unknown> = {};
  #conflict: { target?: unknown[]; set?: Record<string, unknown> } | null = null;
  #where: SQL | undefined;

  constructor(db: FakeSuggestionDb, op: "select" | "insert" = "select", table = "") {
    this.#db = db;
    this.#op = op;
    this.#table = table;
  }

  from(table: Table): this {
    return new FakeQuery(this.#db, this.#op, getTableName(table)) as unknown as this;
  }

  where(condition: SQL | undefined): this {
    this.#where = condition;
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

  returning(): this {
    return this;
  }

  then<TResult = unknown>(
    onFulfilled?: ((value: unknown) => TResult | PromiseLike<TResult>) | null,
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): PromiseLike<TResult> {
    const run = (): unknown => {
      if (this.#op === "insert") {
        if (this.#conflict === null) {
          throw new Error("prompt_suggestions insert must upsert on the full unique key");
        }
        this.#db.conflictCalls.push(this.#conflict);
        const id = this.#db.upsertSuggestion(this.#values);
        return [{ id }];
      }
      switch (this.#table) {
        case AGENT_RUNS:
          return this.#db.failures.filter((row) => matchesWhere(this.#where, row));
        case PROMPT_SUGGESTIONS:
          return this.#db.suggestions.filter((row) => matchesWhere(this.#where, row));
        default:
          return [];
      }
    };
    return Promise.resolve().then(run).then(onFulfilled, onRejected);
  }
}

/**
 * Evaluate the subset of Drizzle SQL the service builds: `eq`/`like`/`or`/`and`
 * over column comparisons. Enough to make the fake honor the real filters
 * (persona/window/version/hash/judge key, agentKey prefix, status).
 */
function matchesWhere(condition: SQL | undefined, row: object): boolean {
  if (condition === undefined) return true;
  const chunks = (condition as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
  const children: unknown[] = [];
  let combinator: "and" | "or" = "and";
  for (const chunk of chunks) {
    if (typeof chunk !== "object" || chunk === null) continue;
    const name = chunk.constructor?.name;
    if (name === "SQL") {
      children.push(chunk);
    } else if (name === "StringChunk") {
      const text = String((chunk as { value: unknown }).value);
      if (/\bor\b/i.test(text)) combinator = "or";
    }
  }
  if (children.length === 0) return matchesLeaf(condition, row);
  const results = children.map((child) => matchesWhere(child as SQL, row));
  return combinator === "or" ? results.some(Boolean) : results.every(Boolean);
}

/** Evaluate one leaf `eq`/`like` comparison, or recurse into a nested SQL. */
function matchesLeaf(condition: SQL, row: object): boolean {
  const chunks = (condition as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
  let column: { name: string; table?: object } | undefined;
  let op: "eq" | "like" | undefined;
  let value: unknown;
  for (const chunk of chunks) {
    if (typeof chunk === "string") {
      value = chunk;
      continue;
    }
    if (typeof chunk !== "object" || chunk === null) continue;
    const name = chunk.constructor?.name;
    if (name === "PgVarchar" || name === "PgText") {
      column = chunk as { name: string; table?: object };
    } else if (name === "Param") {
      value = (chunk as { value: unknown }).value;
    } else if (name === "StringChunk") {
      const text = String((chunk as { value: unknown }).value);
      if (text.includes("=")) op = "eq";
      else if (text.includes("like")) op = "like";
    }
  }
  if (column === undefined || op === undefined) return true;
  const key = jsKeyFor(column);
  const actual = (row as Record<string, unknown>)[key];
  if (op === "eq") return actual === value;
  const prefix = String(value).replace(/%$/, "");
  return typeof actual === "string" && actual.startsWith(prefix);
}

/** Map a Drizzle column's DB name back to the row's JS property key. */
function jsKeyFor(column: { name: string; table?: object }): string {
  const table = column.table as Record<string, unknown> | undefined;
  if (table !== undefined) {
    for (const [key, value] of Object.entries(table)) {
      if (
        typeof value === "object" &&
        value !== null &&
        (value as { name?: string }).name === column.name
      ) {
        return key;
      }
    }
  }
  return column.name;
}

function asDbClient(fake: FakeSuggestionDb): DbClient {
  return fake as unknown as DbClient;
}

function okCompletion(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(COMPLETION) } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => okCompletion());

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function seedFailure(fake: FakeSuggestionDb, personaKey: string, window: AnalystWindow): void {
  const def = getPromptSetDefinition(personaKey, window);
  fake.failures.push(
    {
      agentKey: def.agentKey,
      promptSetVersion: def.promptSetVersion,
      status: "failed",
      error: "positions must sum to 1.0 (±0.01)",
    },
    {
      agentKey: `${def.agentKey}#rep1`,
      promptSetVersion: def.promptSetVersion,
      status: "failed",
      error: "missing exit line for held symbol KO",
    },
    {
      agentKey: def.agentKey,
      promptSetVersion: def.promptSetVersion,
      status: "completed",
      error: null,
    },
  );
}

describe("runSuggestionBatch", () => {
  it("generates one suggestion per window and upserts on the full unique key", async () => {
    const fake = new FakeSuggestionDb();
    const result = await runSuggestionBatch(asDbClient(fake), { personaKey: "dr-value" });

    expect(result.judgeKey).toBe("prompt-critic");
    expect(result.judgeVersion).toBe("1");
    expect(result.model).toBe("test/critic-model");
    expect(result.promptSetVersion).toBe(PROMPT_SET_VERSION);
    expect(result.summary).toEqual({ generated: 3, skipped: 0, errors: 0 });
    expect(result.results.map((entry) => entry.window)).toEqual(["daily", "weekly", "monthly"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fake.suggestions).toHaveLength(3);
    for (const row of fake.suggestions) {
      expect(row.judgeKey).toBe("prompt-critic");
      expect(row.judgeVersion).toBe("1");
      expect(row.judgeModel).toBe("test/critic-model");
      expect(row.critiques).toBe(COMPLETION.critiques);
    }
    for (const call of fake.conflictCalls) {
      expect(call.target).toEqual([
        promptSuggestions.personaKey,
        promptSuggestions.window,
        promptSuggestions.promptSetVersion,
        promptSuggestions.sourcePromptHash,
        promptSuggestions.judgeKey,
        promptSuggestions.judgeVersion,
      ]);
    }
  });

  it("skips an existing row on a repeat without calling the model", async () => {
    const fake = new FakeSuggestionDb();
    await runSuggestionBatch(asDbClient(fake), { personaKey: "dr-value", window: "weekly" });
    const callsAfterFirst = fetchMock.mock.calls.length;

    const second = await runSuggestionBatch(asDbClient(fake), {
      personaKey: "dr-value",
      window: "weekly",
    });

    expect(second.summary).toEqual({ generated: 0, skipped: 1, errors: 0 });
    expect(second.results[0]?.status).toBe("skipped");
    expect(second.results[0]?.suggestionId).toBeDefined();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    expect(fake.suggestions).toHaveLength(1);
  });

  it("force=true regenerates and upserts in place", async () => {
    const fake = new FakeSuggestionDb();
    await runSuggestionBatch(asDbClient(fake), { personaKey: "dr-value", window: "weekly" });

    const forced = await runSuggestionBatch(asDbClient(fake), {
      personaKey: "dr-value",
      window: "weekly",
      force: true,
      model: "alt/critic-model",
    });

    expect(forced.summary).toEqual({ generated: 1, skipped: 0, errors: 0 });
    expect(forced.model).toBe("alt/critic-model");
    expect(fake.suggestions).toHaveLength(1);
    expect(fake.suggestions[0]?.judgeModel).toBe("alt/critic-model");
  });

  it("records one window's failure as an error without aborting the others", async () => {
    const fake = new FakeSuggestionDb();
    fetchMock.mockResolvedValueOnce(new Response("bad request", { status: 400 }));

    const result = await runSuggestionBatch(asDbClient(fake), { personaKey: "dr-value" });

    expect(result.summary).toEqual({ generated: 2, skipped: 0, errors: 1 });
    expect(result.results[0]?.status).toBe("error");
    expect(result.results[0]?.error).toContain("HTTP 400");
    expect(result.results[1]?.status).toBe("generated");
    expect(result.results[2]?.status).toBe("generated");
    expect(fake.suggestions).toHaveLength(2);
  });

  it("digests only failed runs of the matching prompt set", async () => {
    const fake = new FakeSuggestionDb();
    seedFailure(fake, "dr-value", "weekly");
    await runSuggestionBatch(asDbClient(fake), { personaKey: "dr-value", window: "weekly" });

    const call = fetchMock.mock.calls[0]?.[1] as unknown as RequestInit | undefined;
    const body = JSON.parse(String(call?.body)) as {
      messages: { role: string; content: string }[];
    };
    const user = body.messages.find((message) => message.role === "user")?.content ?? "";
    expect(user).toContain("positions must sum to 1.0");
    expect(user).toContain("missing exit line for held symbol KO");
    expect(user).toContain("totalFailures");
  });
});

describe("listSuggestions", () => {
  it("returns rows augmented with isCurrent and passes filters through", async () => {
    const fake = new FakeSuggestionDb();
    await runSuggestionBatch(asDbClient(fake), { personaKey: "dr-value", window: "weekly" });

    const rows = await listSuggestions(asDbClient(fake), {
      personaKey: "dr-value",
      window: "weekly",
      promptSetVersion: PROMPT_SET_VERSION,
    });

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.personaKey).toBe("dr-value");
    expect(row?.window).toBe("weekly");
    expect(row?.isCurrent).toBe(true);
    expect(typeof row?.createdAt).toBe("string");
    expect(row?.proposals).toEqual(COMPLETION.proposals);
  });

  it("marks a stale prompt hash as not current", async () => {
    const fake = new FakeSuggestionDb();
    const def = getPromptSetDefinition("dr-value", "weekly");
    fake.suggestions.push({
      id: 1,
      personaKey: "dr-value",
      window: "weekly",
      promptSetVersion: def.promptSetVersion,
      sourcePromptHash: "0".repeat(64),
      judgeKey: "prompt-critic",
      judgeVersion: "1",
      critiques: "stale",
      proposals: [],
      judgeModel: "test/critic-model",
      createdAt: new Date(),
    });

    const rows = await listSuggestions(asDbClient(fake), { personaKey: "dr-value" });
    expect(rows[0]?.isCurrent).toBe(false);
  });
});
