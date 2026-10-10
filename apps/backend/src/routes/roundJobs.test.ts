/**
 * Pure-function tests for the durable round-job routes.
 *
 * No database is touched: every case exercises an exported parser or wire
 * converter. DB-backed behavior (the atomic launch guard, the FK precondition)
 * is covered by the workspace lifecycle verify in the feature environment.
 */

import { describe, expect, it } from "vitest";
import type { RoundAgentProgress, RoundJob } from "@model_md/database";
import {
  parsePatchRoundJobBody,
  parsePutAgentProgressBody,
  parseStartRoundBody,
  statusForAgent,
  toRoundAgentProgressWire,
  toRoundJobWire,
} from "./roundJobs.js";

const JOB: RoundJob = {
  roundId: "w1",
  status: "running",
  simulationId: "sim-baseline",
  roundSeq: 1,
  advanceMode: "carry",
  asOfTradeDate: "2026-09-25",
  datasetPath: "/app/worktrees/slug/rounds/w1/dataset.json",
  maxParallel: 3,
  capital: "100000",
  error: null,
  startedAt: new Date("2026-09-25T18:00:00.000Z"),
  completedAt: null,
  updatedAt: new Date("2026-09-25T18:30:00.000Z"),
  createdAt: new Date("2026-09-25T18:00:00.000Z"),
};

const PROGRESS: RoundAgentProgress = {
  id: 1,
  roundId: "w1",
  agentKey: "dr-value",
  personaKey: "dr-value",
  status: "inserted",
  runId: 7,
  picks: 5,
  attempts: 1,
  error: null,
  startedAt: new Date("2026-09-25T18:00:05.000Z"),
  completedAt: new Date("2026-09-25T18:01:00.000Z"),
  updatedAt: new Date("2026-09-25T18:01:00.000Z"),
  createdAt: new Date("2026-09-25T18:00:00.000Z"),
};

describe("parseStartRoundBody", () => {
  const valid = {
    agents: [{ agentKey: "dr-value", personaKey: "dr-value" }],
    maxParallel: 3,
    capital: 100000,
  };

  it("accepts a minimal launch payload and defaults takeover and replace to false", () => {
    expect(parseStartRoundBody(valid)).toEqual({ ...valid, takeover: false, replace: false });
  });

  it("trims agent and persona keys", () => {
    const parsed = parseStartRoundBody({
      ...valid,
      agents: [{ agentKey: "  dr-value ", personaKey: " dr-value  " }],
    });
    expect(parsed.agents).toEqual([{ agentKey: "dr-value", personaKey: "dr-value" }]);
  });

  it("keeps optional dataset metadata and an explicit takeover", () => {
    const parsed = parseStartRoundBody({
      ...valid,
      asOfTradeDate: "2026-09-25",
      datasetPath: "/tmp/dataset.json",
      takeover: true,
    });
    expect(parsed.asOfTradeDate).toBe("2026-09-25");
    expect(parsed.datasetPath).toBe("/tmp/dataset.json");
    expect(parsed.takeover).toBe(true);
  });

  it("rejects a non-object body", () => {
    expect(() => parseStartRoundBody("nope")).toThrow(/must be a JSON object/);
    expect(() => parseStartRoundBody(null)).toThrow(/must be a JSON object/);
  });

  it("rejects an empty or malformed agents array", () => {
    expect(() => parseStartRoundBody({ ...valid, agents: [] })).toThrow(/non-empty array/);
    expect(() => parseStartRoundBody({ ...valid, agents: "dr-value" })).toThrow(/non-empty array/);
    expect(() => parseStartRoundBody({ ...valid, agents: [{ agentKey: "a" }] })).toThrow(
      /agents\[0\]/,
    );
    expect(() =>
      parseStartRoundBody({ ...valid, agents: [{ agentKey: "  ", personaKey: "a" }] }),
    ).toThrow(/agents\[0\]/);
  });

  it("rejects a non-integer or non-positive maxParallel", () => {
    expect(() => parseStartRoundBody({ ...valid, maxParallel: 0 })).toThrow(/positive integer/);
    expect(() => parseStartRoundBody({ ...valid, maxParallel: 1.5 })).toThrow(/positive integer/);
    expect(() => parseStartRoundBody({ ...valid, maxParallel: "3" })).toThrow(/positive integer/);
  });

  it("rejects a non-positive or non-finite capital", () => {
    expect(() => parseStartRoundBody({ ...valid, capital: 0 })).toThrow(/positive number/);
    expect(() => parseStartRoundBody({ ...valid, capital: -1 })).toThrow(/positive number/);
    expect(() => parseStartRoundBody({ ...valid, capital: Number.NaN })).toThrow(/positive number/);
  });

  it("rejects wrongly typed optional fields", () => {
    expect(() => parseStartRoundBody({ ...valid, asOfTradeDate: 5 })).toThrow(/asOfTradeDate/);
    expect(() => parseStartRoundBody({ ...valid, datasetPath: 5 })).toThrow(/datasetPath/);
    expect(() => parseStartRoundBody({ ...valid, takeover: "yes" })).toThrow(/takeover/);
  });
});

