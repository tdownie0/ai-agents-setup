/**
 * Decision envelope contract — the shared handoff between the analyst
 * orchestrator (this package, wave C) and the backend valuation engine
 * (wave B).
 *
 * The envelope is the exact JSON shape every analyst subagent must emit and
 * every consumer (backend valuation, leaderboard) must read. Validation here
 * is the single gate: anything that passes `validateEnvelope` is guaranteed
 * to be insertable and valuatable.
 *
 * Entry-fill semantics (consumed by the backend):
 * - `entryTradeDate` = the dataset `asOfTradeDate` (the latest trade_date
 *   present in daily_prices at decision time).
 * - `entryPrice` = that symbol's close on `asOfTradeDate`.
 * - `shares` = (initialCapital × targetWeight) / entryPrice, 6dp.
 *
 * Rebalance policy contract: equal-weight rebalance at 1/5/21-trading-day
 * boundaries (daily/weekly/monthly windows respectively).
 */

export const DECISION_SCHEMA_VERSION = 1 as const;

export const DECISION_WINDOWS = ["daily", "weekly", "monthly"] as const;
export type DecisionWindow = (typeof DECISION_WINDOWS)[number];

export const MIN_PICKS = 5;
export const MAX_PICKS = 10;
export const WEIGHT_SUM_MIN = 0.99;
export const WEIGHT_SUM_MAX = 1.01;

/**
 * Lowercase letters, digits, hyphens, and `#` (the replica separator used by
 * the CLI's `--replicate-of` mode: `<base>#rep<i>`). 3–120 chars.
 */
