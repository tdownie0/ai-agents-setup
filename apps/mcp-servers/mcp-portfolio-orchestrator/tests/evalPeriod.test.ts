/**
 * Unit tests for `run_eval_period` (the walk-forward as-of replay driver).
 *
 * Everything runs against a STUB backend client (no network, no DB, no docker):
 * a route-table fetch fake that also plays the backend's own cadence gate, so
 * the due-date jumping, sequential booking, round id pattern, and 409 stop are
 * proven end-to-end through the real store/runner wiring.
 *
 * `src/index.ts` is intentionally NOT imported (it connects the stdio transport
 * at module scope and requires runtime env).
 */

import { describe, expect, it } from "vitest";
import { createBackendClient } from "../src/backendClient.js";
import type { OrchestratorConfig } from "../src/config.js";
import { buildEvalRoundId, parseYmd, runEvalPeriod, streamDueAt } from "../src/evalPeriod.js";
import type { EvalPeriodDeps } from "../src/evalPeriod.js";
import { RERUN_ACTIONS } from "../src/rerunActions.js";
import { createRoundStore } from "../src/roundStore.js";

const CONFIG: OrchestratorConfig = {
  backendUrl: "http://backend:3000",
  worktreeSlug: "model_md-worktree-feat-portfolio-sim",
  agentContainer: "opencode_agent",
  maxParallel: 3,
  capital: 100000,
  timeoutMs: 1000,
  judgeConfigPath: "/app/worktrees/model_md-worktree-feat-portfolio-sim/infra/opencode.judge.json",
  judgeModel: "opencode/big-pickle",
};

/** Mirror of the backend cadence, used only by the stub's launch gate. */
const CADENCE: Record<string, number> = { daily: 1, weekly: 5, monthly: 21 };

