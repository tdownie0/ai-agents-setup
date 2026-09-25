/**
 * Analyst dataset builder.
 *
 * Reads `daily_prices` via the drizzle client for the 49-symbol
 * `DEFAULT_UNIVERSE`, computes per-symbol analyst metrics using the SAME
 * conventions as `apps/backend/src/analysis/deterministic.ts` (returns in %,
 * annualized vol = stdev × √252, simple RSI-14), and writes a fully
 * self-contained `rounds/<roundId>/dataset.json` for the analyst subagents.
 *
 * The analyst NEVER touches the database — dataset.json is the only truth.
 * Numeric columns arrive from postgres-js as strings; they are parsed with
 * `Number()` BEFORE any arithmetic (the documented wire convention).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq, lte } from "drizzle-orm";
import { dailyPrices, db, instruments } from "@model_md/database";
import { DEFAULT_UNIVERSE } from "@model_md/market-data";

/** Enough bars for 252d return + SMA warm-up (200) + 52w range with headroom. */
const BAR_LIMIT = 300;
const TRADING_DAYS_PER_YEAR = 252;
const RSI_PERIOD = 14;
const VOL_WINDOW = 21;
const RANGE_WINDOW = 252;
const AVG_DOLLAR_VOLUME_WINDOW = 21;

export const DATASET_SCHEMA_VERSION = 1 as const;

interface Bar {
  tradeDate: string;
  px: number;
  close: number | null;
  volume: number | null;
}

export interface AnalystSymbolMetrics {
  symbol: string;
  name: string;
  sector: string;
  /** False when the symbol has no price bars as of the decision date. */
  hasData: boolean;
  latestClose: number | null;
  returns1d: number | null;
  returns5d: number | null;
  returns21d: number | null;
  returns63d: number | null;
  returns252d: number | null;
  /** Annualized volatility of the last 21 daily returns, in percent. */
  volatility21d: number | null;
  rsi14: number | null;
  sma50: number | null;
  sma200: number | null;
  sma50AboveSma200: boolean | null;
  high52w: number | null;
  low52w: number | null;
  /** Percent below the 52-week high: (close / high52w - 1) * 100. */
  offHigh52wPct: number | null;
  /** Average daily dollar volume (close × volume) over the last 21 bars. */
  avgDollarVolume: number | null;
}

export interface AnalystDataset {
  schemaVersion: number;
  roundId: string;
  /** The global latest trade_date across daily_prices — the decision date. */
  asOfTradeDate: string;
  generatedAt: string;
  universe: AnalystSymbolMetrics[];
}

export interface BuildDatasetResult {
  dataset: AnalystDataset;
  summary: {
    roundId: string;
    asOfTradeDate: string;
    symbols: number;
    symbolsWithData: number;
    datasetPath: string;
  };
}

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** `(P_t / P_{t-N} - 1) * 100`, or null when the window is not covered. */
function pctReturn(px: number[], periods: number): number | null {
  if (px.length <= periods) return null;
  const end = px[px.length - 1];
  const start = px[px.length - 1 - periods];
  if (start === 0) return null;
  return round((end / start - 1) * 100, 2);
}

/** Simple moving average of the last `window` closes, or null if too short. */
function sma(px: number[], window: number): number | null {
  if (px.length < window) return null;
  const slice = px.slice(-window);
  const sum = slice.reduce((acc, v) => acc + v, 0);
  return round(sum / window, 4);
}

/** Annualized stdev of the last 21 daily returns, in percent. */
function volatility21d(px: number[]): number | null {
  if (px.length < VOL_WINDOW + 1) return null;
  const rets: number[] = [];
  for (let i = px.length - VOL_WINDOW; i < px.length; i += 1) {
    rets.push(px[i] / px[i - 1] - 1);
  }
  const mean = rets.reduce((acc, v) => acc + v, 0) / rets.length;
  const variance = rets.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (rets.length - 1);
  return round(Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100, 2);
}

