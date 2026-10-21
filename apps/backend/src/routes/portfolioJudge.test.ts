/**
 * Route-shape tests for POST /portfolio/evals/judge.
 *
 * Supabase is faked so authMiddleware runs for real (401s happen before any
 * network call), and `runJudgeBatch` is replaced so no database is touched —
 * these cases pin the wire contract only: 401 auth, 400 parse/target, 503
 * missing MCP gateway config, 200 batch result passthrough, 500 unexpected
 * failure.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUserMock } = vi.hoisted(() => ({ getUserMock: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser: getUserMock } }),
}));

vi.mock("../env.js", () => ({
  env: {
    SUPABASE_URL: "http://supabase.test",
    SUPABASE_ANON_KEY: "anon-key",
    JUDGE_MODEL: "test/judge-model",
    MCP_GATEWAY_URL: "",
    MCP_GATEWAY_AUTH_TOKEN: undefined as string | undefined,
  },
}));

vi.mock("../evaluation/judgeBatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../evaluation/judgeBatch.js")>();
  return { ...actual, runJudgeBatch: vi.fn() };
});

import { env } from "../env.js";
import { JudgeTargetError, runJudgeBatch } from "../evaluation/judgeBatch.js";
import type { JudgeBatchResult } from "../evaluation/judgeBatch.js";
import portfolioJudgeApp from "./portfolioJudge.js";

const mockedRun = vi.mocked(runJudgeBatch);

const app = new Hono().basePath("/api").route("/portfolio", portfolioJudgeApp);

const VALID_BODY = { simulationId: "sim-a" };

const BATCH_RESULT: JudgeBatchResult = {
  judgeKey: "process",
  judgeVersion: "1",
  model: "test/judge-model",
  results: [{ runId: 1, agentKey: "dr-value--daily", status: "scored" }],
  summary: { scored: 1, skipped: 0, errors: 0 },
};

function post(body: unknown, token?: string): Promise<Response> {
  return Promise.resolve(
    app.request("/api/portfolio/evals/judge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  env.MCP_GATEWAY_URL = "";
  env.MCP_GATEWAY_AUTH_TOKEN = undefined;
  mockedRun.mockReset();
  getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
});

function configureGateway(): void {
  env.MCP_GATEWAY_URL = "http://mcp-gateway:8811/mcp";
  env.MCP_GATEWAY_AUTH_TOKEN = "test-token";
}

describe("POST /portfolio/evals/judge auth", () => {
  it("rejects a request with no Authorization header with 401", async () => {
    const res = await post(VALID_BODY);
    expect(res.status).toBe(401);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer token with 401 before any judge work", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: { message: "bad token" } });
    const res = await post(VALID_BODY, "invalid-token");
    expect(res.status).toBe(401);
    expect(mockedRun).not.toHaveBeenCalled();
  });
});

describe("POST /portfolio/evals/judge body validation", () => {
  it("rejects a body that is not valid JSON with 400", async () => {
    const res = await post("{not json", "valid-token");
    expect(res.status).toBe(400);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("rejects a target that selects both simulation and roundIds with 400", async () => {
    const res = await post({ simulationId: "sim-a", roundIds: ["r1"] }, "valid-token");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: /exactly one/ });
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("rejects a wrongly typed optional field with 400", async () => {
    const res = await post({ simulationId: "sim-a", force: "yes" }, "valid-token");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: /body\.force/ });
  });
});

describe("POST /portfolio/evals/judge gateway configuration", () => {
  it("answers 503 with a setup hint when the MCP gateway is not configured", async () => {
    const res = await post(VALID_BODY, "valid-token");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "judge not configured",
      hint: "set MCP_GATEWAY_URL and MCP_GATEWAY_AUTH_TOKEN",
    });
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("answers 503 when the gateway auth token is blank", async () => {
    env.MCP_GATEWAY_URL = "http://mcp-gateway:8811/mcp";
    const res = await post(VALID_BODY, "valid-token");
    expect(res.status).toBe(503);
    expect(mockedRun).not.toHaveBeenCalled();
  });
});

describe("POST /portfolio/evals/judge success and failure", () => {
  it("returns the batch result with 200 once the gateway is configured", async () => {
    configureGateway();
    mockedRun.mockResolvedValue(BATCH_RESULT);

    const res = await post(VALID_BODY, "valid-token");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(BATCH_RESULT);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(mockedRun).toHaveBeenCalledWith(expect.anything(), VALID_BODY);
  });

  it("forwards an explicit judge model override to the batch", async () => {
    configureGateway();
    mockedRun.mockResolvedValue(BATCH_RESULT);

    const res = await post({ ...VALID_BODY, judgeModel: "alt/judge-model" }, "valid-token");

    expect(res.status).toBe(200);
    expect(mockedRun).toHaveBeenCalledWith(expect.anything(), {
      simulationId: "sim-a",
      judgeModel: "alt/judge-model",
    });
  });

  it("maps a target validation failure raised by the batch to 400", async () => {
    configureGateway();
    mockedRun.mockRejectedValue(new JudgeTargetError("no runs matched the target"));

    const res = await post(VALID_BODY, "valid-token");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no runs matched the target" });
  });

  it("maps an unexpected batch failure to 500 with the message", async () => {
    configureGateway();
    mockedRun.mockRejectedValue(new Error("database unreachable"));

    const res = await post(VALID_BODY, "valid-token");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "database unreachable" });
  });
});
