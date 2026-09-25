/**
 * Pure-function tests for the portfolio-orchestrator MCP server.
 *
 * `src/index.ts` is intentionally NOT imported (it connects the stdio
 * transport at module scope and requires runtime env). Everything tested
 * here is a parameter-driven module: config, agent resolution, the job
 * registry + pool, the backend client (stubbed fetch), and the docker-exec
 * spawner (injected exec).
 */

import { describe, expect, it, vi } from "vitest";
import {
  datasetPathFor,
  isValidRoundId,
  resolveAgents,
  type AgentJob,
} from "../src/agents.js";
import { createBackendClient, BackendError } from "../src/backendClient.js";
import { loadConfig, parsePositiveInt, ConfigError } from "../src/config.js";
import { JobRegistry, runPool } from "../src/jobs.js";
import {
  buildAgentStateDirs,
  buildDockerExecArgs,
  spawnAnalystWithExec,
  type ExecImpl,
  type DockerExecResult,
} from "../src/spawnViaDocker.js";

const VALID_ENVELOPE = {
  schemaVersion: 1,
  roundId: "w1",
  agent: {
    agentKey: "dr-value",
    persona: "Dr. Value",
    strategy: "deep-value",
    window: "monthly",
    initialCapital: 100000,
  },
  rationale: "Tests need a valid envelope.",
  picks: [
    { symbol: "AAPL", weight: 0.2, thesis: "Quality franchise." },
    { symbol: "MSFT", weight: 0.2, thesis: "Cloud strength." },
    { symbol: "KO", weight: 0.2, thesis: "Defensive staple." },
    { symbol: "PG", weight: 0.2, thesis: "Consumer defensive." },
    { symbol: "JNJ", weight: 0.2, thesis: "Healthcare leader." },
  ],
};

