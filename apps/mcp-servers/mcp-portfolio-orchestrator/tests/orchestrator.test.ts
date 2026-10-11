/**
 * Unit tests for the portfolio-orchestrator MCP server.
 *
 * `src/index.ts` is intentionally NOT imported (it connects the stdio
 * transport at module scope and requires runtime env). Everything tested
 * here is a parameter-driven module: config,
      booking: BOOKING, agent resolution, the bounded
 * pool, the backend client (stubbed fetch), the docker-exec spawner (injected
 * exec), the durable round store, and the round runner (injected store +
 * spawner).
 *
 * The runner/store tests are the regression net for the original failure: the
 * docker MCP gateway runs this server as a throwaway container per tool call,
 * so unawaited work died mid-round and in-memory state was unreachable from the
 * next call. Progress must therefore be persisted through the store, and
 * `start_agent_round` must await the pool.
 */

import { describe, expect, it, vi } from "vitest";
import type { DecisionHolding } from "@model_md/agent-orchestrator";
import {
  datasetPathFor,
  isValidRoundId,
  parseWindows,
  resolveAgents,
  type AgentJob,
} from "../src/agents.js";
import { createBackendClient, BackendError } from "../src/backendClient.js";
import { loadConfig, parsePositiveInt, ConfigError } from "../src/config.js";
import { runPool, selectDueJobs } from "../src/jobs.js";
import {
  createRoundStore,
  deriveFinalStatus,
  RoundAlreadyLaunchedError,
  RoundJobMissingError,
} from "../src/roundStore.js";
import { runAgents, type DatasetWire } from "../src/runner.js";
import { createSimulationStore, type SimulationWire } from "../src/simulationStore.js";
import type { OrchestratorConfig } from "../src/config.js";
import { streamBook } from "../src/streamBook.js";
import { createBookLoader } from "../src/bookLoader.js";
import {
  buildAgentStateDirs,
  buildDockerExecArgs,
  spawnAnalystWithExec,
  type ExecImpl,
  type SpawnViaDockerOptions,
} from "../src/spawnViaDocker.js";

const fakeResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

const VALID_ENVELOPE = {
  schemaVersion: 2,
  roundId: "w1",
  simulationId: "sim-w1",
  roundSeq: 1,
  agent: {
    agentKey: "dr-value--monthly",
    persona: "Dr. Value",
    strategy: "deep-value",
    window: "monthly",
    portfolioValue: 100000,
    cash: 100000,
    holdingsValue: 0,
    priorRoundId: null,
    roundSeq: 1,
  },
  rationale: "Tests need a valid envelope.",
  positions: [
    { symbol: "AAPL", targetWeight: 0.2, thesis: "Quality franchise." },
    { symbol: "MSFT", targetWeight: 0.2, thesis: "Cloud strength." },
    { symbol: "KO", targetWeight: 0.2, thesis: "Defensive staple." },
    { symbol: "PG", targetWeight: 0.2, thesis: "Consumer defensive." },
    { symbol: "JNJ", targetWeight: 0.2, thesis: "Healthcare leader." },
  ],
};

const UNIVERSE = ["AAPL", "MSFT", "KO", "PG", "JNJ", "TSLA", "XOM"] as const;
const SYMBOLS_WITH_PRICE = new Set<string>(["AAPL", "MSFT", "KO", "PG", "JNJ", "TSLA", "XOM"]);
/** A stream that has not been folded yet really does hold nothing. */
const NO_HOLDINGS = new Set<string>();
/** One carried line, marked so cash 85840 + 14160 = 100000 total. */
const CARRIED_HOLDING: DecisionHolding = {
  symbol: "JNJ",
  shares: 120,
  costBasis: 110,
  lastPrice: 118,
  marketValue: 14160,
  weight: 0.1416,
  holdingDays: 30,
  unrealizedPnlPct: 7.27,
};

