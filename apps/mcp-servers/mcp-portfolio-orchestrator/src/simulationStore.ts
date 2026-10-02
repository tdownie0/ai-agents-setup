/**
 * Simulation store — the only place the orchestrator creates carryover scopes.
 *
 * `POST /simulations` answers 409 when the handle is taken. That is an error for
 * a REST client but not for a caller that just wants the handle to exist, so
 * this resolves 409 into the existing row and reports `alreadyExists`. Every
 * other failure propagates untouched, so the tool layer still renders the
 * actionable next step.
 */

import { BackendError, type BackendClient } from "./backendClient.js";

export interface SimulationWire {
  simId: string;
  label: string | null;
  initialCapital: number;
  createdAt: string;
  streamCount: number;
  lastRoundSeq: number | null;
}

export interface CreateSimulationInput {
  simId: string;
  label?: string;
  initialCapital?: number;
}

export interface CreateSimulationResult {
  alreadyExists: boolean;
  simulation: SimulationWire;
}

export interface SimulationStore {
  create(input: CreateSimulationInput): Promise<CreateSimulationResult>;
}

export function createSimulationStore(backend: BackendClient): SimulationStore {
  return {
    async create(input) {
      try {
        const simulation = await backend.post<SimulationWire>("/api/portfolio/simulations", {
          simId: input.simId,
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.initialCapital === undefined ? {} : { initialCapital: input.initialCapital }),
        });
        return { alreadyExists: false, simulation };
      } catch (err) {
        if (!(err instanceof BackendError) || err.status !== 409) throw err;

        // The 409 means the handle exists, so read it back. A list miss here
        // would mean the row was dropped between the two calls — rethrow rather
        // than report success for a simulation we cannot see.
        const all = await backend.get<SimulationWire[]>("/api/portfolio/simulations");
        const existing = Array.isArray(all) ? all.find((s) => s.simId === input.simId) : undefined;
        if (existing === undefined) throw err;
        return { alreadyExists: true, simulation: existing };
      }
    },
  };
}
