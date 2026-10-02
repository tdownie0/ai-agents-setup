/**
 * Rendering of the analyst's carried book for the decision prompt.
 *
 * Three personas (dr-value, dr-momentum, dr-compounder) state rules about
 * positions the model was never shown — "if a held name's sma50AboveSma200
 * flips to false, it is out", "you sell only on thesis breakage". Those rules
 * are unenforceable against a book the model cannot see, so the book is now
 * rendered into the prompt. This is the fix: show the book, do not invent new
 * verbs for it.
 *
 * Two renderings, deliberately different shapes:
 * - `renderHoldingsSection` — the full line-by-line table appended once by
 *   `buildAnalystPrompt`.
 * - `renderHoldingsDigest` — a one-line summary for the `{{holdings}}` token
 *   inside a persona mandate, so a rule and the book it refers to sit together.
 *
 * All numbers are formatted with fixed decimals and no locale separators, so
 * the rendering is byte-stable across machines and locales.
 */

import type { DecisionHolding } from "./contract.js";

/** Weight as a percentage with 2dp — the unit personas reason in. */
function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

/** Signed money with 2dp, so a loss is visually distinguishable from a gain. */
function money(value: number): string {
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}

/** Share counts carry 6dp because lots are sized to 6dp. */
function shares(value: number): string {
  return value.toFixed(6);
}

/** Prices are 4dp in the position table, so the prompt matches that precision. */
function price(value: number): string {
  return `$${value.toFixed(4)}`;
}

function signedPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

/** The open lines, widest-first, so the biggest position reads first. */
function byWeightDescending(holdings: readonly DecisionHolding[]): DecisionHolding[] {
  return [...holdings].sort((a, b) => b.weight - a.weight);
}

/**
 * The HOLDINGS section appended to every analyst prompt. The empty case is
 * stated explicitly rather than omitted: on a stream's first round the book is
 * genuinely empty, and the model still owes a complete book back.
 */
export function renderHoldingsSection(
  holdings: readonly DecisionHolding[],
  portfolioValue: number,
): string {
  const header = [
    "HOLDINGS (your carried book, marked at this decision date)",
    "symbol | shares | avg cost/share | last price | market value | current weight | days held | unrealized P&L",
  ];

  if (holdings.length === 0) {
    return [
      ...header,
      "(empty — this stream holds no positions. This is its first decision round, so your `positions` array is the complete opening book: you hold nothing, therefore you omit nothing.)",
      `Total portfolio value ${money(portfolioValue)}, all of it cash.`,
    ].join("\n");
  }

  const rows = byWeightDescending(holdings).map(
    (h) =>
      `${h.symbol} | ${shares(h.shares)} | ${price(h.costBasis)} | ${price(h.lastPrice)} | ` +
      `${money(h.marketValue)} | ${pct(h.weight)} | ${h.holdingDays}d | ${signedPct(h.unrealizedPnlPct)}`,
  );
  const holdingsValue = holdings.reduce((total, h) => total + h.marketValue, 0);
  const cash = Math.max(0, portfolioValue - holdingsValue);

  return [
    ...header,
    ...rows,
    `Total: ${holdings.length} open position(s), ${money(holdingsValue)} invested (${pct(holdingsValue / portfolioValue)}), ${money(cash)} cash (${pct(cash / portfolioValue)}).`,
  ].join("\n");
}

/**
 * One-line digest for the `{{holdings}}` token in a persona mandate. Kept short
 * on purpose: the token carries the book next to a rule, and a table there
 * would swamp the prose it is explaining.
 */
export function renderHoldingsDigest(
  holdings: readonly DecisionHolding[],
  portfolioValue: number,
): string {
  if (holdings.length === 0) {
    return `Your current book: no open positions, ${money(portfolioValue)} all cash. The full book is in the HOLDINGS section.`;
  }

  const lines = byWeightDescending(holdings)
    .map(
      (h) => `${h.symbol} ${pct(h.weight)} (${h.holdingDays}d, ${signedPct(h.unrealizedPnlPct)})`,
    )
    .join(", ");
  const holdingsValue = holdings.reduce((total, h) => total + h.marketValue, 0);

  return `Your current book: ${holdings.length} open position(s), ${pct(holdingsValue / portfolioValue)} invested, ${pct(1 - holdingsValue / portfolioValue)} cash — ${lines}. Full detail is in the HOLDINGS section.`;
}
