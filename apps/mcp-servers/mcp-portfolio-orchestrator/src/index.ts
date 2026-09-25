/**
 * portfolio-orchestrator MCP server.
 *
 * The stateless control plane for analyst rounds:
 *   round_dataset_status — probe whether the feature backend has price data
 *   start_agent_round    — build the dataset, spawn analyst subagents inside
 *                          opencode_agent (docker exec, XDG-isolated), then
 *                          insert each validated envelope via the backend
 *   get_round_status     — poll the in-process job + the inserted agent runs
 *
 * Data surface = the feature backend HTTP API ONLY (no database credentials
 * in this container). Subagents are spawned through the docker CLI against
 * the mcp-socket-proxy (DOCKER_HOST), mirroring ast-explorer.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getPersona } from "@model_md/agent-orchestrator";
import { AGENT_KEYS, datasetPathFor, isValidRoundId, resolveAgents } from "./agents.js";
import type { AgentJob } from "./agents.js";
import { createBackendClient } from "./backendClient.js";
import { loadConfig } from "./config.js";
import type { OrchestratorConfig } from "./config.js";
import { JobRegistry, runPool } from "./jobs.js";
import { spawnAnalystViaDocker } from "./spawnViaDocker.js";

const config = loadConfig(process.env);
const backend = createBackendClient(config.backendUrl);
const registry = new JobRegistry();

const server = new McpServer({ name: "portfolio-orchestrator", version: "1.0.0" });

interface DatasetStatusWire {
  dataReady: boolean;
  symbols: number;
  symbolsWithData: number;
  coveragePct: number;
  asOfTradeDate: string | null;
  generatedAt: string;
}

interface DatasetWire {
  schemaVersion: number;
  roundId: string;
  asOfTradeDate: string;
  generatedAt: string;
  universe: Array<{ symbol: string; hasData: boolean; latestClose: number | null }>;
}

interface InsertRunWire {
  ok: boolean;
  agentRunId: number;
  positionsInserted: number;
}

function toolText(payload: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function toolError(err: unknown): { content: [{ type: "text"; text: string }] } {
  const message = err instanceof Error ? err.message : String(err);
  return toolText({ ok: false, error: message });
}

async function runAgents(
  roundId: string,
  jobs: AgentJob[],
  dataset: DatasetWire,
  cfg: OrchestratorConfig,
): Promise<void> {
  registry.setStatus(roundId, "running");
  const datasetPath = datasetPathFor(cfg.worktreeSlug, roundId);
  const universe = dataset.universe.map((entry) => entry.symbol);
  const symbolsWithPrice = new Set(
    dataset.universe
      .filter((entry) => entry.hasData && entry.latestClose !== null)
      .map((entry) => entry.symbol),
  );

  await runPool(jobs, cfg.maxParallel, async (job) => {
    registry.updateAgent(roundId, job.agentKey, {
      status: "running",
      startedAt: new Date().toISOString(),
    });
    const persona = getPersona(job.personaKey);
    try {
      const spawned = await spawnAnalystViaDocker({
        persona,
        agentKey: job.agentKey,
        roundId,
        datasetPath,
        asOfTradeDate: dataset.asOfTradeDate,
        initialCapital: cfg.capital,
        agentContainer: cfg.agentContainer,
        workdir: `/app/worktrees/${cfg.worktreeSlug}`,
        dockerHost: cfg.dockerHost,
        timeoutMs: cfg.timeoutMs,
        universe,
        symbolsWithPrice,
      });
      const inserted = await backend.post<InsertRunWire>("/api/portfolio/runs", {
        envelope: spawned.envelope,
      });
      registry.updateAgent(roundId, job.agentKey, {
        status: "inserted",
        runId: inserted.agentRunId,
        picks: spawned.envelope.picks.length,
        attempts: spawned.attempts,
        completedAt: new Date().toISOString(),
      });
    } catch (err) {
      registry.updateAgent(roundId, job.agentKey, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        completedAt: new Date().toISOString(),
      });
    }
  });

  registry.finalize(roundId);
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
      "Start a portfolio-simulation analyst round: build the dataset for roundId, spawn the selected analyst personas (docker exec opencode_agent with XDG-isolated state/cache), validate each decision envelope against the dataset, and insert the runs with entry fills via the feature backend. Fire-and-forget: returns immediately after launch; poll get_round_status for progress, then check the portfolio leaderboard.",
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
    }),
  },
  async ({ roundId, agents, maxParallel, capital }) => {
    if (!isValidRoundId(roundId)) {
      return toolText({
        ok: false,
        roundId,
        error:
          "roundId must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/ (letters, digits, dots, dashes, underscores; no slashes or leading dots)",
      });
    }
    let jobs: AgentJob[];
    try {
      jobs = resolveAgents(agents);
    } catch (err) {
      return toolText({
        ok: false,
        roundId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (registry.has(roundId)) {
      return toolText({
        ok: false,
        roundId,
        error: `Round "${roundId}" is already tracked in this server — poll get_round_status for its progress.`,
      });
    }
    registry.start(roundId);
    try {
      const status = await backend.get<DatasetStatusWire>("/api/portfolio/dataset-status");
      if (!status.dataReady) {
        registry.setStatus(roundId, "error", "dataset not ready");
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
      const dataset = await backend.get<DatasetWire>(
        `/api/portfolio/rounds/${encodeURIComponent(roundId)}/dataset`,
      );
      const datasetPath = datasetPathFor(config.worktreeSlug, roundId);
      registry.setJobInfo(roundId, {
        asOfTradeDate: dataset.asOfTradeDate,
        datasetPath,
      });
      registry.setAgents(roundId, jobs);
      void runAgents(roundId, jobs, dataset, {
        ...config,
        maxParallel: maxParallel ?? config.maxParallel,
        capital: capital ?? config.capital,
      }).catch((err) => {
        registry.setStatus(roundId, "error", err instanceof Error ? err.message : String(err));
      });
      return toolText({
        ok: true,
        roundId,
        status: "launching",
        asOfTradeDate: dataset.asOfTradeDate,
        datasetPath,
        agents: jobs.map((job) => job.agentKey),
        maxParallel: maxParallel ?? config.maxParallel,
        capital: capital ?? config.capital,
        note: "Fire-and-forget. Poll get_round_status for per-agent progress; inserted runs appear in the portfolio leaderboard.",
      });
    } catch (err) {
      registry.setStatus(roundId, "error", err instanceof Error ? err.message : String(err));
      return toolError(err);
    }
  },
);

server.registerTool(
  "get_round_status",
  {
    description:
      "Poll the progress of a round started with start_agent_round: the in-process job state (per-agent status, run ids, errors) plus the authoritative inserted-run list read back from the feature backend.",
    inputSchema: z.object({
      roundId: z.string().min(1).describe("The simulation round id passed to start_agent_round."),
    }),
  },
  async ({ roundId }) => {
    const job = registry.get(roundId) ?? null;
    let backendRuns = null;
    try {
      backendRuns = await backend.get(
        `/api/portfolio/rounds/${encodeURIComponent(roundId)}`,
      );
    } catch {
      // No rows yet (or backend unreachable) — the in-process job still answers.
    }
    return toolText({ roundId, job, backendRuns });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);