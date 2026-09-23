import { DeterministicProvider } from "./deterministic.js";
import type { DecisionProvider } from "./types.js";

/**
 * Decision-provider registry (phase 1). Only the deterministic provider is
 * shipped; "jev" is a reserved, deliberately-unimplemented name so callers
 * can flag it in config without ever constructing a client.
 *
 * Callers wire env here via `createProvider({ decisionProvider: env.DECISION_PROVIDER })`
 * — this module never reads `process.env` itself.
 */

/** Providers that can be constructed today. */
export const DECISION_PROVIDER_NAMES = ["deterministic"] as const;

export type DecisionProviderName = (typeof DECISION_PROVIDER_NAMES)[number];

export function createProvider(opts: { decisionProvider?: string }): DecisionProvider {
  const name = opts.decisionProvider ?? "deterministic";
  switch (name) {
    case "deterministic":
      return new DeterministicProvider();
    case "jev":
      throw new Error(
        "Jev provider not implemented in phase 1 — requires JEV_API_KEY; see FEATURE_README",
      );
    default:
      throw new Error(
        `Unknown decision provider "${name}". Supported: ${DECISION_PROVIDER_NAMES.join(", ")} (reserved: jev)`,
      );
  }
}
