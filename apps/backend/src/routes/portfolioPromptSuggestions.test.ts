/**
 * Route-shape tests for POST/GET /portfolio/prompt-suggestions.
 *
 * Supabase is faked so authMiddleware runs for real (401s happen before any
 * network call), and `runSuggestionBatch`/`listSuggestions` are replaced so no
 * database is touched — these cases pin the wire contract only: 401 auth, 400
 * parse/persona/window, 503 missing model key, 200 passthrough (POST result,
 * GET listing + filter forwarding), 500 unexpected failure.
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
    JUDGE_API_KEY: undefined as string | undefined,
  },
}));

vi.mock("../evaluation/promptSuggestions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../evaluation/promptSuggestions.js")>();
  return { ...actual, runSuggestionBatch: vi.fn(), listSuggestions: vi.fn() };
});

import { env } from "../env.js";
import { listSuggestions, runSuggestionBatch } from "../evaluation/promptSuggestions.js";
import type { SuggestionBatchResult, SuggestionListItem } from "../evaluation/promptSuggestions.js";
import portfolioPromptSuggestionsApp from "./portfolioPromptSuggestions.js";

const mockedRun = vi.mocked(runSuggestionBatch);
const mockedList = vi.mocked(listSuggestions);

const app = new Hono().basePath("/api").route("/portfolio", portfolioPromptSuggestionsApp);

const VALID_BODY = { personaKey: "dr-value" };

const BATCH_RESULT: SuggestionBatchResult = {
  judgeKey: "prompt-critic",
  judgeVersion: "1",
  model: "test/critic-model",
  promptSetVersion: "v1",
  results: [
    {
      personaKey: "dr-value",
      window: "daily",
      promptHash: "hash-abc",
      status: "generated",
      suggestionId: 7,
    },
  ],
  summary: { generated: 1, skipped: 0, errors: 0 },
};

const SUGGESTION: SuggestionListItem = {
  id: 7,
  personaKey: "dr-value",
  window: "daily",
  promptSetVersion: "v1",
  sourcePromptHash: "hash-abc",
  judgeKey: "prompt-critic",
  judgeVersion: "1",
  critiques: "critique text",
  proposals: [],
  judgeModel: "test/critic-model",
  createdAt: "2026-01-01T00:00:00.000Z",
  isCurrent: true,
};

const ENDPOINT = "/api/portfolio/prompt-suggestions";

function post(body: unknown, token?: string): Promise<Response> {
  return Promise.resolve(
    app.request(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function get(query = "", token?: string): Promise<Response> {
  return Promise.resolve(
    app.request(`${ENDPOINT}${query}`, {
      method: "GET",
      headers: token !== undefined ? { Authorization: `Bearer ${token}` } : {},
    }),
  );
}

beforeEach(() => {
  env.JUDGE_API_KEY = undefined;
  mockedRun.mockReset();
  mockedList.mockReset();
  getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
});

describe("POST /portfolio/prompt-suggestions auth", () => {
  it("rejects a request with no Authorization header with 401", async () => {
    const res = await post(VALID_BODY);
    expect(res.status).toBe(401);
    expect(mockedRun).not.toHaveBeenCalled();
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer token with 401 before any critic work", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: { message: "bad token" } });
    const res = await post(VALID_BODY, "invalid-token");
    expect(res.status).toBe(401);
    expect(mockedRun).not.toHaveBeenCalled();
  });
});

describe("POST /portfolio/prompt-suggestions body validation", () => {
  it("rejects a body that is not valid JSON with 400", async () => {
    const res = await post("{not json", "valid-token");
    expect(res.status).toBe(400);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("rejects a missing personaKey with 400", async () => {
    const res = await post({}, "valid-token");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: /personaKey/ });
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("rejects an empty personaKey with 400", async () => {
    const res = await post({ personaKey: "  " }, "valid-token");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: /personaKey/ });
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("rejects an unknown persona with 400 listing the available keys", async () => {
    const res = await post({ personaKey: "nope" }, "valid-token");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: /Unknown analyst persona/ });
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("rejects a window outside the analyst windows with 400", async () => {
    const res = await post({ ...VALID_BODY, window: "yearly" }, "valid-token");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: /body\.window/ });
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("rejects a wrongly typed optional force with 400", async () => {
    const res = await post({ ...VALID_BODY, force: "yes" }, "valid-token");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: /body\.force/ });
    expect(mockedRun).not.toHaveBeenCalled();
  });
});

describe("POST /portfolio/prompt-suggestions model key configuration", () => {
  it("answers 503 with a setup hint when JUDGE_API_KEY is not configured", async () => {
    const res = await post(VALID_BODY, "valid-token");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "judge model API key not configured",
      hint: "set JUDGE_API_KEY",
    });
    expect(mockedRun).not.toHaveBeenCalled();
  });
});

describe("POST /portfolio/prompt-suggestions success and failure", () => {
  it("returns the batch result with 200 once the key is configured", async () => {
    env.JUDGE_API_KEY = "test-key";
    mockedRun.mockResolvedValue(BATCH_RESULT);

    const res = await post(VALID_BODY, "valid-token");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(BATCH_RESULT);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(mockedRun).toHaveBeenCalledWith(expect.anything(), { personaKey: "dr-value" });
  });

  it("forwards explicit window and model overrides to the batch", async () => {
    env.JUDGE_API_KEY = "test-key";
    mockedRun.mockResolvedValue(BATCH_RESULT);

    const res = await post(
      { personaKey: "dr-value", window: "weekly", model: " alt/critic-model " },
      "valid-token",
    );

    expect(res.status).toBe(200);
    expect(mockedRun).toHaveBeenCalledWith(expect.anything(), {
      personaKey: "dr-value",
      window: "weekly",
      model: "alt/critic-model",
    });
  });

  it("maps an unexpected batch failure to 500 with the message", async () => {
    env.JUDGE_API_KEY = "test-key";
    mockedRun.mockRejectedValue(new Error("database unreachable"));

    const res = await post(VALID_BODY, "valid-token");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "database unreachable" });
  });
});

describe("GET /portfolio/prompt-suggestions auth", () => {
  it("rejects a request with no Authorization header with 401", async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect(mockedList).not.toHaveBeenCalled();
  });
});

describe("GET /portfolio/prompt-suggestions listing", () => {
  it("returns an empty suggestion list with 200", async () => {
    mockedList.mockResolvedValue([]);

    const res = await get("", "valid-token");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [] });
    expect(mockedList).toHaveBeenCalledTimes(1);
  });

  it("returns the listed suggestions with 200", async () => {
    mockedList.mockResolvedValue([SUGGESTION]);

    const res = await get("", "valid-token");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [SUGGESTION] });
  });

  it("forwards persona, window, and prompt-set-version filters to the list", async () => {
    mockedList.mockResolvedValue([]);

    const res = await get("?personaKey=dr-value&window=daily&promptSetVersion=v1", "valid-token");

    expect(res.status).toBe(200);
    expect(mockedList).toHaveBeenCalledWith(expect.anything(), {
      personaKey: "dr-value",
      window: "daily",
      promptSetVersion: "v1",
    });
  });

  it("maps an unexpected list failure to 500 with the message", async () => {
    mockedList.mockRejectedValue(new Error("database unreachable"));

    const res = await get("", "valid-token");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "database unreachable" });
  });
});
