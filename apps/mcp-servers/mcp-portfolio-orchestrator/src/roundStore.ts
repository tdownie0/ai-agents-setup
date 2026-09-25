/**
 * Durable round-job state client.
 *
 * The docker MCP gateway runs this server as `docker run --rm -i` PER TOOL
 * CALL, so every call is a brand-new process. Round progress therefore cannot
 * live in a module-level Map: `start_agent_round` writes each transition to the
 * feature backend and `get_round_status` reads it back, so a round stays
 * observable across container restarts and a dropped client connection.
 *
 * The backend owns the launch guard (409 on a duplicate launch), so the
 * previously in-memory `registry.has()` check — dead code under this topology —
 * is replaced by a real cross-process check.
 */

import { createBackendClient } from "./backendClient.js";
import type { BackendClient } from "./backendClient.js";

export type RoundJobStatus = "launching" | "running" | "done" | "partial" | "error";
export type RoundAgentStatus = "pending" | "running" | "inserted" | "failed";

export interface RoundJobWire {
  roundId: string;
  status: RoundJobStatus;
  asOfTradeDate: string | null;
  datasetPath: string | null;
  maxParallel: number;
  capital: string;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
}

export interface RoundAgentProgressWire {
  agentKey: string;
  personaKey: string;
  status: RoundAgentStatus;
  runId: number | null;
  picks: number | null;
  attempts: number | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface RoundStateWire {
  roundId: string;
  job: RoundJobWire | null;
  agents: RoundAgentProgressWire[];
}

export class RoundAlreadyLaunchedError extends Error {
  readonly job: RoundJobWire | null;
  constructor(message: string, job: RoundJobWire | null) {
    super(message);
    this.name = "RoundAlreadyLaunchedError";
    this.job = job;
  }
}

export class RoundJobMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoundJobMissingError";
  }
}

const TERMINAL: readonly RoundJobStatus[] = ["done", "partial", "error"];

export function deriveFinalStatus(
  agents: readonly Pick<RoundAgentProgressWire, "status">[],
): RoundJobStatus {
  if (agents.length === 0) return "error";
  const inserted = agents.filter((a) => a.status === "inserted").length;
  const failed = agents.filter((a) => a.status === "failed").length;
  if (inserted === agents.length) return "done";
  if (failed === agents.length) return "error";
  return "partial";
}

export interface RoundStore {
  startRound(input: {
    roundId: string;
    agents: { agentKey: string; personaKey: string }[];
    maxParallel: number;
    capital: number;
    asOfTradeDate?: string;
    datasetPath?: string;
    takeover?: boolean;
  }): Promise<RoundStateWire>;
  getRound(roundId: string): Promise<RoundStateWire>;
  setRoundStatus(roundId: string, status: RoundJobStatus, error?: string): Promise<RoundJobWire>;
  setAgentProgress(
    roundId: string,
    agentKey: string,
    patch: {
      status: RoundAgentStatus;
      runId?: number;
      picks?: number;
      attempts?: number;
      error?: string;
      startedAt?: string;
      completedAt?: string;
    },
  ): Promise<RoundAgentProgressWire>;
}

export function createRoundStore(backend: BackendClient): RoundStore {
  const jobUrl = (roundId: string): string =>
    `/api/portfolio/rounds/${encodeURIComponent(roundId)}/job`;

  return {
    async startRound(input) {
      try {
        return await backend.post<RoundStateWire>(jobUrl(input.roundId), {
          agents: input.agents,
          maxParallel: input.maxParallel,
          capital: input.capital,
          ...(input.asOfTradeDate !== undefined ? { asOfTradeDate: input.asOfTradeDate } : {}),
          ...(input.datasetPath !== undefined ? { datasetPath: input.datasetPath } : {}),
          takeover: input.takeover === true,
        });
      } catch (err) {
        const status = (err as { status?: number }).status;
        const payload = (err as { payload?: unknown }).payload;
        if (status === 409 && typeof payload === "object" && payload !== null) {
          const job = (payload as { job?: RoundJobWire | null }).job ?? null;
          throw new RoundAlreadyLaunchedError(
            (payload as { error?: string }).error ?? `round "${input.roundId}" is already launched`,
            job,
          );
        }
        throw err;
      }
    },

    async getRound(roundId) {
      return backend.get<RoundStateWire>(jobUrl(roundId));
    },

    async setRoundStatus(roundId, status, error) {
      try {
        const res = await backend.patch<{ job: RoundJobWire }>(jobUrl(roundId), {
          status,
          ...(error !== undefined ? { error } : {}),
        });
        return res.job;
      } catch (err) {
        if ((err as { status?: number }).status === 404) {
          throw new RoundJobMissingError(
            `round "${roundId}" has no job row — cannot set status ${status}`,
          );
        }
        throw err;
      }
    },

    async setAgentProgress(roundId, agentKey, patch) {
      const res = await backend.put<{ agent: RoundAgentProgressWire }>(
        `${jobUrl(roundId)}/agents/${encodeURIComponent(agentKey)}`,
        patch,
      );
      return res.agent;
    },
  };
}

export { TERMINAL as TERMINAL_ROUND_JOB_STATUSES };