interface StubAgent {
  agentKey: string;
  personaKey: string;
  status: string;
  runId: number | null;
  picks: number | null;
  attempts: number | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

interface StubRound {
  roundId: string;
  asOfTradeDate: string;
  simulationId: string | null;
  roundSeq: number;
  status: string;
  agents: StubAgent[];
}

interface HarnessOptions {
  tradeDates: string[];
  /** agentKey -> lastTradeDate; mutated as rounds fold, like the real fold. */
  streams: Record<string, string>;
  /** asOfTradeDate on which the job POST should 409. */
  rejectOn?: string;
  dataReady?: boolean;
}

function countSince(calendar: readonly string[], last: string, asOf: string): number {
  return calendar.filter((date) => date > last && date <= asOf).length;
}

function makeHarness(opts: HarnessOptions) {
  const events: string[] = [];
  const jobPosts: { roundId: string; asOfTradeDate: string; agentKeys: string[] }[] = [];
  const datasetPins: { roundId: string; asOfTradeDate: string }[] = [];
  const requestedUrls: string[] = [];
  const rounds = new Map<string, StubRound>();
  let roundSeq = 0;
  let runId = 100;

  const json = (status: number, payload: unknown): Response =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });

  const jobShell = (round: StubRound) => ({
    roundId: round.roundId,
    status: round.status,
    asOfTradeDate: round.asOfTradeDate,
    datasetPath: null,
    maxParallel: 3,
    capital: "100000",
    error: null,
    startedAt: "2026-09-11T00:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-09-11T00:00:00.000Z",
    simulationId: round.simulationId,
    roundSeq: round.roundSeq,
  });

  const handler = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const parsed = new URL(url);
    const path = parsed.pathname;
    requestedUrls.push(`${method} ${path}${parsed.search}`);

    if (path === "/api/portfolio/dataset-status") {
      const ready = opts.dataReady !== false;
      return json(200, {
        dataReady: ready,
        symbols: 5,
        symbolsWithData: ready ? 5 : 0,
        coveragePct: ready ? 100 : 0,
        asOfTradeDate: opts.tradeDates.at(-1) ?? null,
        generatedAt: "2026-09-11T00:00:00.000Z",
      });
    }

    if (path === "/api/portfolio/trading-dates") {
      const start = parsed.searchParams.get("start");
      const end = parsed.searchParams.get("end");
      const dates = opts.tradeDates.filter(
        (date) => (start === null || date >= start) && (end === null || date <= end),
      );
      return json(200, { tradeDates: dates });
    }

    const streamsMatch = path.match(/^\/api\/portfolio\/simulations\/([^/]+)\/streams$/);
    if (streamsMatch !== null && method === "GET") {
      return json(
        200,
        Object.entries(opts.streams).map(([agentKey, lastTradeDate]) => ({
          agentKey,
          personaKey: agentKey.split("--")[0],
          window: agentKey.split("--")[1],
          lastTradeDate,
        })),
      );
    }

    const bookMatch = path.match(
      /^\/api\/portfolio\/simulations\/([^/]+)\/streams\/([^/]+)\/([^/]+)$/,
    );
    if (bookMatch !== null && method === "GET") {
      return json(404, { error: "no materialized book" });
    }

    const datasetMatch = path.match(/^\/api\/portfolio\/rounds\/([^/]+)\/dataset$/);
    if (datasetMatch !== null) {
      const roundId = decodeURIComponent(datasetMatch[1]);
      if (method === "POST") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        datasetPins.push({ roundId, asOfTradeDate: body.asOfTradeDate });
        return json(200, { ok: true });
      }
      const pin = datasetPins.find((entry) => entry.roundId === roundId);
      return json(200, {
        schemaVersion: 1,
        roundId,
        asOfTradeDate: pin?.asOfTradeDate ?? "",
        generatedAt: "2026-09-11T00:00:00.000Z",
        universe: [
          { symbol: "AAPL", hasData: true, latestClose: 100 },
          { symbol: "MSFT", hasData: true, latestClose: 200 },
        ],
      });
    }

    const jobMatch = path.match(/^\/api\/portfolio\/rounds\/([^/]+)\/job$/);
    if (jobMatch !== null) {
      const roundId = decodeURIComponent(jobMatch[1]);
      if (method === "POST") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const asOfTradeDate = body.asOfTradeDate as string;
        events.push(`job:${roundId}`);
        jobPosts.push({
          roundId,
          asOfTradeDate,
          agentKeys: (body.agents ?? []).map((agent: { agentKey: string }) => agent.agentKey),
        });
        if (opts.rejectOn === asOfTradeDate) {
          return json(409, {
            code: "OUT_OF_SEQUENCE",
            error: "date is at or before the stream's last applied round_seq",
            hint: "Launch a later date.",
          });
        }
        roundSeq += 1;
        const agents: StubAgent[] = (body.agents ?? []).map(
          (agent: { agentKey: string; personaKey: string }) => {
            const window = agent.agentKey.split("--")[1];
            const last = opts.streams[agent.agentKey] ?? null;
            const due =
              last === null || countSince(opts.tradeDates, last, asOfTradeDate) >= CADENCE[window];
            if (due) opts.streams[agent.agentKey] = asOfTradeDate;
            return {
              agentKey: agent.agentKey,
              personaKey: agent.personaKey,
              status: due ? "pending" : "not_due",
              runId: null,
              picks: null,
              attempts: null,
              error: null,
              startedAt: null,
              completedAt: null,
              updatedAt: "",
            };
          },
        );
        const round: StubRound = {
          roundId,
          asOfTradeDate,
          simulationId: body.simulationId ?? null,
          roundSeq,
          status: "launching",
          agents,
        };
        rounds.set(roundId, round);
        return json(201, { roundId, job: jobShell(round), agents });
      }
      if (method === "PATCH") {
        const round = rounds.get(roundId);
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        events.push(`status:${roundId}:${body.status}`);
        if (round !== undefined) round.status = body.status;
        return json(200, { job: round !== undefined ? jobShell(round) : null });
      }
      const round = rounds.get(roundId);
      if (round === undefined) return json(404, { error: "no job" });
      return json(200, { roundId, job: jobShell(round), agents: round.agents });
    }

    const agentMatch = path.match(/^\/api\/portfolio\/rounds\/([^/]+)\/job\/agents\/([^/]+)$/);
    if (agentMatch !== null && method === "PUT") {
      const roundId = decodeURIComponent(agentMatch[1]);
      const agentKey = decodeURIComponent(agentMatch[2]);
      const round = rounds.get(roundId);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const agent = round?.agents.find((entry) => entry.agentKey === agentKey);
      if (agent !== undefined) Object.assign(agent, body);
      return json(200, { agent: agent ?? null });
    }

    if (path === "/api/portfolio/runs" && method === "POST") {
      runId += 1;
      return json(201, { ok: true, agentRunId: runId, positionsInserted: 5 });
    }

    return json(404, { error: `unhandled ${method} ${path}` });
  };

  const backend = createBackendClient("http://backend:3000", (async (
    url: RequestInfo | URL,
    init?: RequestInit,
  ) => handler(String(url), init)) as unknown as typeof fetch);
  const store = createRoundStore(backend);

  const spawn = (async (options: {
    agentKey: string;
    roundId: string;
    asOfTradeDate: string;
    roundSeq?: number;
    simulationId?: string;
  }) => ({
    envelope: {
      schemaVersion: 2,
      roundId: options.roundId,
      simulationId: options.simulationId ?? "",
      roundSeq: options.roundSeq ?? 1,
      agent: {
        agentKey: options.agentKey,
        persona: options.agentKey,
        strategy: "value",
        window: options.agentKey.split("--")[1],
        portfolioValue: 100000,
        cash: 100000,
        holdingsValue: 0,
        priorRoundId: null,
        roundSeq: options.roundSeq ?? 1,
      },
      rationale: "Stub decision.",
      positions: ["AAPL", "MSFT", "KO", "PG", "JNJ"].map((symbol) => ({
        symbol,
        targetWeight: 0.2,
        thesis: `Line in ${symbol}.`,
      })),
    },
    rawOutput: "{}",
    attempts: 1,
  })) as never;

  const deps: EvalPeriodDeps = { backend, store, config: CONFIG, spawn };
  return { deps, events, jobPosts, datasetPins, requestedUrls, rounds };
}

