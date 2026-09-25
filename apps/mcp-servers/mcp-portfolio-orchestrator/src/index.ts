/**
 * portfolio-orchestrator MCP server.
 *
 * The stateless control plane for analyst rounds:
 *   round_dataset_status — probe whether the feature backend has price data
 *   start_agent_round    — build the dataset, launch the round durably, spawn
 *                          analyst subagents inside opencode_agent (docker exec,
 *                          XDG-isolated), then insert each validated envelope
 *                          via the backend
 *   get_round_status     — read the durable round job + per-agent progress,
 *                          plus the inserted agent runs
 *
 * DATA SURFACE = the feature backend HTTP API ONLY (no database credentials in
 * this container). Subagents are spawned through the docker CLI against the
 * mcp-socket-proxy (DOCKER_HOST), mirroring ast-explorer.
 *
 * The docker MCP gateway runs this server as `docker run --rm -i` PER TOOL
 * CALL, so the process does not outlive a request. Two consequences shape this
 * file:
 *   1. Round progress is persisted through `RoundStore` (roundStore.ts), never
 *      held in a module-level Map — a fresh process must still see the round.
 *   2. `start_agent_round` AWAITS the agent pool instead of firing it off with
 *      `void runAgents(...)`. An unawaited pool died with its container
 *      mid-flight; awaiting keeps the work alive, and because every transition
 *      is persisted first, a dropped connection still leaves a recoverable,
 *      pollable round behind.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AGENT_KEYS, datasetPathFor, isValidRoundId, resolveAgents } from "./agents.js";
import { createBackendClient } from "./backendClient.js";
import { loadConfig } from "./config.js";
import type { OrchestratorConfig } from "./config.js";
import { createRoundStore, RoundAlreadyLaunchedError } from "./roundStore.js";
import type { RoundStateWire } from "./roundStore.js";
import { runAgents } from "./runner.js";
import type { DatasetWire } from "./runner.js";

const config = loadConfig(process.env);
const backend = createBackendClient(config.backendUrl);
const store = createRoundStore(backend);

const server = new McpServer({ name: "portfolio-orchestrator", version: "1.1.0" });

interface DatasetStatusWire {
  dataReady: boolean;
  symbols: number;
  symbolsWithData: number;
  coveragePct: number;
  asOfTradeDate: string | null;
  generatedAt: string;
}

function toolText(payload: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function toolError(err: unknown): { content: [{ type: "text"; text: string }] } {
  const message = err instanceof Error ? err.message : String(err);
  return toolText({ ok: false, error: message });
}

server.registerTool(
  "round_dataset_status",
  {
    description:
      "Probe whether the feature backend has enough daily price data to run an analyst round. Returns the universe size, how many symbols have bars, coverage %, and the latest trade date. No side effects.",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const status = await backend.get<DatasetStatusWire>("/api/portfolio/dataset-status");
      return toolText(status);
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "start_agent_round",
  {
    description:
      "Start a portfolio-simulation analyst round: build the dataset for roundId, record the round durably, spawn the selected analyst personas (docker exec opencode_agent with XDG-isolated state/cache), validate each decision envelope against the dataset, and insert the runs with entry fills via the feature backend. Blocks until every agent finishes (typically several minutes; the per-agent cap is AGENT_TIMEOUT_MS). Progress is persisted throughout, so get_round_status can be called from another process while this call is still running, and the round stays recoverable if this call's connection drops.",
    inputSchema: z.object({
      roundId: z
        .string()
        .min(1)
        .describe(
          'Simulation round id — also the dataset dir name. Letters, digits, dots, dashes, underscores; no slashes (path traversal is rejected).',
        ),
      agents: z
        .string()
        .optional()
        .describe(
          `Comma-separated persona keys, or "all". Default "all" (${AGENT_KEYS.join(", ")}).`,
        ),
      maxParallel: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max simultaneous analyst subagents. Default 3."),
      capital: z
        .number()
        .positive()
        .optional()
        .describe("Starting capital per analyst. Default 100000."),
      takeover: z
        .boolean()
        .optional()
        .describe(
          "Re-launch a round that already has a job row, resetting every agent to pending. Without this, launching an already-launched round is rejected with 409.",
        ),
    }),
  },
  async ({ roundId, agents, maxParallel, capital, takeover }) => {
    if (!isValidRoundId(roundId)) {
      return toolText({
        ok: false,
        roundId,
        error:
          "roundId must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/ (letters, digits, dots, dashes, underscores; no slashes or leading dots)",
      });
    }

    let jobs;
    try {
      jobs = resolveAgents(agents);
    } catch (err) {
      return toolText({
        ok: false,
        roundId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const cfg: OrchestratorConfig = {
      ...config,
      maxParallel: maxParallel ?? config.maxParallel,
      capital: capital ?? config.capital,
    };

    let dataset: DatasetWire;
    try {
      const status = await backend.get<DatasetStatusWire>("/api/portfolio/dataset-status");
      if (!status.dataReady) {
        return toolText({
          ok: false,
          roundId,
          error: `Dataset not ready: ${status.symbolsWithData}/${status.symbols} universe symbols have price data${
            status.asOfTradeDate !== null ? ` as of ${status.asOfTradeDate}` : ""
          }.`,
          hint: "Run market-data ingestion first (POST /api/market-data/ingest), then retry this tool.",
        });
      }
      await backend.post(`/api/portfolio/rounds/${encodeURIComponent(roundId)}/dataset`);
      dataset = await backend.get<DatasetWire>(
        `/api/portfolio/rounds/${encodeURIComponent(roundId)}/dataset`,
      );
    } catch (err) {
      return toolError(err);
    }

    const datasetPath = datasetPathFor(cfg.worktreeSlug, roundId);

    try {
      await store.startRound({
        roundId,
        agents: jobs.map((job) => ({ agentKey: job.agentKey, personaKey: job.personaKey })),
        maxParallel: cfg.maxParallel,
        capital: cfg.capital,
        asOfTradeDate: dataset.asOfTradeDate,
        datasetPath,
        takeover,
      });
    } catch (err) {
      if (err instanceof RoundAlreadyLaunchedError) {
        return toolText({
          ok: false,
          roundId,
          error: err.message,
          hint: "Poll get_round_status for progress, or re-launch with takeover=true to reset the round.",
          job: err.job,
        });
      }
      return toolError(err);
    }

    try {
      await runAgents(roundId, jobs, dataset, { store, backend, config: cfg });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await store.setRoundStatus(roundId, "error", message).catch(() => undefined);
      return toolText({ ok: false, roundId, error: message, stage: "runAgents" });
    }

    const state: RoundStateWire = await store.getRound(roundId);
    const inserted = state.agents.filter((agent) => agent.status === "inserted");
    return toolText({
      ok: true,
      roundId,
      status: state.job?.status ?? "error",
      asOfTradeDate: dataset.asOfTradeDate,
      datasetPath,
      agents: state.agents.map((agent) => ({
        agentKey: agent.agentKey,
        personaKey: agent.personaKey,
        status: agent.status,
        runId: agent.runId,
        picks: agent.picks,
        error: agent.error,
      })),
      insertedRuns: inserted.length,
      totalRuns: state.agents.length,
      maxParallel: cfg.maxParallel,
      capital: cfg.capital,
      note: "Round finished. Inserted runs are on the portfolio leaderboard; get_round_status returns the same durable state.",
    });
  },
);

server.registerTool(
  "get_round_status",
  {
    description:
      "Poll the progress of a round started with start_agent_round: the durable round job and per-agent progress (status, run ids, errors) read from the feature backend, plus the authoritative inserted-run list. Safe to call from any process at any time — state is not held in memory.",
    inputSchema: z.object({
      roundId: z.string().min(1).describe("The simulation round id passed to start_agent_round."),
    }),
  },
  async ({ roundId }) => {
    let state: RoundStateWire;
    try {
      state = await store.getRound(roundId);
    } catch (err) {
      return toolError(err);
    }

    let backendRuns = null;
    try {
      backendRuns = await backend.get(`/api/portfolio/rounds/${encodeURIComponent(roundId)}`);
    } catch {
      // No rows yet, or the backend is unreachable — the durable job still answers.
    }

    return toolText({
      roundId,
      job: state.job,
      agents: state.agents,
      backendRuns,
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
