/**
 * Core domain types for the market-data package.
 *
 * These are the wire-format contracts consumed by the ingestion engine
 * (beads task `.3`) and persisted into the `instruments` / `daily_prices`
 * tables. They are deliberately provider-agnostic: `PriceSource` adapters
 * (Yahoo now, Twelve Data later) map their own shapes onto these.
 */

/**
 * One daily OHLCV bar for a single instrument.
 *
 * `tradeDate` is the US equity-session calendar date (America/New_York close
 * date), formatted YYYY-MM-DD. It is NEVER derived from UTC — a bar whose
 * timestamp is 2026-09-22 20:30 UTC (16:30 America/New_York) must carry
 * tradeDate "2026-09-22". The database schema comment on
 * `daily_prices.trade_date` mirrors this convention.
 */
export interface PriceBar {
  /** Uppercase ticker symbol, e.g. "AAPL". */
  symbol: string;
  /** US-session calendar date in America/New_York, YYYY-MM-DD. */
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Split- and dividend-adjusted close (Yahoo `adjclose`). */
  adjClose: number;
  volume: number;
}

/**
 * Best-effort instrument metadata. `name`/`sector`/`exchange` are nullable
 * because enrichment must never fail an ingest — a provider that cannot
 * resolve metadata returns the null-object instead of throwing.
 */
export interface InstrumentMeta {
  /** Uppercase ticker symbol, e.g. "AAPL". */
  symbol: string;
  name: string | null;
  sector: string | null;
  exchange: string | null;
  assetClass: "equity";
}

/**
 * Resilience knobs shared by all `PriceSource` implementations.
 *
 * Defaults are applied by each adapter's constructor when a field is omitted:
 * - `concurrency`: 3 — Yahoo throttles datacenter IPs aggressively; never
 *   hammer. Three in-flight requests is the safe ceiling.
 * - `delayMs`: 2000 — minimum gap between requests; each adapter adds random
 *   jitter on top (up to `delayMs`) so bursts never align.
 * - `maxRetries`: 5 — attempts per request before giving up. 429 / network
 *   errors are retried with exponential backoff + jitter.
 */
export interface PriceSourceOptions {
  /** Max concurrent in-flight requests. Default 3. */
  concurrency?: number;
  /** Minimum delay between requests, ms. Default 2000 (+ jitter). */
  delayMs?: number;
  /** Max attempts per request before throwing. Default 5. */
  maxRetries?: number;
  /** Optional HTTP User-Agent override. */
  userAgent?: string;
}