/**
 * Build the book one stream carries into a round from W4's streams API.
 *
 * `streamBook.ts` deliberately reads no network, so the fetch lives here and
 * returns that same `StreamBook` shape. Two cases, and only two:
 *
 *   - 404 (no materialized book) — the stream has not been folded yet, so it
 *     genuinely holds nothing. This is the opening book, not a failure.
 *   - 200 — carry the open lots and the last recorded cash.
 *
 * A 200 whose summary is missing or whose cash is null / non-finite / negative
 * is corruption, not an empty book: throwing keeps the open lots from being
 * silently dropped (which would hand the analyst a book it does not hold).
 *
 * Marks come from the dataset the round is being decided against, not from the
 * API: `LotWire` carries no price, and the target weights the analyst returns
 * apply to this round's universe.
 */

import { BackendError } from "./backendClient.js";
import type { BackendClient } from "./backendClient.js";
import { streamBook } from "./streamBook.js";
import type { StreamBook } from "./streamBook.js";
import type { DecisionHolding, AnalystWindow } from "@model_md/agent-orchestrator";

export interface StreamDetailWire {
  stream: { cash: number | null; lastRoundId: string | null };
  lots: {
    symbol: string;
    shares: number;
    costBasis: number;
    openedTradeDate: string;
  }[];
}

export interface StreamRef {
  personaKey: string;
  window: AnalystWindow;
}

export interface BookLoaderDeps {
  backend: BackendClient;
  simulationId: string;
  /** Opening book for a stream with no folded round yet. */
  capital: number;
  latestCloseBySymbol: ReadonlyMap<string, number>;
  asOfTradeDate: string;
}

const MS_PER_DAY = 86_400_000;

function holdingDays(openedTradeDate: string, asOfTradeDate: string): number {
  const opened = Date.parse(openedTradeDate);
  const asOf = Date.parse(asOfTradeDate);
  if (Number.isNaN(opened) || Number.isNaN(asOf)) return 0;
  return Math.max(0, Math.round((asOf - opened) / MS_PER_DAY));
}

/**
 * A held symbol the dataset cannot price is marked at its own cost basis
 * rather than dropped: omitting it would hand the analyst a book missing a
 * position and silently liquidate the line. Break-even keeps it visible in
 * `heldSymbols` so the complete-book and sell-membership checks still govern it.
 */
function markPrice(symbol: string, costBasis: number, closes: ReadonlyMap<string, number>): number {
  const close = closes.get(symbol);
  return close !== undefined && Number.isFinite(close) && close > 0 ? close : costBasis;
}

export function createBookLoader(deps: BookLoaderDeps): (stream: StreamRef) => Promise<StreamBook> {
  const { backend, simulationId, capital, latestCloseBySymbol, asOfTradeDate } = deps;

  return async ({ personaKey, window }) => {
    const path =
      `/api/portfolio/simulations/${encodeURIComponent(simulationId)}` +
      `/streams/${encodeURIComponent(personaKey)}/${encodeURIComponent(window)}`;

    let detail: StreamDetailWire;
    try {
      detail = await backend.get<StreamDetailWire>(path);
    } catch (err) {
      if (err instanceof BackendError && err.status === 404) return streamBook([], capital);
      throw err;
    }

    const open = detail.lots.filter((lot) => lot.shares > 0);
    const holdings: DecisionHolding[] = open.map((lot) => {
      const lastPrice = markPrice(lot.symbol, lot.costBasis, latestCloseBySymbol);
      return {
        symbol: lot.symbol,
        shares: lot.shares,
        costBasis: lot.costBasis,
        lastPrice,
        marketValue: lot.shares * lastPrice,
        weight: 0,
        holdingDays: holdingDays(lot.openedTradeDate, asOfTradeDate),
        unrealizedPnlPct:
          lot.costBasis === 0 ? 0 : ((lastPrice - lot.costBasis) / lot.costBasis) * 100,
      };
    });

    const summary = detail.stream;
    if (
      summary === undefined ||
      summary.cash === null ||
      !Number.isFinite(summary.cash) ||
      summary.cash < 0
    ) {
      throw new Error(
        `bookLoader: stream ${personaKey}/${window} of simulation ${simulationId} ` +
          `reported invalid cash ${String(summary?.cash)}; refusing to drop its ` +
          `${holdings.length} open holding(s) as an empty book`,
      );
    }

    const book = streamBook(holdings, summary.cash, summary.lastRoundId);
    const total = book.portfolioValue;
    return {
      ...book,
      holdings: holdings.map((h) => ({ ...h, weight: total === 0 ? 0 : h.marketValue / total })),
    };
  };
}
