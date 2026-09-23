import type { InstrumentMeta, PriceBar } from "../types.js";

/**
 * Pluggable provider seam for daily OHLCV price data.
 *
 * PRIMARY — Yahoo Finance: free, no API key, `adjclose` is split- and
 * dividend-adjusted, history back to ~1970, mature `yahoo-finance2` client.
 * Unofficial and IP-ban prone, which is why `YahooSource` carries the
 * resilience knobs (concurrency, delay + jitter, backoff).
 *
 * BACKUP — Twelve Data: official, 800 req/day, `adjust=all`, no symbol cap.
 * Its adapter is deliberately NOT built until a real free API key exists
 * (untestable code otherwise). This interface is its contract.
 *
 * Config is injected via constructor/options — implementations NEVER read
 * `process.env` themselves.
 */
export interface PriceSource {
  /**
   * Fetch daily OHLCV bars for `symbol`, oldest-first, deduped by trade date.
   *
   * `years` selects the trailing window; when omitted the adapter fetches the
   * full retained series. Whole-history fetches are ONE call per symbol —
   * Yahoo's chart endpoint returns the full range in a single request, which
   * the ingest engine relies on for its idempotent full-window re-fetch
   * policy (upsert self-heals adjusted-close restatements).
   */
  fetchDailyBars(symbol: string, opts?: { years?: number }): Promise<PriceBar[]>;

  /**
   * Best-effort instrument metadata. Implementations MUST never throw: on any
   * failure return `{ symbol, name: null, sector: null, exchange: null,
   * assetClass: "equity" }` (or null) — enrichment must not fail an ingest.
   */
  fetchInstrumentMeta(symbol: string): Promise<InstrumentMeta | null>;
}