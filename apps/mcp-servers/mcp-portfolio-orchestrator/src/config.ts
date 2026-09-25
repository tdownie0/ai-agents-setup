/**
 * Environment configuration for the portfolio-orchestrator MCP server.
 *
 * Only this module reads process.env. Everything else receives config as
 * parameters. Env vars (local-mcp.yaml template):
 *   PORTFOLIO_BACKEND_URL  required — the feature backend base URL
 *   WORKTREE_SLUG          required — worktree dir name inside the
 *                          opencode_agent container (/app/worktrees/<slug>)
 *   AGENT_CONTAINER        default "opencode_agent"
 *   MAX_PARALLEL           default 3
 *   INITIAL_CAPITAL        default 100000
 *   AGENT_TIMEOUT_MS       default 10 minutes
 *   DOCKER_HOST            optional — passthrough for `docker exec`
 */

import { DEFAULT_AGENT_TIMEOUT_MS } from "@model_md/agent-orchestrator";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function parsePositiveInt(raw: unknown, field: string, fallback: number): number {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim().length === 0)) {
    return fallback;
  }
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${field} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export const DEFAULT_MAX_PARALLEL = 3;
export const DEFAULT_INITIAL_CAPITAL = 100000;
export const DEFAULT_AGENT_CONTAINER = "opencode_agent";

export interface OrchestratorConfig {
  backendUrl: string;
  worktreeSlug: string;
  agentContainer: string;
  maxParallel: number;
  capital: number;
  timeoutMs: number;
  dockerHost?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): OrchestratorConfig {
  const backendUrl = (env.PORTFOLIO_BACKEND_URL ?? "").trim();
  if (backendUrl.length === 0) {
    throw new ConfigError(
      "PORTFOLIO_BACKEND_URL is required (e.g. http://feat-portfolio-sim-backend:3000)",
    );
  }
  const worktreeSlug = (env.WORKTREE_SLUG ?? "").trim();
  if (worktreeSlug.length === 0) {
    throw new ConfigError("WORKTREE_SLUG is required (e.g. model_md-worktree-feat-portfolio-sim)");
  }
  const dockerHost = (env.DOCKER_HOST ?? "").trim();
  return {
    backendUrl: backendUrl.replace(/\/+$/, ""),
    worktreeSlug,
    agentContainer: (env.AGENT_CONTAINER ?? DEFAULT_AGENT_CONTAINER).trim(),
    maxParallel: parsePositiveInt(env.MAX_PARALLEL, "MAX_PARALLEL", DEFAULT_MAX_PARALLEL),
    capital: parsePositiveInt(env.INITIAL_CAPITAL, "INITIAL_CAPITAL", DEFAULT_INITIAL_CAPITAL),
    timeoutMs: parsePositiveInt(env.AGENT_TIMEOUT_MS, "AGENT_TIMEOUT_MS", DEFAULT_AGENT_TIMEOUT_MS),
    dockerHost: dockerHost.length > 0 ? dockerHost : undefined,
  };
}