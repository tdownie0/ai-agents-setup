/**
 * Unit tests for the portfolio-orchestrator MCP server.
 *
 * `src/index.ts` is intentionally NOT imported (it connects the stdio
 * transport at module scope and requires runtime env). Everything tested
 * here is a parameter-driven module: config, agent resolution, the bounded
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
import { datasetPathFor, isValidRoundId, parseWindows, resolveAgents, } from "../src/agents.js";
import { createBackendClient } from "../src/backendClient.js";
import { loadConfig, parsePositiveInt, ConfigError } from "../src/config.js";
import { runPool } from "../src/jobs.js";
import { createRoundStore, deriveFinalStatus, RoundAlreadyLaunchedError, RoundJobMissingError, } from "../src/roundStore.js";
import { runAgents } from "../src/runner.js";
import { buildAgentStateDirs, buildDockerExecArgs, spawnAnalystWithExec, } from "../src/spawnViaDocker.js";
const fakeResponse = (status, payload) => new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
});
const VALID_ENVELOPE = {
    schemaVersion: 1,
    roundId: "w1",
    agent: {
        agentKey: "dr-value--monthly",
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
const UNIVERSE = ["AAPL", "MSFT", "KO", "PG", "JNJ", "TSLA", "XOM"];
const SYMBOLS_WITH_PRICE = new Set(["AAPL", "MSFT", "KO", "PG", "JNJ", "TSLA", "XOM"]);
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
        expect(() => loadConfig({ WORKTREE_SLUG: "slug" })).toThrow("PORTFOLIO_BACKEND_URL is required");
    });
    it("requires WORKTREE_SLUG", () => {
        expect(() => loadConfig({ PORTFOLIO_BACKEND_URL: "http://x:3000" })).toThrow("WORKTREE_SLUG is required");
    });
    it("applies defaults and trims the backend URL trailing slash", () => {
        const config = loadConfig(base);
        expect(config.backendUrl).toBe("http://feat-portfolio-sim-backend:3000");
        expect(config.agentContainer).toBe("opencode_agent");
        expect(config.maxParallel).toBe(6);
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
        const jobs = resolveAgents("dr-value, dr-momentum");
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
        const jobs = resolveAgents(["dr-macro", "dr-technical"]);
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
        expect(() => resolveAgents("dr-value", ["yearly"])).toThrow(/Unknown window/);
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
        expect(datasetPathFor("model_md-worktree-feat-portfolio-sim", "w1")).toBe("/app/worktrees/model_md-worktree-feat-portfolio-sim/rounds/w1/dataset.json");
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
});
describe("createRoundStore", () => {
    const base = "http://backend:3000";
    const makeClient = (handler) => createBackendClient(base, (async (url, init) => handler(String(url), init)));
    it("POSTs the launch payload to the round job endpoint", async () => {
        const calls = [];
        const store = createRoundStore(makeClient((url, init) => {
            calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
            return fakeResponse(201, { roundId: "w1", job: null, agents: [] });
        }));
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
        });
    });
    it("maps a 409 launch rejection to RoundAlreadyLaunchedError with the job", async () => {
        const store = createRoundStore(makeClient(() => fakeResponse(409, { error: "round \"w1\" was already launched", job: { status: "running" } })));
        await expect(store.startRound({
            roundId: "w1",
            agents: [{ agentKey: "dr-value", personaKey: "dr-value" }],
            maxParallel: 3,
            capital: 100000,
        })).rejects.toBeInstanceOf(RoundAlreadyLaunchedError);
    });
    it("PUTs agent progress to the per-agent endpoint", async () => {
        const seen = [];
        const store = createRoundStore(makeClient((url, init) => {
            seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
            return fakeResponse(200, { agent: { agentKey: "dr-value", status: "inserted" } });
        }));
        await store.setAgentProgress("w1", "dr-value", { status: "inserted", runId: 7, picks: 5 });
        expect(seen[0]?.url).toBe("http://backend:3000/api/portfolio/rounds/w1/job/agents/dr-value");
        expect(seen[0]?.body).toMatchObject({ status: "inserted", runId: 7, picks: 5 });
    });
    it("maps a 404 status transition to RoundJobMissingError", async () => {
        const store = createRoundStore(makeClient(() => fakeResponse(404, { error: "no job" })));
        await expect(store.setRoundStatus("nope", "running")).rejects.toBeInstanceOf(RoundJobMissingError);
    });
});
describe("runAgents (durable progress)", () => {
    const config = {
        backendUrl: "http://backend:3000",
        worktreeSlug: "model_md-worktree-feat-portfolio-sim",
        agentContainer: "opencode_agent",
        maxParallel: 2,
        capital: 100000,
        timeoutMs: 1000,
    };
    const dataset = {
        schemaVersion: 1,
        roundId: "w1",
        asOfTradeDate: "2026-09-25",
        generatedAt: "2026-09-25T18:30:00.000Z",
        universe: [
            { symbol: "AAPL", hasData: true, latestClose: 100 },
            { symbol: "MSFT", hasData: true, latestClose: 200 },
        ],
    };
    const makeStore = () => {
        const statuses = new Map();
        const roundStatuses = [];
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
                        status: status,
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
            async setRoundStatus(_roundId, status) {
                roundStatuses.push(status);
                return {};
            },
            async setAgentProgress(_roundId, agentKey, patch) {
                statuses.set(agentKey, patch.status);
                return {};
            },
        };
        return { store, statuses, roundStatuses };
    };
    const jobs = [
        { personaKey: "dr-value", agentKey: "dr-value", window: "weekly" },
        { personaKey: "dr-momentum", agentKey: "dr-momentum", window: "weekly" },
    ];
    const envelope = (agentKey) => ({
        schemaVersion: 1,
        roundId: "w1",
        asOfTradeDate: "2026-09-25",
        agent: { agentKey, persona: agentKey, strategy: "value", window: "weekly" },
        picks: [{ symbol: "AAPL", targetWeight: 1 }],
    });
    it("persists running, inserted, and a final done round status", async () => {
        const { store, statuses, roundStatuses } = makeStore();
        const backend = {
            async post() {
                return { ok: true, agentRunId: 11, positionsInserted: 1 };
            },
        };
        await runAgents("w1", jobs, dataset, {
            store: store,
            backend,
            config,
            spawn: (async ({ agentKey }) => ({
                envelope: envelope(agentKey),
                rawOutput: "{}",
                attempts: 1,
            })),
        });
        expect(statuses.get("dr-value")).toBe("inserted");
        expect(statuses.get("dr-momentum")).toBe("inserted");
        expect(roundStatuses).toEqual(["running", "done"]);
    });
    it("records a failed agent and finalizes the round as partial", async () => {
        const { store, statuses, roundStatuses } = makeStore();
        const backend = { async post() { return { ok: true, agentRunId: 12, positionsInserted: 1 }; } };
        await runAgents("w1", jobs, dataset, {
            store: store,
            backend,
            config,
            spawn: (async ({ agentKey }) => {
                if (agentKey === "dr-momentum")
                    throw new Error("analyst timed out");
                return { envelope: envelope(agentKey), rawOutput: "{}", attempts: 2 };
            }),
        });
        expect(statuses.get("dr-value")).toBe("inserted");
        expect(statuses.get("dr-momentum")).toBe("failed");
        expect(roundStatuses).toEqual(["running", "partial"]);
    });
    it("does not abort the round when a progress write fails", async () => {
        const statuses = new Map();
        const roundStatuses = [];
        const store = {
            async getRound() {
                return {
                    roundId: "w1",
                    job: null,
                    agents: [...statuses.entries()].map(([agentKey, status]) => ({
                        agentKey,
                        personaKey: agentKey,
                        status: status,
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
            async setRoundStatus(_r, status) {
                roundStatuses.push(status);
                return {};
            },
            async setAgentProgress(_r, agentKey, patch) {
                if (patch.status === "running")
                    throw new Error("progress write failed");
                statuses.set(agentKey, patch.status);
                return {};
            },
        };
        const backend = { async post() { return { ok: true, agentRunId: 13, positionsInserted: 1 }; } };
        await runAgents("w1", jobs, dataset, {
            store: store,
            backend,
            config,
            spawn: (async ({ agentKey }) => ({
                envelope: envelope(agentKey),
                rawOutput: "{}",
                attempts: 1,
            })),
        });
        expect(statuses.get("dr-value")).toBe("inserted");
        expect(roundStatuses).toEqual(["running", "done"]);
    });
});
describe("runPool", () => {
    it("runs every item with the concurrency capped at the limit", async () => {
        const items = Array.from({ length: 10 }, (_, i) => i);
        const visited = [];
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
        await expect(runPool([], 3, async () => { })).resolves.toBeUndefined();
    });
});
describe("createBackendClient", () => {
    function fakeResponse(status, payload) {
        return {
            ok: status >= 200 && status < 300,
            status,
            statusText: status === 200 ? "OK" : "Error",
            text: async () => JSON.stringify(payload),
        };
    }
    it("GETs typed JSON", async () => {
        const fetchImpl = vi.fn(async () => fakeResponse(200, { dataReady: true }));
        const client = createBackendClient("http://backend:3000", fetchImpl);
        const body = await client.get("/api/portfolio/dataset-status");
        expect(body.dataReady).toBe(true);
        expect(fetchImpl).toHaveBeenCalledWith("http://backend:3000/api/portfolio/dataset-status", expect.objectContaining({ method: "GET" }));
    });
    it("POSTs JSON with a content-type header", async () => {
        const fetchImpl = vi.fn(async (_url, _init) => fakeResponse(201, { ok: true, agentRunId: 7 }));
        const client = createBackendClient("http://backend:3000", fetchImpl);
        const body = await client.post("/api/portfolio/runs", {
            envelope: { schemaVersion: 1 },
        });
        expect(body.agentRunId).toBe(7);
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe("http://backend:3000/api/portfolio/runs");
        expect(init.method).toBe("POST");
        expect(init.headers["content-type"]).toBe("application/json");
    });
    it("throws BackendError with the backend's error message on non-2xx", async () => {
        const fetchImpl = vi.fn(async () => fakeResponse(409, { error: "Agent run already exists for round \"w1\"" }));
        const client = createBackendClient("http://backend:3000", fetchImpl);
        await expect(client.post("/api/portfolio/runs", { envelope: {} })).rejects.toMatchObject({
            status: 409,
            payload: { error: 'Agent run already exists for round "w1"' },
        });
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
    function ndjson(text) {
        return `{"type":"text","part":{"text":${JSON.stringify(text)}}}\n`;
    }
    function fakePersona() {
        return {
            key: "dr-value",
            displayName: "Dr. Value",
            strategy: "deep-value",
            phdSystemPrompt: "You are a value analyst.",
        };
    }
    const baseOptions = {
        persona: fakePersona(),
        window: "monthly",
        agentKey: "dr-value--monthly",
        roundId: "w1",
        datasetPath: "/app/worktrees/slug/rounds/w1/dataset.json",
        asOfTradeDate: "2026-09-22",
        initialCapital: 100000,
        agentContainer: "opencode_agent",
        workdir: "/app/worktrees/slug",
        universe: [...UNIVERSE],
        symbolsWithPrice: SYMBOLS_WITH_PRICE,
    };
    const okExec = async (args) => ({
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
        const calls = [];
        const exec = async (args) => {
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
        const calls = [];
        const exec = async (args) => {
            calls.push([...args]);
            if (calls.length === 1)
                return { stdout: "", stderr: "container not running", code: 125 };
            return { stdout: ndjson(JSON.stringify(VALID_ENVELOPE)), stderr: "", code: 0 };
        };
        const result = await spawnAnalystWithExec(baseOptions, exec);
        expect(result.attempts).toBe(2);
        expect(calls).toHaveLength(2);
    });
    it("fails after two attempts when the terminal state is non-zero", async () => {
        const exec = async () => ({ stdout: "", stderr: "boom", code: 125 });
        await expect(spawnAnalystWithExec(baseOptions, exec)).rejects.toThrow(/docker exec exited with code 125/);
    });
    it("strips markdown fences before parsing", async () => {
        const fenced = "```json\n" + JSON.stringify(VALID_ENVELOPE) + "\n```";
        const exec = async () => ({ stdout: ndjson(fenced), stderr: "", code: 0 });
        const result = await spawnAnalystWithExec(baseOptions, exec);
        expect(result.envelope.agent.agentKey).toBe("dr-value--monthly");
    });
});
//# sourceMappingURL=orchestrator.test.js.map