describe("parsePatchRoundJobBody", () => {
  it("accepts each round status", () => {
    for (const status of ["launching", "running", "done", "partial", "error"]) {
      expect(parsePatchRoundJobBody({ status })).toEqual({ status, error: undefined });
    }
  });

  it("carries an error string through", () => {
    expect(parsePatchRoundJobBody({ status: "error", error: "boom" })).toEqual({
      status: "error",
      error: "boom",
    });
  });

  it("rejects an unknown status and a non-string error", () => {
    expect(() => parsePatchRoundJobBody({ status: "cancelled" })).toThrow(
      /body.status must be one of/,
    );
    expect(() => parsePatchRoundJobBody({ status: "done", error: 5 })).toThrow(/body.error/);
  });
});

describe("parsePutAgentProgressBody", () => {
  it("accepts a status-only patch", () => {
    expect(parsePutAgentProgressBody({ status: "running" })).toEqual({
      status: "running",
      runId: undefined,
      picks: undefined,
      attempts: undefined,
      error: undefined,
      startedAt: undefined,
      completedAt: undefined,
    });
  });

  it("normalizes timestamps to ISO strings", () => {
    const parsed = parsePutAgentProgressBody({
      status: "inserted",
      startedAt: "2026-09-25T18:00:00.000Z",
      completedAt: "2026-09-25T18:01:00.000Z",
    });
    expect(parsed.startedAt).toBe("2026-09-25T18:00:00.000Z");
    expect(parsed.completedAt).toBe("2026-09-25T18:01:00.000Z");
  });

  it("drops an unparseable timestamp instead of writing Invalid Date", () => {
    expect(
      parsePutAgentProgressBody({ status: "running", startedAt: "not-a-date" }).startedAt,
    ).toBeUndefined();
  });

  it("rejects an unknown agent status", () => {
    expect(() => parsePutAgentProgressBody({ status: "inserted-ish" })).toThrow(
      /body.status must be one of/,
    );
  });

  it("accepts the not_due cadence status", () => {
    expect(parsePutAgentProgressBody({ status: "not_due" }).status).toBe("not_due");
  });

  it("rejects non-integer counters", () => {
    expect(() => parsePutAgentProgressBody({ status: "inserted", runId: 1.5 })).toThrow(/runId/);
    expect(() => parsePutAgentProgressBody({ status: "inserted", picks: "3" })).toThrow(/picks/);
    expect(() => parsePutAgentProgressBody({ status: "inserted", attempts: null })).not.toThrow();
  });
});

describe("statusForAgent", () => {
  it("stamps a due stream pending and a not-due stream not_due", () => {
    const due = new Map<string, boolean>([
      ["dr-value--daily", true],
      ["dr-value--weekly", false],
    ]);
    expect(statusForAgent("dr-value--daily", due)).toBe("pending");
    expect(statusForAgent("dr-value--weekly", due)).toBe("not_due");
  });

  it("launches an agent whose window cannot be decoded", () => {
    expect(statusForAgent("dr-value", new Map())).toBe("pending");
  });

  it("launches an agent missing from the due map rather than skipping it", () => {
    expect(statusForAgent("dr-macro--monthly", new Map())).toBe("pending");
  });
});

describe("wire converters", () => {
  it("serializes a job with ISO timestamps and string capital", () => {
    expect(toRoundJobWire(JOB)).toEqual({
      roundId: "w1",
      status: "running",
      asOfTradeDate: "2026-09-25",
      datasetPath: "/app/worktrees/slug/rounds/w1/dataset.json",
      maxParallel: 3,
      capital: "100000",
      error: null,
      startedAt: "2026-09-25T18:00:00.000Z",
      completedAt: null,
      updatedAt: "2026-09-25T18:30:00.000Z",
      simulationId: "sim-baseline",
      roundSeq: 1,
    });
  });

  it("keeps a null asOfTradeDate null", () => {
    expect(toRoundJobWire({ ...JOB, asOfTradeDate: null }).asOfTradeDate).toBeNull();
  });

  it("serializes agent progress with ISO timestamps", () => {
    expect(toRoundAgentProgressWire(PROGRESS)).toEqual({
      agentKey: "dr-value",
      personaKey: "dr-value",
      status: "inserted",
      runId: 7,
      picks: 5,
      attempts: 1,
      error: null,
      startedAt: "2026-09-25T18:00:05.000Z",
      completedAt: "2026-09-25T18:01:00.000Z",
      updatedAt: "2026-09-25T18:01:00.000Z",
    });
  });
});