/** Nine weekdays: 2026-09-01 .. 2026-09-11 (05/06 are a weekend). */
const WEEKDAYS = [
  "2026-09-01",
  "2026-09-02",
  "2026-09-03",
  "2026-09-04",
  "2026-09-07",
  "2026-09-08",
  "2026-09-09",
  "2026-09-10",
  "2026-09-11",
];

describe("parseYmd", () => {
  it("accepts a strict calendar date", () => {
    expect(parseYmd("2026-09-01")).toBe("2026-09-01");
  });

  it("rejects non-YYYY-MM-DD shapes", () => {
    expect(parseYmd("2026-9-1")).toBeNull();
    expect(parseYmd("09/01/2026")).toBeNull();
    expect(parseYmd("")).toBeNull();
    expect(parseYmd("2026-09-01T00:00:00Z")).toBeNull();
  });

  it("rejects rollovers and out-of-range months", () => {
    expect(parseYmd("2026-02-30")).toBeNull();
    expect(parseYmd("2026-13-01")).toBeNull();
  });
});

describe("buildEvalRoundId", () => {
  it("mints the eval-<simId>-<date> pattern", () => {
    expect(buildEvalRoundId("sim-baseline", "2026-09-22")).toBe("eval-sim-baseline-2026-09-22");
  });
});

