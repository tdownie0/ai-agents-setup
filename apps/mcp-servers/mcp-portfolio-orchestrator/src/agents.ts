/**
 * Agent resolution: persona keys -> concrete subagent jobs, plus the
 * dataset path as seen from INSIDE the opencode_agent container.
 */

import { getPersona, PERSONAS } from "@model_md/agent-orchestrator";

export interface AgentJob {
  personaKey: string;
  agentKey: string;
}

export function resolveAgents(raw: unknown): AgentJob[] {
  if (raw === undefined || raw === null) return allAgents();
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed === "all") return allAgents();
    return resolveList(
      trimmed
        .split(",")
        .map((part: string) => part.trim())
        .filter((part: string) => part.length > 0),
    );
  }
  if (Array.isArray(raw)) {
    const keys = raw.map((part) => String(part).trim()).filter((part) => part.length > 0);
    return resolveList(keys);
  }
  throw new Error(
    `agents must be "all", a comma-separated list, or an array of persona keys; got ${JSON.stringify(raw)}`,
  );
}

function allAgents(): AgentJob[] {
  return PERSONAS.map((persona) => ({ personaKey: persona.key, agentKey: persona.key }));
}

function resolveList(keys: string[]): AgentJob[] {
  return keys.map((key) => {
    getPersona(key); // throws listing the available keys on unknown
    return { personaKey: key, agentKey: key };
  });
}

export const AGENT_KEYS: readonly string[] = PERSONAS.map((persona) => persona.key);

/** Path the analyst subagent reads in the opencode_agent container. */
export function datasetPathFor(worktreeSlug: string, roundId: string): string {
  return `/app/worktrees/${worktreeSlug}/rounds/${roundId}/dataset.json`;
}

/** Mirror of the backend ROUND_ID_PATTERN — keeps traversal out of paths. */
export const ROUND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function isValidRoundId(value: string): boolean {
  return ROUND_ID_PATTERN.test(value);
}