describe("parsePositiveInt", () => {
  it("falls back on undefined and blank", () => {
    expect(parsePositiveInt(undefined, "MAX_PARALLEL", 3)).toBe(3);
    expect(parsePositiveInt("  ", "MAX_PARALLEL", 3)).toBe(3);
  });

  it("parses valid integers from strings and numbers", () => {
    expect(parsePositiveInt("5", "MAX_PARALLEL", 3)).toBe(5);
    expect(parsePositiveInt(7, "MAX_PARALLEL", 3)).toBe(7);
  });

  it("rejects zero, negatives, floats, and garbage", () => {
    expect(() => parsePositiveInt("0", "MAX_PARALLEL", 3)).toThrow(ConfigError);
    expect(() => parsePositiveInt("-1", "MAX_PARALLEL", 3)).toThrow(ConfigError);
    expect(() => parsePositiveInt("2.5", "MAX_PARALLEL", 3)).toThrow(ConfigError);
    expect(() => parsePositiveInt("abc", "MAX_PARALLEL", 3)).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  const base = {
    PORTFOLIO_BACKEND_URL: "http://feat-portfolio-sim-backend:3000/",
    WORKTREE_SLUG: "model_md-worktree-feat-portfolio-sim",
  };

  it("requires PORTFOLIO_BACKEND_URL", () => {
    expect(() => loadConfig({ WORKTREE_SLUG: "slug" })).toThrow(
      "PORTFOLIO_BACKEND_URL is required",
    );
  });

  it("requires WORKTREE_SLUG", () => {
    expect(() => loadConfig({ PORTFOLIO_BACKEND_URL: "http://x:3000" })).toThrow(
      "WORKTREE_SLUG is required",
    );
  });

  it("applies defaults and trims the backend URL trailing slash", () => {
    const config = loadConfig(base);
    expect(config.backendUrl).toBe("http://feat-portfolio-sim-backend:3000");
    expect(config.agentContainer).toBe("opencode_agent");
    expect(config.maxParallel).toBe(3);
    expect(config.capital).toBe(100000);
    expect(config.timeoutMs).toBe(600000);
    expect(config.dockerHost).toBeUndefined();
  });

  it("reads overrides", () => {
    const config = loadConfig({
      ...base,
      AGENT_CONTAINER: "pi",
      MAX_PARALLEL: "2",
      INITIAL_CAPITAL: "50000",
      DOCKER_HOST: "tcp://mcp-socket-proxy:2375",
    });
    expect(config.agentContainer).toBe("pi");
    expect(config.maxParallel).toBe(2);
    expect(config.capital).toBe(50000);
    expect(config.dockerHost).toBe("tcp://mcp-socket-proxy:2375");
  });
});

describe("resolveAgents", () => {
  it("resolves undefined to the full persona x window cross product", () => {
    expect(resolveAgents(undefined)).toHaveLength(18);
  });

  it('resolves "all" and blanks to the full cross product', () => {
    expect(resolveAgents("all")).toHaveLength(18);
    expect(resolveAgents("")).toHaveLength(18);
    expect(resolveAgents("   ")).toHaveLength(18);
  });

  it("resolves a comma-separated list across every window", () => {
    const jobs: AgentJob[] = resolveAgents("dr-value, dr-momentum");
    expect(jobs).toEqual([
      { personaKey: "dr-value", agentKey: "dr-value--daily", window: "daily" },
      { personaKey: "dr-value", agentKey: "dr-value--weekly", window: "weekly" },
      { personaKey: "dr-value", agentKey: "dr-value--monthly", window: "monthly" },
      { personaKey: "dr-momentum", agentKey: "dr-momentum--daily", window: "daily" },
      { personaKey: "dr-momentum", agentKey: "dr-momentum--weekly", window: "weekly" },
      { personaKey: "dr-momentum", agentKey: "dr-momentum--monthly", window: "monthly" },
    ]);
  });

  it("resolves an array of keys", () => {
    const jobs: AgentJob[] = resolveAgents(["dr-macro", "dr-technical"]);
    expect(jobs.map((job) => job.agentKey)).toEqual([
      "dr-macro--daily",
      "dr-macro--weekly",
      "dr-macro--monthly",
      "dr-technical--daily",
      "dr-technical--weekly",
      "dr-technical--monthly",
    ]);
  });

  it("restricts the roster to the requested windows", () => {
    expect(resolveAgents("dr-value", ["monthly"])).toEqual([
      { personaKey: "dr-value", agentKey: "dr-value--monthly", window: "monthly" },
    ]);
  });

  it("keeps canonical cadence order regardless of input order", () => {
    expect(resolveAgents("dr-value", ["monthly", "daily"]).map((job) => job.window)).toEqual([
      "daily",
      "monthly",
    ]);
  });

  it("produces a unique agentKey for every persona-window pair", () => {
    const keys = resolveAgents(undefined).map((job) => job.agentKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("rejects an unknown window", () => {
    expect(() => resolveAgents("dr-value", ["yearly" as never])).toThrow(/Unknown window/);
  });

  it("throws with the available keys on an unknown persona", () => {
    expect(() => resolveAgents("ghost-picker")).toThrow();
  });
});

describe("parseWindows", () => {
  it("maps undefined, blank, and 'all' to undefined (every window)", () => {
    expect(parseWindows(undefined)).toBeUndefined();
    expect(parseWindows("")).toBeUndefined();
    expect(parseWindows("  ")).toBeUndefined();
    expect(parseWindows("all")).toBeUndefined();
  });

  it("splits and trims a comma-separated list", () => {
    expect(parseWindows(" daily , monthly ")).toEqual(["daily", "monthly"]);
  });

  it("passes an array through with blanks dropped", () => {
    expect(parseWindows(["daily", " ", "weekly"])).toEqual(["daily", "weekly"]);
  });
});

describe("paths and round id guards", () => {
  it("builds the container-visible dataset path", () => {
    expect(datasetPathFor("model_md-worktree-feat-portfolio-sim", "w1")).toBe(
      "/app/worktrees/model_md-worktree-feat-portfolio-sim/rounds/w1/dataset.json",
    );
  });

  it("mirrors the backend round id pattern", () => {
    expect(isValidRoundId("w1")).toBe(true);
    expect(isValidRoundId("W1.A_2026-09-22")).toBe(true);
    expect(isValidRoundId("../etc/passwd")).toBe(false);
    expect(isValidRoundId(".hidden")).toBe(false);
    expect(isValidRoundId("a/b")).toBe(false);
  });
});

describe("deriveFinalStatus", () => {
  it("is done only when every agent inserted", () => {
    expect(deriveFinalStatus([{ status: "inserted" }, { status: "inserted" }])).toBe("done");
  });

  it("is partial on a mix of inserted and failed", () => {
    expect(deriveFinalStatus([{ status: "inserted" }, { status: "failed" }])).toBe("partial");
  });

  it("is error when every agent failed", () => {
    expect(deriveFinalStatus([{ status: "failed" }, { status: "failed" }])).toBe("error");
  });

  it("is error when an agent never ran", () => {
    expect(deriveFinalStatus([{ status: "inserted" }, { status: "pending" }])).toBe("partial");
    expect(deriveFinalStatus([])).toBe("error");
  });

  it("treats a not-due stream as settled success, not failure", () => {
    expect(deriveFinalStatus([{ status: "not_due" }, { status: "not_due" }])).toBe("done");
    expect(deriveFinalStatus([{ status: "inserted" }, { status: "not_due" }])).toBe("done");
  });

  it("still reports partial when a not-due stream sits beside a real failure", () => {
    expect(deriveFinalStatus([{ status: "not_due" }, { status: "failed" }])).toBe("partial");
    expect(deriveFinalStatus([{ status: "not_due" }, { status: "running" }])).toBe("partial");
  });
});

describe("selectDueJobs", () => {
  const jobs = [
    { agentKey: "dr-value--daily" },
    { agentKey: "dr-value--weekly" },
    { agentKey: "dr-macro--monthly" },
  ];

  it("keeps only the streams the gate left pending", () => {
    expect(
      selectDueJobs(jobs, [
        { agentKey: "dr-value--daily", status: "pending" },
        { agentKey: "dr-value--weekly", status: "not_due" },
        { agentKey: "dr-macro--monthly", status: "not_due" },
      ]),
    ).toEqual([{ agentKey: "dr-value--daily" }]);
  });

  it("returns every job when every stream is due", () => {
    expect(
      selectDueJobs(
        jobs,
        jobs.map((job) => ({ agentKey: job.agentKey, status: "pending" })),
      ),
    ).toEqual(jobs);
  });

  it("returns nothing when every stream is not due", () => {
    expect(
      selectDueJobs(
        jobs,
        jobs.map((job) => ({ agentKey: job.agentKey, status: "not_due" })),
      ),
    ).toEqual([]);
  });
});

describe("createRoundStore", () => {
  const base = "http://backend:3000";

  const makeClient = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) =>
    createBackendClient(base, (async (url: RequestInfo | URL, init?: RequestInit) =>
      handler(String(url), init)) as unknown as typeof fetch);

  it("POSTs the launch payload to the round job endpoint", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const store = createRoundStore(
      makeClient((url, init) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return fakeResponse(201, { roundId: "w1", job: null, agents: [] });
      }),
    );

    await store.startRound({
      roundId: "w1",
      agents: [{ agentKey: "dr-value", personaKey: "dr-value" }],
      maxParallel: 3,
      capital: 100000,
      asOfTradeDate: "2026-09-25",
      datasetPath: "/app/worktrees/slug/rounds/w1/dataset.json",
    });

    expect(calls[0]?.url).toBe("http://backend:3000/api/portfolio/rounds/w1/job");
    expect(calls[0]?.body).toEqual({
      agents: [{ agentKey: "dr-value", personaKey: "dr-value" }],
      maxParallel: 3,
      capital: 100000,
      asOfTradeDate: "2026-09-25",
      datasetPath: "/app/worktrees/slug/rounds/w1/dataset.json",
      takeover: false,
      replace: false,
    });
  });

  it("maps a 409 launch rejection to RoundAlreadyLaunchedError with the job", async () => {
    const store = createRoundStore(
      makeClient(() =>
        fakeResponse(409, { error: 'round "w1" was already launched', job: { status: "running" } }),
      ),
    );

    await expect(
      store.startRound({
        roundId: "w1",
        agents: [{ agentKey: "dr-value", personaKey: "dr-value" }],
        maxParallel: 3,
        capital: 100000,
      }),
    ).rejects.toBeInstanceOf(RoundAlreadyLaunchedError);
  });

  it("PUTs agent progress to the per-agent endpoint", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const store = createRoundStore(
      makeClient((url, init) => {
        seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return fakeResponse(200, { agent: { agentKey: "dr-value", status: "inserted" } });
      }),
    );

    await store.setAgentProgress("w1", "dr-value", { status: "inserted", runId: 7, picks: 5 });

    expect(seen[0]?.url).toBe("http://backend:3000/api/portfolio/rounds/w1/job/agents/dr-value");
    expect(seen[0]?.body).toMatchObject({ status: "inserted", runId: 7, picks: 5 });
  });

  it("maps a 404 status transition to RoundJobMissingError", async () => {
    const store = createRoundStore(makeClient(() => fakeResponse(404, { error: "no job" })));
    await expect(store.setRoundStatus("nope", "running")).rejects.toBeInstanceOf(
      RoundJobMissingError,
    );
  });
});

describe("runAgents (durable progress)", () => {
  const config: OrchestratorConfig = {
    backendUrl: "http://backend:3000",
    worktreeSlug: "model_md-worktree-feat-portfolio-sim",
    agentContainer: "opencode_agent",
    maxParallel: 2,
    capital: 100000,
    timeoutMs: 1000,
  };

  const dataset: DatasetWire = {
    schemaVersion: 1,
    roundId: "w1",
    asOfTradeDate: "2026-09-25",
    generatedAt: "2026-09-25T18:30:00.000Z",
    universe: [
      { symbol: "AAPL", hasData: true, latestClose: 100 },
      { symbol: "MSFT", hasData: true, latestClose: 200 },
    ],
  };

  const BOOKING = { simulationId: "sim-1", roundSeq: 1 };

  const makeStore = () => {
    const statuses = new Map<string, string>();
    const roundStatuses: string[] = [];
    const patches: { agentKey: string; patch: Record<string, unknown> }[] = [];
    const store = {
      async startRound() {
        return { roundId: "w1", job: null, agents: [] };
      },
      async getRound() {
        return {
          roundId: "w1",
          job: null,
          agents: [...statuses.entries()].map(([agentKey, status]) => ({
            agentKey,
            personaKey: agentKey,
            status: status as never,
            runId: null,
            picks: null,
            attempts: null,
            error: null,
            startedAt: null,
            completedAt: null,
            updatedAt: "",
          })),
        };
      },
      async setRoundStatus(_roundId: string, status: string) {
        roundStatuses.push(status);
        return {} as never;
      },
      async setAgentProgress(_roundId: string, agentKey: string, patch: Record<string, unknown>) {
        statuses.set(agentKey, String(patch.status));
        patches.push({ agentKey, patch });
        return {} as never;
      },
    };
    return { store, statuses, roundStatuses, patches };
  };

  const jobs: AgentJob[] = [
    { personaKey: "dr-value", agentKey: "dr-value", window: "weekly" },
    { personaKey: "dr-momentum", agentKey: "dr-momentum", window: "weekly" },
  ];

  const OPENING_BOOK_SIZE = 5;
  const envelope = (agentKey: string) => ({
    schemaVersion: 2,
    roundId: "w1",
    simulationId: "sim-w1",
    roundSeq: 1,
    agent: {
      agentKey,
      persona: agentKey,
      strategy: "value",
      window: "weekly",
      portfolioValue: 100000,
      cash: 100000,
      holdingsValue: 0,
      priorRoundId: null,
      roundSeq: 1,
    },
    rationale: "Opening book for the stream.",
    positions: ["AAPL", "MSFT", "KO", "PG", "JNJ"].map((symbol) => ({
      symbol,
      targetWeight: 0.2,
      thesis: `Opening line in ${symbol}.`,
    })),
  });

  it("records the envelope's position count on the inserted progress row", async () => {
    const { store, patches } = makeStore();
    const backend = {
      async post() {
        return { ok: true, agentRunId: 21, positionsInserted: OPENING_BOOK_SIZE };
      },
    } as never;

    await runAgents("w1", jobs, dataset, {
      store: store as never,
      backend,
      config,
      booking: BOOKING,
      spawn: (async ({ agentKey }: { agentKey: string }) => ({
        envelope: envelope(agentKey),
        rawOutput: "{}",
        attempts: 1,
      })) as never,
    });

    const inserted = patches.filter((entry) => entry.patch.status === "inserted");
    expect(inserted).toHaveLength(2);
    expect(inserted.map((entry) => entry.patch.picks)).toEqual([
      OPENING_BOOK_SIZE,
      OPENING_BOOK_SIZE,
    ]);
  });

  it("supplies the stream's carried book to the spawner", async () => {
    const { store } = makeStore();
    const backend = {
      async post() {
        return { ok: true, agentRunId: 22, positionsInserted: 1 };
      },
    } as never;
    const seen: { heldSymbols: ReadonlySet<string>; portfolioValue: number }[] = [];

    await runAgents("w1", [jobs[0]], dataset, {
      store: store as never,
      backend,
      config,
      booking: BOOKING,
      bookFor: () => streamBook([CARRIED_HOLDING], 85840),
      spawn: (async (opts: {
        agentKey: string;
        heldSymbols: ReadonlySet<string>;
        portfolioValue: number;
      }) => {
        seen.push({ heldSymbols: opts.heldSymbols, portfolioValue: opts.portfolioValue });
        return { envelope: envelope(opts.agentKey), rawOutput: "{}", attempts: 1 };
      }) as never,
    });

    expect(seen).toHaveLength(1);
    expect([...seen[0].heldSymbols]).toEqual(["JNJ"]);
    expect(seen[0].portfolioValue).toBe(100000);
  });

  it("states the booking's chain position and the cash split in the spawn options", async () => {
    const { store } = makeStore();
    const backend = {
      async post() {
        return { ok: true, agentRunId: 23, positionsInserted: 1 };
      },
    } as never;
    const seen: {
      roundSeq: number;
      simulationId: string | undefined;
      priorRoundId: string | null;
      cash: number;
      holdingsValue: number;
      portfolioValue: number;
    }[] = [];

    await runAgents("w1", [jobs[0]], dataset, {
      store: store as never,
      backend,
      config,
      booking: { simulationId: "sim-1", roundSeq: 7 },
      bookFor: () => streamBook([CARRIED_HOLDING], 85840, "w6"),
      spawn: (async (opts: {
        agentKey: string;
        roundSeq: number;
        simulationId: string | undefined;
        priorRoundId: string | null;
        cash: number;
        holdingsValue: number;
        portfolioValue: number;
      }) => {
        seen.push({
          roundSeq: opts.roundSeq,
          simulationId: opts.simulationId,
          priorRoundId: opts.priorRoundId,
          cash: opts.cash,
          holdingsValue: opts.holdingsValue,
          portfolioValue: opts.portfolioValue,
        });
        return { envelope: envelope(opts.agentKey), rawOutput: "{}", attempts: 1 };
      }) as never,
    });

    expect(seen).toEqual([
      {
        roundSeq: 7,
        simulationId: "sim-1",
        priorRoundId: "w6",
        cash: 85840,
        holdingsValue: 120 * 118,
        portfolioValue: 85840 + 120 * 118,
      },
    ]);
  });

  it("persists running, inserted, and a final done round status", async () => {
    const { store, statuses, roundStatuses } = makeStore();
    const backend = {
      async post() {
        return { ok: true, agentRunId: 11, positionsInserted: 1 };
      },
    } as never;

    await runAgents("w1", jobs, dataset, {
      store: store as never,
      backend,
      config,
      booking: BOOKING,
      spawn: (async ({ agentKey }: { agentKey: string }) => ({
        envelope: envelope(agentKey),
        rawOutput: "{}",
        attempts: 1,
      })) as never,
    });

    expect(statuses.get("dr-value")).toBe("inserted");
    expect(statuses.get("dr-momentum")).toBe("inserted");
    expect(roundStatuses).toEqual(["running", "done"]);
  });

  it("records a failed agent and finalizes the round as partial", async () => {
    const { store, statuses, roundStatuses } = makeStore();
    const backend = {
      async post() {
        return { ok: true, agentRunId: 12, positionsInserted: 1 };
      },
    } as never;

    await runAgents("w1", jobs, dataset, {
      store: store as never,
      backend,
      config,
      booking: BOOKING,
      spawn: (async ({ agentKey }: { agentKey: string }) => {
        if (agentKey === "dr-momentum") throw new Error("analyst timed out");
        return { envelope: envelope(agentKey), rawOutput: "{}", attempts: 2 };
      }) as never,
    });

    expect(statuses.get("dr-value")).toBe("inserted");
    expect(statuses.get("dr-momentum")).toBe("failed");
    expect(roundStatuses).toEqual(["running", "partial"]);
  });

  it("does not abort the round when a progress write fails", async () => {
    const statuses = new Map<string, string>();
    const roundStatuses: string[] = [];
    const store = {
      async getRound() {
        return {
          roundId: "w1",
          job: null,
          agents: [...statuses.entries()].map(([agentKey, status]) => ({
            agentKey,
            personaKey: agentKey,
            status: status as never,
            runId: null,
            picks: null,
            attempts: null,
            error: null,
            startedAt: null,
            completedAt: null,
            updatedAt: "",
          })),
        };
      },
      async setRoundStatus(_r: string, status: string) {
        roundStatuses.push(status);
        return {} as never;
      },
      async setAgentProgress(_r: string, agentKey: string, patch: { status: string }) {
        if (patch.status === "running") throw new Error("progress write failed");
        statuses.set(agentKey, patch.status);
        return {} as never;
      },
    };
    const backend = {
      async post() {
        return { ok: true, agentRunId: 13, positionsInserted: 1 };
      },
    } as never;

    await runAgents("w1", jobs, dataset, {
      store: store as never,
      backend,
      config,
      booking: BOOKING,
      spawn: (async ({ agentKey }: { agentKey: string }) => ({
        envelope: envelope(agentKey),
        rawOutput: "{}",
        attempts: 1,
      })) as never,
    });

    expect(statuses.get("dr-value")).toBe("inserted");
    expect(roundStatuses).toEqual(["running", "done"]);
  });
});
describe("runPool", () => {
  it("runs every item with the concurrency capped at the limit", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const visited: number[] = [];
    let active = 0;
    let maxActive = 0;

    await runPool(items, 3, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      visited.push(item);
      active -= 1;
    });

    expect(maxActive).toBeLessThanOrEqual(3);
    expect(visited.sort((a, b) => a - b)).toEqual(items);
  });

  it("handles empty item lists", async () => {
    await expect(runPool([], 3, async () => {})).resolves.toBeUndefined();
  });
});