describe("streamDueAt", () => {
  const cal = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"];

  it("treats a first round (null) as always due", () => {
    expect(streamDueAt("weekly", null, "2026-09-05", cal)).toBe(true);
  });

  it("honours the daily cadence (1 trading day)", () => {
    expect(streamDueAt("daily", "2026-09-01", "2026-09-01", cal)).toBe(false);
    expect(streamDueAt("daily", "2026-09-01", "2026-09-02", cal)).toBe(true);
  });

  it("honours the weekly cadence (5 trading days)", () => {
    expect(streamDueAt("weekly", "2026-08-31", "2026-09-04", cal)).toBe(false);
    expect(streamDueAt("weekly", "2026-08-31", "2026-09-05", cal)).toBe(true);
  });

  it("honours the monthly cadence (21 trading days)", () => {
    const oct = Array.from({ length: 21 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
    expect(streamDueAt("monthly", "2026-09-30", "2026-10-20", oct)).toBe(false);
    expect(streamDueAt("monthly", "2026-09-30", "2026-10-21", oct)).toBe(true);
  });
});

describe("runEvalPeriod", () => {
  it("skips dates where no selected stream is due and books the rest in ascending order", async () => {
    const harness = makeHarness({
      tradeDates: WEEKDAYS,
      streams: { "dr-value--daily": "2026-09-01", "dr-value--weekly": "2026-09-01" },
    });

    const result = await runEvalPeriod(
      {
        simId: "sim-baseline",
        start: "2026-09-01",
        end: "2026-09-11",
        agents: "dr-value",
        windows: "daily,weekly",
      },
      harness.deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 09-01 is skipped (both streams decided that day); 09-08 is the weekly's
    // fifth trading day, so both streams are due there.
    expect(result.skippedDates).toEqual(["2026-09-01"]);
    expect(result.rounds.map((round) => round.asOfTradeDate)).toEqual([
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
    ]);
    expect(result.rounds.map((round) => round.roundId)).toEqual(
      result.rounds.map((round) => buildEvalRoundId("sim-baseline", round.asOfTradeDate)),
    );
    expect(result.rounds.every((round) => round.status === "done")).toBe(true);
    expect(result.rounds.every((round) => round.totalRuns === 2)).toBe(true);
    expect(result.rounds.map((round) => round.insertedRuns)).toEqual([1, 1, 1, 1, 2, 1, 1, 1]);
  });

  it("launches each round fully before evaluating the next date", async () => {
    const harness = makeHarness({
      tradeDates: WEEKDAYS,
      streams: { "dr-value--daily": "2026-09-01" },
    });

    await runEvalPeriod(
      {
        simId: "sim-baseline",
        start: "2026-09-01",
        end: "2026-09-03",
        agents: "dr-value",
        windows: "daily",
      },
      harness.deps,
    );

    // Each round's job POST, running, and done transitions are strictly ordered:
    // the next date is not evaluated until the previous round has finalized.
    expect(harness.events).toEqual([
      "job:eval-sim-baseline-2026-09-02",
      "status:eval-sim-baseline-2026-09-02:running",
      "status:eval-sim-baseline-2026-09-02:done",
      "job:eval-sim-baseline-2026-09-03",
      "status:eval-sim-baseline-2026-09-03:running",
      "status:eval-sim-baseline-2026-09-03:done",
    ]);
    expect(harness.jobPosts.map((post) => post.asOfTradeDate)).toEqual([
      "2026-09-02",
      "2026-09-03",
    ]);
  });

  it("extends the calendar when a stream's last decision predates the window", async () => {
    const harness = makeHarness({
      tradeDates: [
        "2026-08-25",
        "2026-08-26",
        "2026-08-27",
        "2026-08-28",
        "2026-08-31",
        "2026-09-01",
        "2026-09-02",
      ],
      streams: { "dr-value--daily": "2026-08-25" },
    });

    const result = await runEvalPeriod(
      {
        simId: "sim-baseline",
        start: "2026-09-01",
        end: "2026-09-02",
        agents: "dr-value",
        windows: "daily",
      },
      harness.deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Without the extension the 09-01 count would read 0 and the date would be
    // skipped; the extension makes it 5 trading days, so it is due.
    expect(result.rounds.map((round) => round.asOfTradeDate)).toEqual(["2026-09-01", "2026-09-02"]);
    expect(
      harness.requestedUrls.some((url) =>
        url.includes("/api/portfolio/trading-dates?start=2026-08-25&end=2026-09-02"),
      ),
    ).toBe(true);
  });

  it("stops at the first refused date and reports the code, hint, and next step", async () => {
    const harness = makeHarness({
      tradeDates: WEEKDAYS,
      streams: { "dr-value--daily": "2026-09-01", "dr-value--weekly": "2026-09-01" },
      rejectOn: "2026-09-04",
    });

    const result = await runEvalPeriod(
      {
        simId: "sim-baseline",
        start: "2026-09-01",
        end: "2026-09-11",
        agents: "dr-value",
        windows: "daily,weekly",
      },
      harness.deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stoppedAt).toBe("2026-09-04");
    expect(result.code).toBe("OUT_OF_SEQUENCE");
    expect(result.hint).toBe("Launch a later date.");
    expect(result.nextStep).toBe(RERUN_ACTIONS.OUT_OF_SEQUENCE);
    expect(result.rounds.map((round) => round.asOfTradeDate)).toEqual(["2026-09-02", "2026-09-03"]);
    expect(result.skippedDates).toEqual(["2026-09-01"]);
    // Nothing past the refusal was attempted.
    expect(harness.jobPosts.map((post) => post.asOfTradeDate)).toEqual([
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
    ]);
  });

  it("fails fast on an invalid round id before launching anything", async () => {
    const harness = makeHarness({
      tradeDates: WEEKDAYS,
      streams: { "dr-value--daily": "2026-09-01" },
    });

    const result = await runEvalPeriod(
      {
        simId: "sim-bad/id",
        start: "2026-09-01",
        end: "2026-09-11",
        agents: "dr-value",
        windows: "daily",
      },
      harness.deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stoppedAt).toBeNull();
    expect(result.error).toMatch(/round id/);
    expect(harness.jobPosts).toEqual([]);
  });

  it("reports a not-ready dataset without launching", async () => {
    const harness = makeHarness({
      tradeDates: WEEKDAYS,
      streams: { "dr-value--daily": "2026-09-01" },
      dataReady: false,
    });

    const result = await runEvalPeriod(
      {
        simId: "sim-baseline",
        start: "2026-09-01",
        end: "2026-09-11",
        agents: "dr-value",
        windows: "daily",
      },
      harness.deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stoppedAt).toBeNull();
    expect(result.error).toMatch(/Dataset not ready/);
    expect(result.hint).toMatch(/ingestion/);
    expect(harness.jobPosts).toEqual([]);
  });

  it("rejects a malformed start date", async () => {
    const harness = makeHarness({ tradeDates: WEEKDAYS, streams: {} });
    const result = await runEvalPeriod(
      { simId: "sim-baseline", start: "09/01/2026", end: "2026-09-11" },
      harness.deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stoppedAt).toBeNull();
    expect(result.error).toMatch(/start must be a YYYY-MM-DD date/);
  });

  it("rejects an end date before the start date", async () => {
    const harness = makeHarness({ tradeDates: WEEKDAYS, streams: {} });
    const result = await runEvalPeriod(
      { simId: "sim-baseline", start: "2026-09-11", end: "2026-09-01" },
      harness.deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/must not be before start/);
  });

  it("returns an empty success when the window has no trade dates", async () => {
    const harness = makeHarness({ tradeDates: WEEKDAYS, streams: {} });
    const result = await runEvalPeriod(
      { simId: "sim-baseline", start: "2026-10-01", end: "2026-10-31" },
      harness.deps,
    );
    expect(result).toEqual({
      ok: true,
      simId: "sim-baseline",
      start: "2026-10-01",
      end: "2026-10-31",
      rounds: [],
      skippedDates: [],
    });
  });
});