const AGENT_KEY_PATTERN = /^[a-z0-9-#]{3,120}$/;

export interface DecisionPick {
  symbol: string;
  weight: number;
  thesis: string;
}

export interface DecisionAgent {
  agentKey: string;
  persona: string;
  strategy: string;
  window: DecisionWindow;
  initialCapital: number;
  replicateOf?: string;
}

export interface DecisionEnvelope {
  schemaVersion: number;
  roundId: string;
  agent: DecisionAgent;
  rationale: string;
  picks: DecisionPick[];
}

/** Options describing the universe the envelope is validated against. */
export interface ValidateEnvelopeOptions {
  /** All valid symbols in the universe (e.g. the 49 DEFAULT_UNIVERSE tickers). */
  universe: readonly string[];
  /** Symbols that have at least one price bar as of the decision date. */
  symbolsWithPrice: ReadonlySet<string>;
  /**
   * The window the round assigned to this agent. When set, an envelope whose
   * `agent.window` differs is rejected: membership in DECISION_WINDOWS is not
   * enough, because a persona run on several windows would otherwise be free to
   * report whichever cadence it likes and the round would no longer be a clean
   * strategy x window cross product.
   */
  expectedWindow?: DecisionWindow;
}

/** Typed validation failure — `issues` carries one message per violation. */
export class DecisionValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Decision envelope validation failed:\n- ${issues.join("\n- ")}`);
    this.name = "DecisionValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate an unknown payload as a `DecisionEnvelope`.
 *
 * Throws `DecisionValidationError` (with one message per issue) on any
 * violation. Returns the typed envelope on success.
 */
export function validateEnvelope(value: unknown, opts: ValidateEnvelopeOptions): DecisionEnvelope {
  const issues: string[] = [];

  if (!isRecord(value)) {
    throw new DecisionValidationError(["envelope must be a JSON object"]);
  }

  if (value.schemaVersion !== DECISION_SCHEMA_VERSION) {
    issues.push(
      `schemaVersion must be ${DECISION_SCHEMA_VERSION}, got ${JSON.stringify(value.schemaVersion)}`,
    );
  }

  if (!isNonEmptyString(value.roundId)) {
    issues.push("roundId must be a non-empty string");
  }

  if (!isRecord(value.agent)) {
    issues.push("agent must be an object");
  } else {
    const agent = value.agent;
    if (!isNonEmptyString(agent.agentKey)) {
      issues.push("agent.agentKey must be a non-empty string");
    } else if (!AGENT_KEY_PATTERN.test(agent.agentKey)) {
      issues.push(
        `agent.agentKey "${agent.agentKey}" must match /^[a-z0-9-#]{3,120}$/ (lowercase letters, digits, hyphens, or "#" for replicas; 3-120 chars)`,
      );
    }
    if (!isNonEmptyString(agent.persona)) {
      issues.push("agent.persona must be a non-empty string");
    }
    if (!isNonEmptyString(agent.strategy)) {
      issues.push("agent.strategy must be a non-empty string");
    }
    const windowIsValid = DECISION_WINDOWS.includes(agent.window as DecisionWindow);
    if (!windowIsValid) {
      issues.push(
        `agent.window must be one of ${DECISION_WINDOWS.join("|")}, got ${JSON.stringify(agent.window)}`,
      );
    } else if (opts.expectedWindow !== undefined && agent.window !== opts.expectedWindow) {
      issues.push(
        `agent.window must be "${opts.expectedWindow}" (the window assigned to this run), got ${JSON.stringify(agent.window)}`,
      );
    }
    if (!isFiniteNumber(agent.initialCapital) || agent.initialCapital <= 0) {
      issues.push("agent.initialCapital must be a finite number > 0");
    }
    if (
      agent.replicateOf !== undefined &&
      agent.replicateOf !== null &&
      !isNonEmptyString(agent.replicateOf)
    ) {
      issues.push("agent.replicateOf, when present, must be a non-empty string");
    }
  }

  if (!isNonEmptyString(value.rationale)) {
    issues.push("rationale must be a non-empty string");
  }

  if (!Array.isArray(value.picks)) {
    issues.push("picks must be an array");
  } else {
    if (value.picks.length < MIN_PICKS) {
      issues.push(`picks must contain at least ${MIN_PICKS} symbols, got ${value.picks.length}`);
    }
    if (value.picks.length > MAX_PICKS) {
      issues.push(`picks must contain at most ${MAX_PICKS} symbols, got ${value.picks.length}`);
    }

    const universeSet = new Set(opts.universe);
    const seenSymbols = new Set<string>();
    let weightSum = 0;

    value.picks.forEach((pick, index) => {
      const label = `picks[${index}]`;
      if (!isRecord(pick)) {
        issues.push(`${label} must be an object`);
        return;
      }
      if (!isNonEmptyString(pick.symbol)) {
        issues.push(`${label}.symbol must be a non-empty string`);
        return;
      }
      const symbol = pick.symbol.toUpperCase();
      if (!universeSet.has(symbol)) {
        issues.push(
          `${label}.symbol "${pick.symbol}" is not in the universe (${opts.universe.length} symbols)`,
        );
      } else if (!opts.symbolsWithPrice.has(symbol)) {
        issues.push(
          `${label}.symbol "${pick.symbol}" is in the universe but has no price data as of the decision date`,
        );
      }
      if (seenSymbols.has(symbol)) {
        issues.push(`${label}.symbol "${pick.symbol}" is duplicated in picks`);
      }
      seenSymbols.add(symbol);

      if (!isFiniteNumber(pick.weight)) {
        issues.push(`${label}.weight must be a finite number, got ${JSON.stringify(pick.weight)}`);
      } else if (pick.weight <= 0 || pick.weight > 1) {
        issues.push(`${label}.weight must satisfy 0 < weight <= 1, got ${pick.weight}`);
      } else {
        weightSum += pick.weight;
      }

      if (!isNonEmptyString(pick.thesis)) {
        issues.push(`${label}.thesis must be a non-empty string`);
      }
    });

    if (value.picks.length > 0) {
      // Round to 6dp so binary floating-point drift (e.g. 1.0100000000000001)
      // does not reject a sum that is exactly on the tolerance boundary.
      const roundedSum = Math.round(weightSum * 1e6) / 1e6;
      if (roundedSum < WEIGHT_SUM_MIN || roundedSum > WEIGHT_SUM_MAX) {
        issues.push(
          `sum of pick weights must be within [${WEIGHT_SUM_MIN}, ${WEIGHT_SUM_MAX}], got ${roundedSum.toFixed(6)}`,
        );
      }
    }
  }

  if (issues.length > 0) {
    throw new DecisionValidationError(issues);
  }

  return value as unknown as DecisionEnvelope;
}