describe("createBackendClient", () => {
  function fakeResponse(status: number, payload: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }

  it("GETs typed JSON", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, { dataReady: true }));
    const client = createBackendClient("http://backend:3000", fetchImpl);
    const body = await client.get<{ dataReady: boolean }>("/api/portfolio/dataset-status");
    expect(body.dataReady).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://backend:3000/api/portfolio/dataset-status",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("POSTs JSON with a content-type header", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      fakeResponse(201, { ok: true, agentRunId: 7 }),
    );
    const client = createBackendClient("http://backend:3000", fetchImpl);
    const body = await client.post<{ ok: boolean; agentRunId: number }>("/api/portfolio/runs", {
      envelope: { schemaVersion: 1 },
    });
    expect(body.agentRunId).toBe(7);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://backend:3000/api/portfolio/runs");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("throws BackendError with the backend's error message on non-2xx", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse(409, { error: 'Agent run already exists for round "w1"' }),
    );
    const client = createBackendClient("http://backend:3000", fetchImpl);
    await expect(client.post("/api/portfolio/runs", { envelope: {} })).rejects.toMatchObject({
      status: 409,
      payload: { error: 'Agent run already exists for round "w1"' },
    } as Partial<BackendError>);
  });

  it("wraps network failures", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = createBackendClient("http://backend:3000", fetchImpl);
    await expect(client.get("/api/portfolio/dataset-status")).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("docker exec spawner", () => {
  it("builds isolated XDG dirs per round and agent", () => {
    const dirs = buildAgentStateDirs("w1", "dr-value");
    expect(dirs.state).toBe("/home/devuser/.local/state/agents/w1/dr-value");
    expect(dirs.cache).toBe("/home/devuser/.cache/agents/w1/dr-value");
  });

  it("builds the exact docker exec argv", () => {
    const args = buildDockerExecArgs({
      agentContainer: "opencode_agent",
      workdir: "/app/worktrees/model_md-worktree-feat-portfolio-sim",
      roundId: "w1",
      agentKey: "dr-value",
      prompt: "You are an analyst.",
    });
    expect(args).toEqual([
      "exec",
      "-e",
      "XDG_STATE_HOME=/home/devuser/.local/state/agents/w1/dr-value",
      "-e",
      "XDG_CACHE_HOME=/home/devuser/.cache/agents/w1/dr-value",
      "-w",
      "/app/worktrees/model_md-worktree-feat-portfolio-sim",
      "opencode_agent",
      "opencode",
      "run",
      "--format",
      "json",
      "You are an analyst.",
    ]);
  });

  function ndjson(text: string): string {
    return `{"type":"text","part":{"text":${JSON.stringify(text)}}}\n`;
  }

  function fakePersona(): Parameters<typeof spawnAnalystWithExec>[0]["persona"] {
    return {
      key: "dr-value",
      displayName: "Dr. Value",
      strategy: "deep-value",
      phdSystemPrompt: "You are a value analyst.",
    };
  }

  const baseOptions: SpawnViaDockerOptions = {
    persona: fakePersona(),
    window: "monthly",
    agentKey: "dr-value--monthly",
    roundId: "w1",
    datasetPath: "/app/worktrees/slug/rounds/w1/dataset.json",
    asOfTradeDate: "2026-09-22",
    portfolioValue: 100000,
    agentContainer: "opencode_agent",
    workdir: "/app/worktrees/slug",
    universe: [...UNIVERSE],
    symbolsWithPrice: SYMBOLS_WITH_PRICE,
    heldSymbols: NO_HOLDINGS,
  };

  const okExec: ExecImpl = async () => ({
    stdout: ndjson(JSON.stringify(VALID_ENVELOPE)),
    stderr: "",
    code: 0,
  });

  it("returns a validated envelope on a successful exec", async () => {
    const result = await spawnAnalystWithExec(baseOptions, okExec);
    expect(result.attempts).toBe(1);
    expect(result.envelope.roundId).toBe("w1");
    expect(result.envelope.positions).toHaveLength(5);
  });

  it("renders the carried book and the real portfolio value into the prompt", async () => {
    const calls: string[][] = [];
    const exec: ExecImpl = async (args) => {
      calls.push([...args]);
      return { stdout: ndjson(JSON.stringify(VALID_ENVELOPE)), stderr: "", code: 0 };
    };
    const book = streamBook([CARRIED_HOLDING], 85840);

    await spawnAnalystWithExec(
      { ...baseOptions, portfolioValue: book.portfolioValue, holdings: book.holdings },
      exec,
    );

    const prompt = calls[0][calls[0].length - 1];
    expect(prompt).toContain("portfolioValue=100000");
    expect(prompt).toContain(
      "JNJ | 120.000000 | $110.0000 | $118.0000 | $14160.00 | 14.16% | 30d | +7.27%",
    );
    expect(prompt).toContain("cash=85840.00");
  });

  it("rejects a sell of a symbol the stream does not hold", async () => {
    const exec: ExecImpl = async () => ({
      stdout: ndjson(
        JSON.stringify({
          ...VALID_ENVELOPE,
          positions: [
            ...VALID_ENVELOPE.positions,
            { symbol: "TSLA", targetWeight: 0, thesis: "Exit entirely." },
          ],
        }),
      ),
      stderr: "",
      code: 0,
    });

    await expect(
      spawnAnalystWithExec({ ...baseOptions, heldSymbols: new Set(["AAPL"]) }, exec),
    ).rejects.toThrow(/not in heldSymbols/);
  });

  it("rejects an envelope that omits a held symbol", async () => {
    await expect(
      spawnAnalystWithExec({ ...baseOptions, heldSymbols: new Set(["XOM"]) }, okExec),
    ).rejects.toThrow(/held symbols omitted/);
  });

  it("retries once with a correction hint after an invalid envelope", async () => {
    const calls: string[][] = [];
    const exec: ExecImpl = async (args) => {
      calls.push([...args]);
      const bad = {
        ...VALID_ENVELOPE,
        positions: VALID_ENVELOPE.positions.slice(0, 1), // < MIN_PICKS
      };
      return { stdout: ndjson(JSON.stringify(bad)), stderr: "", code: 0 };
    };
    await expect(spawnAnalystWithExec(baseOptions, exec)).rejects.toThrow(
      /failed after 2 attempts/,
    );
    expect(calls).toHaveLength(2);
    const retryPrompt = calls[1][calls[1].length - 1];
    expect(retryPrompt).toContain("CORRECTION FROM THE PREVIOUS ATTEMPT");
  });

  it("retries once after a non-zero docker exit", async () => {
    const calls: string[][] = [];
    const exec: ExecImpl = async (args) => {
      calls.push([...args]);
      if (calls.length === 1) return { stdout: "", stderr: "container not running", code: 125 };
      return { stdout: ndjson(JSON.stringify(VALID_ENVELOPE)), stderr: "", code: 0 };
    };
    const result = await spawnAnalystWithExec(baseOptions, exec);
    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("fails after two attempts when the terminal state is non-zero", async () => {
    const exec: ExecImpl = async () => ({ stdout: "", stderr: "boom", code: 125 });
    await expect(spawnAnalystWithExec(baseOptions, exec)).rejects.toThrow(
      /docker exec exited with code 125/,
    );
  });

  it("strips markdown fences before parsing", async () => {
    const fenced = "```json\n" + JSON.stringify(VALID_ENVELOPE) + "\n```";
    const exec: ExecImpl = async () => ({ stdout: ndjson(fenced), stderr: "", code: 0 });
    const result = await spawnAnalystWithExec(baseOptions, exec);
    expect(result.envelope.agent.agentKey).toBe("dr-value--monthly");
  });
});

describe("createBookLoader", () => {
  const lot = {
    symbol: "JNJ",
    shares: 120,
    costBasis: 110,
    targetWeight: 0.1416,
    openedFromRoundId: "w1",
    openedTradeDate: "2026-08-25",
    realizedPnl: 0,
    thesis: null,
  };

  const loaderDeps = (handler: (url: string) => Response | Promise<Response>) =>
    ({
      backend: createBackendClient("http://backend:3000", (async (url: RequestInfo | URL) =>
        handler(String(url))) as unknown as typeof fetch),
      simulationId: "sim-1",
      capital: 100000,
      latestCloseBySymbol: new Map([["JNJ", 118]]),
      asOfTradeDate: "2026-09-25",
    }) as const;

  const bookLoader = (handler: (url: string) => Response | Promise<Response>) =>
    createBookLoader(loaderDeps(handler));

  it("requests the stream's persona/window pair under the simulation", async () => {
    const urls: string[] = [];
    await bookLoader((url) => {
      urls.push(url);
      return fakeResponse(404, { error: "no materialized book" });
    })({ personaKey: "dr-value", window: "monthly" });

    expect(urls).toEqual([
      "http://backend:3000/api/portfolio/simulations/sim-1/streams/dr-value/monthly",
    ]);
  });

  it("treats 404 as the opening book rather than a failure", async () => {
    const book = await bookLoader(() => fakeResponse(404, { error: "no materialized book" }))({
      personaKey: "dr-value",
      window: "monthly",
    });

    expect(book.holdings).toEqual([]);
    expect(book.heldSymbols.size).toBe(0);
    expect(book.portfolioValue).toBe(100000);
  });

  it("carries open lots marked at the decision date's close", async () => {
    const book = await bookLoader(() =>
      fakeResponse(200, {
        stream: { cash: 85840, lastRoundId: "w1" },
        lots: [lot],
      }),
    )({ personaKey: "dr-value", window: "monthly" });

    expect([...book.heldSymbols]).toEqual(["JNJ"]);
    expect(book.holdings).toHaveLength(1);
    const [holding] = book.holdings;
    expect(holding.lastPrice).toBe(118);
    expect(holding.marketValue).toBe(14160);
    expect(holding.holdingDays).toBe(31);
    expect(holding.unrealizedPnlPct).toBeCloseTo(7.27, 2);
    // cash 85840 + 120 * 118
    expect(book.portfolioValue).toBe(100000);
    expect(holding.weight).toBeCloseTo(0.1416, 4);
  });

  it("carries the stream's cash and names the round the book came from", async () => {
    const book = await bookLoader(() =>
      fakeResponse(200, {
        stream: { cash: 85840, lastRoundId: "w1" },
        lots: [],
      }),
    )({ personaKey: "dr-value", window: "monthly" });

    expect(book.portfolioValue).toBe(85840);
    expect(book.cash).toBe(85840);
    expect(book.priorRoundId).toBe("w1");
  });

  it("carries a chain position as a null prior round on the opening fold", async () => {
    const book = await bookLoader(() =>
      fakeResponse(200, {
        stream: { cash: 100000, lastRoundId: null },
        lots: [],
      }),
    )({ personaKey: "dr-value", window: "monthly" });

    expect(book.priorRoundId).toBeNull();
    expect(book.portfolioValue).toBe(100000);
  });

  it("keeps an unpriceable holding at cost rather than silently dropping it", async () => {
    const book = await createBookLoader({
      ...loaderDeps(() =>
        fakeResponse(200, {
          stream: { cash: 90000, lastRoundId: "w1" },
          lots: [lot],
        }),
      ),
      latestCloseBySymbol: new Map(),
    })({ personaKey: "dr-value", window: "monthly" });

    expect([...book.heldSymbols]).toEqual(["JNJ"]);
    expect(book.holdings[0]?.lastPrice).toBe(110);
    expect(book.holdings[0]?.unrealizedPnlPct).toBe(0);
  });

  it("falls back to the opening book when the stream summary carries no cash", async () => {
    const book = await bookLoader(() =>
      fakeResponse(200, { stream: { cash: null, lastRoundId: null }, lots: [lot] }),
    )({ personaKey: "dr-value", window: "monthly" });

    expect(book.holdings).toEqual([]);
    expect(book.portfolioValue).toBe(100000);
  });

  it("excludes closed lots and ignores non-409 failures", async () => {
    const closed = await bookLoader(() =>
      fakeResponse(200, {
        stream: { cash: 100000, lastRoundId: "w1" },
        lots: [{ ...lot, shares: 0 }],
      }),
    )({ personaKey: "dr-value", window: "monthly" });
    expect(closed.heldSymbols.size).toBe(0);

    await expect(
      bookLoader(() => fakeResponse(500, { error: "boom" }))({
        personaKey: "dr-value",
        window: "monthly",
      }),
    ).rejects.toThrow(BackendError);
  });
});

describe("createSimulationStore", () => {
  const base = "http://backend:3000";

  const SIM: SimulationWire = {
    simId: "sim-baseline",
    label: null,
    initialCapital: 100000,
    createdAt: "2026-10-02T14:00:00.000Z",
    streamCount: 0,
    lastRoundSeq: null,
  };

  function reply(status: number, payload: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status < 300 ? "OK" : "Error",
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }

  const store = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) =>
    createSimulationStore(
      createBackendClient(base, (async (url: RequestInfo | URL, init?: RequestInit) =>
        handler(String(url), init)) as unknown as typeof fetch),
    );

  it("POSTs only the fields the caller supplied", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const simulations = store((url, init) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return reply(201, SIM);
    });

    const result = await simulations.create({ simId: "sim-baseline" });

    expect(calls[0]?.url).toBe("http://backend:3000/api/portfolio/simulations");
    // toStrictEqual, not toEqual: the latter ignores undefined properties, so it
    // would pass even if the omitted optionals were sent as `label: undefined`.
    expect(calls[0]?.body).toStrictEqual({ simId: "sim-baseline" });
    expect(result).toEqual({ alreadyExists: false, simulation: SIM });
  });

  it("forwards an explicit label and chain basis", async () => {
    const bodies: unknown[] = [];
    const simulations = store((_url, init) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
      return reply(201, { ...SIM, simId: "sim-alt", label: "Alt", initialCapital: 25000 });
    });

    await simulations.create({ simId: "sim-alt", label: "Alt", initialCapital: 25000 });

    expect(bodies[0]).toEqual({ simId: "sim-alt", label: "Alt", initialCapital: 25000 });
  });

  it("resolves a 409 into the existing simulation instead of failing", async () => {
    const methods: string[] = [];
    const simulations = store((_url, init) => {
      methods.push(String(init?.method));
      return init?.method === "GET"
        ? reply(200, [{ ...SIM, streamCount: 6, lastRoundSeq: 3 }])
        : reply(409, { error: 'simulation "sim-baseline" already exists' });
    });

    const result = await simulations.create({ simId: "sim-baseline" });

    expect(methods).toEqual(["POST", "GET"]);
    expect(result.alreadyExists).toBe(true);
    expect(result.simulation.streamCount).toBe(6);
    expect(result.simulation.lastRoundSeq).toBe(3);
  });

  it("rethrows a 409 whose handle is absent from the read-back", async () => {
    const simulations = store((_url, init) =>
      init?.method === "GET"
        ? reply(200, [{ ...SIM, simId: "sim-other" }])
        : reply(409, { error: "exists" }),
    );

    await expect(simulations.create({ simId: "sim-baseline" })).rejects.toThrow(BackendError);
  });

  it("propagates a non-409 failure without attempting a read-back", async () => {
    const methods: string[] = [];
    const simulations = store((_url, init) => {
      methods.push(String(init?.method));
      return reply(400, { error: "body.simId must match /^sim-[a-z0-9][a-z0-9-]{0,46}$/" });
    });

    await expect(simulations.create({ simId: "sim-BAD" })).rejects.toThrow(BackendError);
    expect(methods).toEqual(["POST"]);
  });
});
