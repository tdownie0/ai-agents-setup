/**
 * Agent resolution: persona keys -> concrete subagent jobs, plus the
 * dataset path as seen from INSIDE the opencode_agent container.
 *
 * A job is one (persona, window) pair, so the roster is the full cross product:
 * every persona runs on every window, which is what makes strategy and cadence
 * independently comparable on the leaderboard.
 */

import {
  agentKeyFor,
  ANALYST_WINDOWS,
  getPersona,
  PERSONAS,
} from "@model_md/agent-orchestrator";
import type { AnalystWindow } from "@model_md/agent-orchestrator";

export interface AgentJob {
  personaKey: string;
  /** Composite key, `<personaKey>--<window>` — unique per job within a round. */
  agentKey: string;
  window: AnalystWindow;
}

export function resolveAgents(raw: unknown, windows?: readonly AnalystWindow[]): AgentJob[] {
  const selected = resolveWindows(windows);
  if (raw === undefined || raw === null) return allAgents(selected);
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed === "all") return allAgents(selected);
    return resolveList(
      trimmed
        .split(",")
        .map((part: string) => part.trim())
        .filter((part: string) => part.length > 0),
      selected,
    );
  }
  if (Array.isArray(raw)) {
    const keys = raw.map((part) => String(part).trim()).filter((part) => part.length > 0);
    return resolveList(keys, selected);
  }
  throw new Error(
    `agents must be "all", a comma-separated list, or an array of persona keys; got ${JSON.stringify(raw)}`,
  );
}

/** Normalize the `windows` tool input; undefined/blank/"all" means every window. */
export function parseWindows(raw: unknown): readonly AnalystWindow[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    return raw.map((part) => String(part).trim()).filter((part) => part.length > 0) as AnalystWindow[];
  }
  const trimmed = String(raw).trim();
  if (trimmed.length === 0 || trimmed === "all") return undefined;
  return trimmed
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0) as AnalystWindow[];
}

/** Default to every window; reject unknown names; keep canonical order. */
function resolveWindows(windows?: readonly AnalystWindow[]): readonly AnalystWindow[] {
  if (windows === undefined || windows.length === 0) return ANALYST_WINDOWS;
  const unknown = windows.filter((window) => !ANALYST_WINDOWS.includes(window));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown window(s) ${unknown.map((w) => JSON.stringify(w)).join(", ")}. Available: ${ANALYST_WINDOWS.join(", ")}`,
    );
  }
  return ANALYST_WINDOWS.filter((window) => windows.includes(window));
}

function allAgents(windows: readonly AnalystWindow[]): AgentJob[] {
  return PERSONAS.flatMap((persona) => windows.map((window) => jobFor(persona.key, window)));
}

function resolveList(keys: string[], windows: readonly AnalystWindow[]): AgentJob[] {
  return keys.flatMap((key) => {
    getPersona(key); // throws listing the available keys on unknown
    return windows.map((window) => jobFor(key, window));
  });
}

function jobFor(personaKey: string, window: AnalystWindow): AgentJob {
  return { personaKey, agentKey: agentKeyFor(personaKey, window), window };
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