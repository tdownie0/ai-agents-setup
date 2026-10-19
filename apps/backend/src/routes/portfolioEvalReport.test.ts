/**
 * Route contract tests for GET /portfolio/evals/report: query validation
 * (400s before any db work) and argument pass-through to buildEvalReport.
 * The report builder is mocked; validation runs real code.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEvalReport } from "../evaluation/report.js";
import type { EvalReport } from "../evaluation/reportAggregates.js";
import portfolioEvalReportApp from "./portfolioEvalReport.js";

vi.mock("../evaluation/report.js", () => ({ buildEvalReport: vi.fn() }));

const mockedBuild = vi.mocked(buildEvalReport);

const EMPTY_REPORT: EvalReport = {
  start: null,
  end: null,
  judgeKey: "process",
  simIds: ["sim-a"],
  groups: [],
  warnings: [],
};

const get = (query: string) => portfolioEvalReportApp.request(`/evals/report${query}`);

const VALID_SIM_IDS = "sim-a,sim-b";

beforeEach(() => {
  vi.clearAllMocks();
  mockedBuild.mockResolvedValue(EMPTY_REPORT);
});

describe("GET /evals/report validation", () => {
  it("rejects a missing simIds param", async () => {
    const res = await get("");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "simIds query param is required" });
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it("rejects an empty entry from a stray comma", async () => {
    const res = await get("?simIds=sim-a,");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "simIds[1] is empty" });
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it("rejects duplicate simIds so a replicate is never double-counted", async () => {
    const res = await get("?simIds=sim-a,sim-a");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'duplicate simId "sim-a"' });
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it("rejects an id outside the simulation-id pattern", async () => {
    const res = await get("?simIds=not-a-simulation");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'simIds[0] "not-a-simulation" is not a valid simulation id',
    });
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it("rejects more than 10 simIds", async () => {
    const many = Array.from({ length: 11 }, (_, index) => `sim-x${index}`).join(",");
    const res = await get(`?simIds=${many}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "too many simIds (11)" });
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it("rejects a malformed start date", async () => {
    const res = await get(`?simIds=${VALID_SIM_IDS}&start=not-a-date`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid start "not-a-date"' });
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it("rejects start after end", async () => {
    const res = await get(`?simIds=${VALID_SIM_IDS}&start=2026-04-01&end=2026-03-01`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "start must not be after end" });
    expect(mockedBuild).not.toHaveBeenCalled();
  });
});

describe("GET /evals/report success", () => {
  it("passes simIds and defaults through to the report builder", async () => {
    const res = await get(`?simIds=${VALID_SIM_IDS}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY_REPORT);
    expect(mockedBuild).toHaveBeenCalledWith(expect.anything(), {
      simIds: ["sim-a", "sim-b"],
      start: undefined,
      end: undefined,
      judgeKey: undefined,
    });
  });

  it("passes bounds, judgeKey, and trimmed simIds through", async () => {
    const res = await get(
      `?simIds=${VALID_SIM_IDS}&start=2026-03-01&end=2026-03-20&judgeKey=custom`,
    );
    expect(res.status).toBe(200);
    expect(mockedBuild).toHaveBeenCalledWith(expect.anything(), {
      simIds: ["sim-a", "sim-b"],
      start: "2026-03-01",
      end: "2026-03-20",
      judgeKey: "custom",
    });
  });

  it("treats an empty judgeKey as unset", async () => {
    const res = await get(`?simIds=${VALID_SIM_IDS}&judgeKey=%20`);
    expect(res.status).toBe(200);
    expect(mockedBuild).toHaveBeenCalledWith(expect.anything(), {
      simIds: ["sim-a", "sim-b"],
      start: undefined,
      end: undefined,
      judgeKey: undefined,
    });
  });

  it("maps builder failures to a 500 with the error message", async () => {
    mockedBuild.mockRejectedValueOnce(new Error("connection lost"));
    const res = await get(`?simIds=${VALID_SIM_IDS}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "connection lost" });
  });
});