const UNIVERSE = ["AAPL", "MSFT", "KO", "PG", "JNJ", "TSLA", "XOM"] as const;
const SYMBOLS_WITH_PRICE = new Set<string>(["AAPL", "MSFT", "KO", "PG", "JNJ", "TSLA", "XOM"]);

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
  it("resolves undefined to all personas", () => {
    expect(resolveAgents(undefined)).toHaveLength(6);
  });

  it('resolves "all" and blanks to all personas', () => {
    expect(resolveAgents("all")).toHaveLength(6);
    expect(resolveAgents("")).toHaveLength(6);
    expect(resolveAgents("   ")).toHaveLength(6);
  });

  it("resolves a comma-separated list", () => {
    const jobs: AgentJob[] = resolveAgents("dr-value, dr-momentum");
    expect(jobs).toEqual([
      { personaKey: "dr-value", agentKey: "dr-value" },
      { personaKey: "dr-momentum", agentKey: "dr-momentum" },
    ]);
  });

  it("resolves an array of keys", () => {
    const jobs: AgentJob[] = resolveAgents(["dr-macro", "dr-technical"]);
    expect(jobs.map((job) => job.agentKey)).toEqual(["dr-macro", "dr-technical"]);
  });

  it("throws with the available keys on an unknown persona", () => {
    expect(() => resolveAgents("ghost-picker")).toThrow();
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

describe("JobRegistry", () => {
  it("tracks a round from launch to done", () => {
    const registry = new JobRegistry();
    const job = registry.start("w1");
    expect(job.status).toBe("launching");
    expect(registry.has("w1")).toBe(true);
    expect(registry.get("missing")).toBeUndefined();

    registry.setJobInfo("w1", {
      asOfTradeDate: "2026-09-22",
      datasetPath: "/app/worktrees/slug/rounds/w1/dataset.json",
    });
    const jobs: AgentJob[] = [
      { personaKey: "dr-value", agentKey: "dr-value" },
      { personaKey: "dr-momentum", agentKey: "dr-momentum" },
    ];
    registry.setAgents("w1", jobs);
    expect(registry.get("w1")?.agents.map((agent) => agent.status)).toEqual([
      "pending",
      "pending",
    ]);

    registry.setStatus("w1", "running");
    registry.updateAgent("w1", "dr-value", {
      status: "inserted",
      runId: 7,
      picks: 5,
      attempts: 1,
    });
    registry.updateAgent("w1", "dr-momentum", { status: "inserted", runId: 8, picks: 6 });
    registry.finalize("w1");

    const finished = registry.get("w1");
    expect(finished?.status).toBe("done");
    expect(finished?.completedAt).toBeDefined();
    expect(finished?.agents[0].runId).toBe(7);
  });

  it("finalizes partial when some agents fail", () => {
    const registry = new JobRegistry();
    registry.start("w2");
    registry.setAgents("w2", [
      { personaKey: "dr-value", agentKey: "dr-value" },
      { personaKey: "dr-momentum", agentKey: "dr-momentum" },
    ]);
    registry.updateAgent("w2", "dr-value", { status: "inserted" });
    registry.updateAgent("w2", "dr-momentum", { status: "failed", error: "boom" });
    registry.finalize("w2");
    expect(registry.get("w2")?.status).toBe("partial");
  });

  it("finalizes error when all agents fail", () => {
    const registry = new JobRegistry();
    registry.start("w3");
    registry.setAgents("w3", [
      { personaKey: "dr-value", agentKey: "dr-value" },
      { personaKey: "dr-momentum", agentKey: "dr-momentum" },
    ]);
    registry.updateAgent("w3", "dr-value", { status: "failed", error: "boom" });
    registry.updateAgent("w3", "dr-momentum", { status: "failed", error: "boom" });
    registry.finalize("w3");
    expect(registry.get("w3")?.status).toBe("error");
  });

  it("ignores patches for unknown rounds and agents", () => {
    const registry = new JobRegistry();
    expect(() => registry.updateAgent("nope", "dr-value", { status: "failed" })).not.toThrow();
    registry.start("w4");
    expect(() => registry.updateAgent("w4", "nope", { status: "failed" })).not.toThrow();
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
      fakeResponse(409, { error: "Agent run already exists for round \"w1\"" }),
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
      window: "monthly",
      phdSystemPrompt: "You are a value analyst.",
    };
  }

  const baseOptions = {
    persona: fakePersona(),
    agentKey: "dr-value",
    roundId: "w1",
    datasetPath: "/app/worktrees/slug/rounds/w1/dataset.json",
    asOfTradeDate: "2026-09-22",
    initialCapital: 100000,
    agentContainer: "opencode_agent",
    workdir: "/app/worktrees/slug",
    universe: [...UNIVERSE],
    symbolsWithPrice: SYMBOLS_WITH_PRICE,
  };

  const okExec: ExecImpl = async (args) => ({
    stdout: ndjson(JSON.stringify(VALID_ENVELOPE)),
    stderr: "",
    code: 0,
  });

  it("returns a validated envelope on a successful exec", async () => {
    const result = await spawnAnalystWithExec(baseOptions, okExec);
    expect(result.attempts).toBe(1);
    expect(result.envelope.roundId).toBe("w1");
    expect(result.envelope.picks).toHaveLength(5);
  });

  it("retries once with a correction hint after an invalid envelope", async () => {
    const calls: string[][] = [];
    const exec: ExecImpl = async (args) => {
      calls.push([...args]);
      const bad = { ...VALID_ENVELOPE, picks: VALID_ENVELOPE.picks.slice(0, 1) }; // < MIN_PICKS
      return { stdout: ndjson(JSON.stringify(bad)), stderr: "", code: 0 };
    };
    await expect(spawnAnalystWithExec(baseOptions, exec)).rejects.toThrow(/failed after 2 attempts/);
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
    await expect(spawnAnalystWithExec(baseOptions, exec)).rejects.toThrow(/docker exec exited with code 125/);
  });

  it("strips markdown fences before parsing", async () => {
    const fenced = "```json\n" + JSON.stringify(VALID_ENVELOPE) + "\n```";
    const exec: ExecImpl = async () => ({ stdout: ndjson(fenced), stderr: "", code: 0 });
    const result = await spawnAnalystWithExec(baseOptions, exec);
    expect(result.envelope.agent.agentKey).toBe("dr-value");
  });
});