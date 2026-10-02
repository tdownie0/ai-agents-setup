/**
 * portfolio-orchestrator MCP server.
 *
 * The stateless control plane for analyst rounds:
 *   round_dataset_status — probe whether the feature backend has price data
 *   create_simulation    — create the simulation a chain of rounds folds into
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
import { ANALYST_WINDOWS } from "@model_md/agent-orchestrator";
import {
  AGENT_KEYS,
  datasetPathFor,
  isValidRoundId,
  parseWindows,
  resolveAgents,
} from "./agents.js";
import { createBackendClient, BackendError, isRecord } from "./backendClient.js";
import { createBookLoader } from "./bookLoader.js";
import { loadConfig } from "./config.js";
import type { OrchestratorConfig } from "./config.js";
import { createRoundStore, RoundAlreadyLaunchedError } from "./roundStore.js";
import type { RoundStateWire } from "./roundStore.js";
import { createSimulationStore } from "./simulationStore.js";
import { runAgents } from "./runner.js";
import type { DatasetWire, RoundBooking } from "./runner.js";

const config = loadConfig(process.env);
const backend = createBackendClient(config.backendUrl);
const store = createRoundStore(backend);
const simulations = createSimulationStore(backend);

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

/**
 * Next step for each carryover rerun code. The backend already supplies a `hint`,
 * but these say what to CHANGE, which is the question a caller actually has when a
 * launch is refused.
 */
const RERUN_ACTIONS: Readonly<Record<string, string>> = {
  SAME_TRADE_DATE:
    "That trade date already has a round still running. Wait for it via get_round_status, or re-launch with takeover=true to reset that round.",
  ROUND_ALREADY_COMPLETE:
    "That trade date's round is already finished. Use replace=true to deliberately discard its decisions and re-decide, or launch a later trade date.",
  STALE_TRADE_DATE:
    "There is no newer price data than the stream's last mark, so a round would decide on a date it has already passed. Ingest market data for a later date, then relaunch.",
  OUT_OF_SEQUENCE:
    "The requested date is at or before the stream's last applied round_seq, and the fold is forward-only. Launch a later date, or use replace=true to re-decide that date deliberately.",
  UNKNOWN_SIMULATION: "Create the simulation before launching a round into it.",
};