/** Simple RSI over the last 14 close-to-close changes, 0–100. */
function rsi14(px: number[]): number | null {
  if (px.length < RSI_PERIOD + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = px.length - RSI_PERIOD; i < px.length; i += 1) {
    const delta = px[i] - px[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  const avgGain = gains / RSI_PERIOD;
  const avgLoss = losses / RSI_PERIOD;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return round(100 - 100 / (1 + avgGain / avgLoss), 2);
}

/** Max/min of the last `window` closes, or null if too short. */
function range52w(px: number[]): { high: number; low: number } | null {
  if (px.length < 1) return null;
  const slice = px.slice(-RANGE_WINDOW);
  return {
    high: Math.max(...slice),
    low: Math.min(...slice),
  };
}

/** Average of close × volume over the last `window` bars, or null. */
function avgDollarVolume(bars: Bar[]): number | null {
  const slice = bars.slice(-AVG_DOLLAR_VOLUME_WINDOW);
  const values: number[] = [];
  for (const bar of slice) {
    if (bar.close === null || bar.volume === null) continue;
    const dollarVolume = Number(bar.close) * Number(bar.volume);
    if (Number.isFinite(dollarVolume)) values.push(dollarVolume);
  }
  if (values.length === 0) return null;
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
  return round(mean, 2);
}

/** Fetch the last ~300 bars for one symbol as of the decision date. */
async function fetchBars(symbol: string, asOfTradeDate: string): Promise<Bar[]> {
  const rows = await db
    .select({
      tradeDate: dailyPrices.tradeDate,
      close: dailyPrices.close,
      adjClose: dailyPrices.adjClose,
      volume: dailyPrices.volume,
    })
    .from(dailyPrices)
    .innerJoin(instruments, eq(dailyPrices.instrumentId, instruments.id))
    .where(and(eq(instruments.symbol, symbol), lte(dailyPrices.tradeDate, asOfTradeDate)))
    .orderBy(desc(dailyPrices.tradeDate))
    .limit(BAR_LIMIT);

  const bars: Bar[] = [];
  for (const row of rows) {
    const adjusted = row.adjClose ?? row.close;
    if (adjusted === null) continue;
    const px = Number(adjusted);
    if (!Number.isFinite(px)) continue;
    bars.push({
      tradeDate: row.tradeDate,
      px,
      close: row.close === null ? null : Number(row.close),
      volume: row.volume === null ? null : Number(row.volume),
    });
  }
  bars.reverse(); // oldest → newest for index-based windows
  return bars;
}

/** Compute the full metric bundle for one symbol from its bars. */
function computeMetrics(
  symbol: string,
  entry: (typeof DEFAULT_UNIVERSE)[number],
  bars: Bar[],
): AnalystSymbolMetrics {
  const base = {
    symbol,
    name: entry.name,
    sector: entry.sector,
  };

  if (bars.length === 0) {
    return {
      ...base,
      hasData: false,
      latestClose: null,
      returns1d: null,
      returns5d: null,
      returns21d: null,
      returns63d: null,
      returns252d: null,
      volatility21d: null,
      rsi14: null,
      sma50: null,
      sma200: null,
      sma50AboveSma200: null,
      high52w: null,
      low52w: null,
      offHigh52wPct: null,
      avgDollarVolume: null,
    };
  }

  const px = bars.map((b) => b.px);
  const last = bars[bars.length - 1];
  const sma50 = sma(px, 50);
  const sma200 = sma(px, 200);
  const range = range52w(px);
  const latestClose = last.close;
  const offHigh52wPct =
    latestClose !== null && range !== null && range.high > 0
      ? round((latestClose / range.high - 1) * 100, 2)
      : null;

  return {
    ...base,
    hasData: true,
    latestClose,
    returns1d: pctReturn(px, 1),
    returns5d: pctReturn(px, 5),
    returns21d: pctReturn(px, 21),
    returns63d: pctReturn(px, 63),
    returns252d: pctReturn(px, 252),
    volatility21d: volatility21d(px),
    rsi14: rsi14(px),
    sma50,
    sma200,
    sma50AboveSma200: sma50 !== null && sma200 !== null ? sma50 > sma200 : null,
    high52w: range?.high ?? null,
    low52w: range?.low ?? null,
    offHigh52wPct,
    avgDollarVolume: avgDollarVolume(bars),
  };
}

export interface BuildDatasetOptions {
  roundId: string;
  /** Directory that will contain `<roundId>/dataset.json`. Default "./rounds". */
  outDir?: string;
}

/**
 * Build the analyst dataset for a round: resolve the global latest
 * trade_date, compute per-symbol metrics for the full universe, persist
 * `rounds/<roundId>/dataset.json`, and return the summary.
 */
export async function buildDataset(opts: BuildDatasetOptions): Promise<BuildDatasetResult> {
  const roundId = opts.roundId.trim();
  if (roundId.length === 0) {
    throw new Error("roundId must be a non-empty string");
  }

  const [maxRow] = await db
    .select({ maxTradeDate: dailyPrices.tradeDate })
    .from(dailyPrices)
    .orderBy(desc(dailyPrices.tradeDate))
    .limit(1);

  if (!maxRow?.maxTradeDate) {
    throw new Error("No daily price data found — run the market-data ingestion pipeline first");
  }
  const asOfTradeDate = maxRow.maxTradeDate;

  const universe: AnalystSymbolMetrics[] = [];
  for (const entry of DEFAULT_UNIVERSE) {
    const bars = await fetchBars(entry.symbol, asOfTradeDate);
    universe.push(computeMetrics(entry.symbol, entry, bars));
  }

  const dataset: AnalystDataset = {
    schemaVersion: DATASET_SCHEMA_VERSION,
    roundId,
    asOfTradeDate,
    generatedAt: new Date().toISOString(),
    universe,
  };

  const outDir = opts.outDir ?? "./rounds";
  const datasetPath = join(outDir, roundId, "dataset.json");
  await mkdir(join(outDir, roundId), { recursive: true });
  await writeFile(datasetPath, JSON.stringify(dataset, null, 2), "utf8");

  const symbolsWithData = universe.filter((u) => u.hasData).length;

  return {
    dataset,
    summary: {
      roundId,
      asOfTradeDate,
      symbols: universe.length,
      symbolsWithData,
      datasetPath,
    },
  };
}

/**
 * The entry-fill context derived from a built dataset: every symbol's close
 * on the decision date (`asOfTradeDate`) — the entry price used at insert —
 * plus the universes envelope validation runs against.
 *
 * This is the SINGLE derivation of entry-fill semantics (documented in
 * contract.ts). The CLI, the backend rounds API, and the MCP server all
 * consume this instead of re-deriving prices from the dataset.
 */
export interface EntryContext {
  /** The dataset decision date — every position's `entryTradeDate`. */
  asOfTradeDate: string;
  /** symbol → close on the decision date (the `entryPrice`). */
  entryPrices: Readonly<Record<string, number>>;
  /** Symbols with at least one price bar as of the decision date. */
  symbolsWithPrice: ReadonlySet<string>;
  /** All valid symbols in the universe. */
  universe: readonly string[];
}

export function extractEntryContext(dataset: AnalystDataset): EntryContext {
  const entryPrices: Record<string, number> = {};
  const symbolsWithPrice = new Set<string>();
  for (const entry of dataset.universe) {
    if (entry.hasData && entry.latestClose !== null && Number.isFinite(entry.latestClose)) {
      entryPrices[entry.symbol] = entry.latestClose;
      symbolsWithPrice.add(entry.symbol);
    }
  }
  return {
    asOfTradeDate: dataset.asOfTradeDate,
    entryPrices,
    symbolsWithPrice,
    universe: dataset.universe.map((u) => u.symbol),
  };
}
