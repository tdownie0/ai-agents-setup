/**
 * Rule bodies for the decision-envelope contract (see `contract.ts` for the
 * public types and the entrypoint). Split out only to keep each file within
 * reviewable size: `contract.ts` owns WHAT the contract is, this module owns
 * HOW each rule is enforced.
 *
 * Rules implemented here:
 * - 2. `positions` is an array with no duplicate symbols.
 * - 3. Buys (`targetWeight > 0`): count in [MIN_PICKS, MAX_PICKS]; `0 <= w <=
 *    TARGET_WEIGHT_MAX`; symbol in `universe` AND in `symbolsWithPrice`.
 * - 4. Sells (`targetWeight === 0`): unlimited count; symbol in `heldSymbols`;
 *    NOT required in `universe` or `symbolsWithPrice`.
 * - 5. No symbol twice — "sell then rebuy" is a single positive `targetWeight`.
 * - 6. `round(Σ targetWeight over buys, 6dp)` within the weight-sum tolerance.
 * - 7. `heldSymbols \ {symbols in envelope}` is empty; else name every omission.
 * - 9. `AGENT_KEY_PATTERN`, window pinning, `replicateOf`, and the per-decision
 *    stream state (`portfolioValue`, `cash`, `holdingsValue`, `priorRoundId`,
 *    `roundSeq`).
 */

import {
  DECISION_WINDOWS,
  MAX_PICKS,
  MIN_PICKS,
  TARGET_WEIGHT_MAX,
  WEIGHT_SUM_MAX,
  WEIGHT_SUM_MIN,
  type DecisionWindow,
  type ValidateEnvelopeOptions,
} from "./contract.js";

/**
 * Lowercase letters, digits, hyphens, and `#` (the replica separator used by
 * the CLI's `--replicate-of` mode: `<base>#rep<i>`). 3–120 chars.
 */
const AGENT_KEY_PATTERN = /^[a-z0-9-#]{3,120}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value > 0;
}

/** Rule 9: agent identity, window pinning, and the per-decision stream state. */
export function agentIssues(
  agent: Record<string, unknown>,
  opts: ValidateEnvelopeOptions,
): string[] {
  const issues: string[] = [];

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

  if (!isFiniteNumber(agent.portfolioValue) || agent.portfolioValue <= 0) {
    issues.push("agent.portfolioValue must be a finite number > 0");
  }
  if (!isFiniteNumber(agent.cash) || agent.cash < 0) {
    issues.push("agent.cash must be a finite number >= 0");
  }
  if (!isFiniteNumber(agent.holdingsValue) || agent.holdingsValue < 0) {
    issues.push("agent.holdingsValue must be a finite number >= 0");
  }
  if (agent.priorRoundId !== null && !isNonEmptyString(agent.priorRoundId)) {
    issues.push(
      `agent.priorRoundId must be null (first round of the stream) or a non-empty string, got ${JSON.stringify(agent.priorRoundId)}`,
    );
  }
  if (!isPositiveInteger(agent.roundSeq)) {
    issues.push(`agent.roundSeq must be a positive integer, got ${JSON.stringify(agent.roundSeq)}`);
  }
  if (
    agent.replicateOf !== undefined &&
    agent.replicateOf !== null &&
    !isNonEmptyString(agent.replicateOf)
  ) {
    issues.push("agent.replicateOf, when present, must be a non-empty string");
  }

  return issues;
}

/** Rules 2-7: buys, sells, duplicates, the buy-weight sum, and omissions. */
export function positionIssues(positions: unknown[], opts: ValidateEnvelopeOptions): string[] {
  const issues: string[] = [];
  const universeSet = new Set(opts.universe);
  const seenSymbols = new Set<string>();
  const inEnvelope = new Set<string>();
  let buyCount = 0;
  let weightSum = 0;

  positions.forEach((position, index) => {
    const label = `positions[${index}]`;
    if (!isRecord(position)) {
      issues.push(`${label} must be an object`);
      return;
    }
    if (!isNonEmptyString(position.symbol)) {
      issues.push(`${label}.symbol must be a non-empty string`);
      return;
    }
    const symbol = position.symbol.toUpperCase();
    inEnvelope.add(symbol);
    if (seenSymbols.has(symbol)) {
      issues.push(
        `${label}.symbol "${position.symbol}" is duplicated in positions — a symbol appears once, so "sell then rebuy" is a single positive targetWeight`,
      );
    }
    seenSymbols.add(symbol);

    if (!isNonEmptyString(position.thesis)) {
      issues.push(`${label}.thesis must be a non-empty string`);
    }

    if (!isFiniteNumber(position.targetWeight)) {
      issues.push(
        `${label}.targetWeight must be a finite number, got ${JSON.stringify(position.targetWeight)}`,
      );
      return;
    }
    const weight = position.targetWeight;
    if (weight < 0 || weight > TARGET_WEIGHT_MAX) {
      issues.push(
        `${label}.targetWeight must satisfy 0 <= targetWeight <= ${TARGET_WEIGHT_MAX}, got ${weight}`,
      );
      return;
    }

    if (weight === 0) {
      // Rule 4 — liquidation. Exempt from universe and price membership so a
      // delisted or unpriced name can still be exited, but never a silent exit.
      if (!opts.heldSymbols.has(symbol)) {
        issues.push(
          `${label}.symbol "${position.symbol}" has targetWeight 0 (liquidate entirely) but is not in heldSymbols — you may only exit a symbol the stream currently holds`,
        );
      }
      return;
    }

    // Rule 3 — a buy or a keep: must be priced and in the universe.
    buyCount += 1;
    weightSum += weight;
    if (!universeSet.has(symbol)) {
      issues.push(
        `${label}.symbol "${position.symbol}" is not in the universe (${opts.universe.length} symbols)`,
      );
    } else if (!opts.symbolsWithPrice.has(symbol)) {
      issues.push(
        `${label}.symbol "${position.symbol}" is in the universe but has no price data as of the decision date`,
      );
    }
  });

  // Rule 3 — the buy count. Sells are unlimited and never counted here.
  if (buyCount < MIN_PICKS) {
    issues.push(
      `positions must contain at least ${MIN_PICKS} symbols with targetWeight > 0, got ${buyCount}`,
    );
  }
  if (buyCount > MAX_PICKS) {
    issues.push(
      `positions must contain at most ${MAX_PICKS} symbols with targetWeight > 0, got ${buyCount}`,
    );
  }

  // Rule 6 — sum over BUYS only; zero-weight lines contribute nothing. Rounded
  // to 6dp so binary drift (1.0100000000000001) does not reject a sum sitting
  // exactly on the tolerance boundary.
  if (positions.length > 0) {
    const roundedSum = Math.round(weightSum * 1e6) / 1e6;
    if (roundedSum < WEIGHT_SUM_MIN || roundedSum > WEIGHT_SUM_MAX) {
      issues.push(
        `sum of buy targetWeights must be within [${WEIGHT_SUM_MIN}, ${WEIGHT_SUM_MAX}], got ${roundedSum.toFixed(6)}`,
      );
    }
  }

  // Rule 7 — the envelope is a COMPLETE target book. A held symbol with no line
  // is an error naming it: the fold would otherwise read silence as an exit, and
  // a model that forgets one name dumps it.
  const omitted = [...opts.heldSymbols].filter((symbol) => !inEnvelope.has(symbol)).sort();
  if (omitted.length > 0) {
    issues.push(
      `held symbols omitted from the envelope — it must be a COMPLETE target book, so give every holding a line (targetWeight 0 to exit): ${omitted.join(", ")}`,
    );
  }

  return issues;
}