function toolError(err: unknown): { content: [{ type: "text"; text: string }] } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof BackendError && err.status === 409 && isRecord(err.payload)) {
    const code = typeof err.payload.code === "string" ? err.payload.code : null;
    const action = code !== null ? RERUN_ACTIONS[code] : undefined;
    if (code !== null) {
      return toolText({
        ok: false,
        code,
        error: typeof err.payload.error === "string" ? err.payload.error : message,
        hint: typeof err.payload.hint === "string" ? err.payload.hint : null,
        nextStep: action ?? null,
        detail: err.payload.detail ?? null,
      });
    }
  }
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
  "create_simulation",
  {
    description:
      "Create the carryover simulation that a chain of rounds folds into. Every chained round (start_agent_round with simulationId) requires the simulation to exist first, and a simId is permanent once rounds are booked under it. Idempotent: if the handle already exists it returns that simulation with alreadyExists=true instead of failing.",
    inputSchema: z.object({
      simId: z
        .string()
        .describe(
          "Permanent handle, must match /^sim-[a-z0-9][a-z0-9-]{0,46}$/, e.g. sim-baseline",
        ),
      label: z.string().optional().describe("Human label for the chain"),
      initialCapital: z
        .number()
        .positive()
        .optional()
        .describe("Chain basis capital, fixed for the life of the chain (default 100000)"),
    }),
  },
  async ({ simId, label, initialCapital }) => {
    try {
      const result = await simulations.create({ simId, label, initialCapital });
      return toolText({ ok: true, ...result });
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "start_agent_round",
  {
    description:
      "Start a portfolio-simulation analyst round: build the dataset for roundId, record the round durably, spawn the selected analyst personas on every selected rebalance window (docker exec opencode_agent with XDG-isolated state/cache), validate each decision envelope against the dataset, and insert the runs with entry fills via the feature backend. The default roster is the full persona x window cross product (6 personas x 3 windows = 18 runs), so each run's agentKey is `<personaKey>--<window>`. Blocks until every agent finishes (typically several minutes per wave; the per-agent cap is AGENT_TIMEOUT_MS). Progress is persisted throughout, so get_round_status can be called from another process while this call is still running, and the round stays recoverable if this call's connection drops.",
    inputSchema: z.object({
      roundId: z
        .string()
        .min(1)
        .describe(
          "Simulation round id — also the dataset dir name. Letters, digits, dots, dashes, underscores; no slashes (path traversal is rejected).",
        ),
      agents: z
        .string()
        .optional()
        .describe(
          `Comma-separated persona keys, or "all". Default "all" (${AGENT_KEYS.join(", ")}). Every selected persona runs on every selected window.`,
        ),
      windows: z
        .string()
        .optional()
        .describe(
          `Comma-separated rebalance windows, or "all". Default "all" (${ANALYST_WINDOWS.join(", ")}).`,
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
      replace: z
        .boolean()
        .optional()
        .describe(
          "Intentionally re-decide a terminal round on the same trade date (discard its decisions) while keeping the chain. Requires takeover semantics in the backend for the same-day rerun; use only when explicitly requested.",
        ),
      simulationId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Carryover simulation id this round folds into. Without it the round is standalone (roundSeq 1, no chain). With it each persona x window stream carries its own book forward, so this must be a simulation created via POST /api/portfolio/simulations.",
        ),
    }),
  },
  async ({ roundId, agents, windows, maxParallel, capital, takeover, replace, simulationId }) => {
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
      jobs = resolveAgents(agents, parseWindows(windows));
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

    let booking: RoundBooking;
    try {
      const launched = await store.startRound({
        roundId,
        agents: jobs.map((job) => ({ agentKey: job.agentKey, personaKey: job.personaKey })),
        maxParallel: cfg.maxParallel,
        capital: cfg.capital,
        asOfTradeDate: dataset.asOfTradeDate,
        datasetPath,
        takeover,
        replace,
        ...(simulationId !== undefined ? { simulationId } : {}),
      });
      // Read the admitted position back off the response rather than assuming
      // it: the launch gate may have resolved a different seq than requested.
      const job = launched.job;
      if (job === null) {
        return toolText({
          ok: false,
          roundId,
          error: "launch response carried no job row, so the admitted round_seq is unknown",
          hint: "Refusing to guess a chain position. Inspect the round with get_round_status.",
        });
      }
      booking = { simulationId: job.simulationId, roundSeq: job.roundSeq };
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
      const latestCloseBySymbol = new Map(
        dataset.universe.flatMap((entry) =>
          entry.hasData && entry.latestClose !== null
            ? [[entry.symbol, entry.latestClose] as const]
            : [],
        ),
      );
      const bookFor =
        simulationId === undefined
          ? undefined
          : createBookLoader({
              backend,
              simulationId,
              capital: cfg.capital,
              latestCloseBySymbol,
              asOfTradeDate: dataset.asOfTradeDate,
            });
      await runAgents(roundId, jobs, dataset, { store, backend, config: cfg, bookFor, booking });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await store.setRoundStatus(roundId, "error", message).catch(() => undefined);
      return toolText({ ok: false, roundId, error: message, stage: "runAgents" });
    }

    const state: RoundStateWire = await store.getRound(roundId);
    const inserted = state.agents.filter((agent) => agent.status === "inserted");
    const windowByAgentKey = new Map(jobs.map((job) => [job.agentKey, job.window]));
    return toolText({
      ok: true,
      roundId,
      status: state.job?.status ?? "error",
      asOfTradeDate: dataset.asOfTradeDate,
      datasetPath,
      agents: state.agents.map((agent) => ({
        agentKey: agent.agentKey,
        personaKey: agent.personaKey,
        window: windowByAgentKey.get(agent.agentKey) ?? null,
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
