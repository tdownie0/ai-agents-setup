import YahooFinance from "yahoo-finance2";
import type { ChartResultArray, ChartResultArrayQuote } from "yahoo-finance2/modules/chart";
import type { InstrumentMeta, PriceBar, PriceSourceOptions } from "../types.js";
import type { PriceSource } from "./priceSource.js";

/**
 * Yahoo Finance adapter for the `PriceSource` seam.
 *
 * Resilience (researched hazards): Yahoo IP-bans on 429 and throttles
 * datacenter IPs, so concurrency is capped at 3 in-flight and every request
 * after the first waits `delayMs` + random jitter. 429 / 5xx / network errors
 * retry with exponential backoff + jitter up to `maxRetries`, then throw a
 * typed `PriceSourceError`. `fetchInstrumentMeta` is best-effort, never throws.
 * Config is injected via the constructor — this module NEVER reads `process.env`.
 */

/** Default trailing window (years) applied when `fetchDailyBars` omits `from`. */
const DEFAULT_HISTORY_YEARS = 30;

/** Formats a Date as YYYY-MM-DD in the America/New_York session calendar. */
const TRADE_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * US-session calendar date (America/New_York) as YYYY-MM-DD — the pipeline's
 * `trade_date` convention. `en-CA` yields the ISO layout; the timeZone pins
 * the date so a bar printed late in the UTC day lands on the right session.
 */
export function formatTradeDate(date: Date): string {
  return TRADE_DATE_FORMATTER.format(date);
}

/**
 * Map one yahoo-finance2 chart quote to a `PriceBar`. The ONLY function that
 * touches the provider quote shape — a runtime mismatch with v3 is fixed here.
 *
 * ASSUMPTIONS (unverifiable without network — validate at runtime):
 * - `chart()` returns quotes with `date: Date`, nullable numeric OHLCV, and
 *   `adjclose` (lowercase) as the split+dividend adjusted close.
 * - When `adjclose` is null/absent, raw `close` is used (no adjustments apply).
 */
export function mapChartQuoteToPriceBar(
  symbol: string,
  quote: ChartResultArrayQuote,
): PriceBar | null {
  const { date, open, high, low, close, adjclose, volume } = quote;
  if (open == null || high == null || low == null || close == null || volume == null) {
    return null; // incomplete bar — skip
  }
  return {
    symbol,
    tradeDate: formatTradeDate(date),
    open,
    high,
    low,
    close,
    adjClose: adjclose ?? close,
    volume,
  };
}

interface HttpErrorLike {
  status?: unknown;
  code?: unknown;
}

function isHttpErrorLike(err: unknown): err is HttpErrorLike {
  return typeof err === "object" && err !== null && ("status" in err || "code" in err);
}

function extractStatus(err: unknown): number | undefined {
  if (!isHttpErrorLike(err)) return undefined;
  if (typeof err.status === "number") return err.status;
  if (typeof err.code === "number") return err.code;
  return undefined;
}

function isFailedValidationError(err: unknown): boolean {
  return err instanceof Error && err.name === "FailedYahooValidationError";
}

function isRetryableError(err: unknown, status: number | undefined): boolean {
  if (isFailedValidationError(err)) {
    return false; // malformed response — retrying cannot fix it
  }
  if (status === undefined) {
    return true; // network-level failure (DNS, socket, timeout)
  }
  return status === 429 || status >= 500;
}

/** Typed provider failure carrying symbol + HTTP status for ingest attribution. */
export class PriceSourceError extends Error {
  readonly symbol: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    opts: { symbol: string; status?: number; retryable: boolean; cause?: unknown },
  ) {
    super(message, { cause: opts.cause });
    this.name = "PriceSourceError";
    this.symbol = opts.symbol;
    this.status = opts.status;
    this.retryable = opts.retryable;
  }
}

/** Promise-based semaphore: at most `max` tasks in flight. */
class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next(); // hand the freed slot to the next waiter
    } else {
      this.active -= 1;
    }
  }
}

/** Constructor options for `YahooSource` (extends the shared knobs). */
export interface YahooSourceOptions extends PriceSourceOptions {
  /** Default history window in years used when `fetchDailyBars` omits `from`. */
  defaultYears?: number;
}

/** Yahoo Finance `PriceSource` — `chart` for bars, `quote` for metadata. */
export class YahooSource implements PriceSource {
  private readonly client: InstanceType<typeof YahooFinance>;
  private readonly limiter: ConcurrencyLimiter;
  private readonly delayMs: number;
  private readonly maxRetries: number;
  private readonly defaultYears: number;
  private requestCount = 0;

  constructor(options: YahooSourceOptions = {}) {
    this.client = new YahooFinance(
      options.userAgent === undefined
        ? undefined
        : { fetchOptions: { headers: { "User-Agent": options.userAgent } } },
    );
    this.limiter = new ConcurrencyLimiter(options.concurrency ?? 3);
    this.delayMs = options.delayMs ?? 2_000;
    this.maxRetries = options.maxRetries ?? 5;
    this.defaultYears = options.defaultYears ?? DEFAULT_HISTORY_YEARS;
  }

  async fetchDailyBars(symbol: string, opts?: { from?: Date; to?: Date }): Promise<PriceBar[]> {
    const normalized = normalizeSymbol(symbol);
    const period2 = opts?.to ?? new Date();
    const period1 = opts?.from ?? new Date(period2.getTime());
    if (opts?.from === undefined) {
      period1.setFullYear(period1.getFullYear() - this.defaultYears);
    }

    const result: ChartResultArray = await this.limiter.run(() =>
      this.withRetry(normalized, async () => {
        await this.throttle();
        return this.client.chart(normalized, {
          period1,
          period2,
          interval: "1d",
          return: "array",
        });
      }),
    );

    const bars: PriceBar[] = [];
    const seenDates = new Set<string>();
    for (const quote of result.quotes) {
      const bar = mapChartQuoteToPriceBar(normalized, quote);
      if (bar === null) continue;
      if (seenDates.has(bar.tradeDate)) continue; // dedupe by trade date
      seenDates.add(bar.tradeDate);
      bars.push(bar);
    }
    bars.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
    return bars;
  }

  async fetchInstrumentMeta(symbol: string): Promise<InstrumentMeta | null> {
    const normalized = normalizeSymbol(symbol);
    try {
      const result = await this.limiter.run(() =>
        this.withRetry(normalized, async () => {
          await this.throttle();
          return this.client.quote(normalized);
        }),
      );
      return {
        symbol: normalized,
        name: result.longName ?? result.shortName ?? null,
        // `sector` is not part of the v3 Quote type (index-signature `any`);
        // Yahoo's quote endpoint usually omits it — the universe config seeds
        // sector, so null here is expected and fine.
        sector: typeof result.sector === "string" ? result.sector : null,
        exchange: result.fullExchangeName ?? result.exchange ?? null,
        assetClass: "equity",
      };
    } catch {
      // Best-effort enrichment: metadata must never fail an ingest. Return the
      // null-object so callers can upsert an instrument row with empty metadata.
      return { symbol: normalized, name: null, sector: null, exchange: null, assetClass: "equity" };
    }
  }

  /** Minimum delay + random jitter between requests (never before the first). */
  private async throttle(): Promise<void> {
    if (this.requestCount > 0) {
      const jitter = Math.floor(Math.random() * this.delayMs);
      await sleep(this.delayMs + jitter);
    }
    this.requestCount += 1;
  }

  /** Exponential backoff with jitter, capped at 30s. */
  private backoffDelay(attempt: number): number {
    const baseMs = 1_000;
    const capMs = 30_000;
    const exponential = Math.min(capMs, baseMs * 2 ** (attempt - 1));
    return Math.floor(exponential * (0.5 + Math.random() * 0.5));
  }

  /** Retry retryable failures (429 / 5xx / network) with backoff + jitter up
   * to `maxRetries`, then throw a typed `PriceSourceError` with symbol+status. */
  private async withRetry<T>(symbol: string, task: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await task();
      } catch (err) {
        attempt += 1;
        const status = extractStatus(err);
        const retryable = isRetryableError(err, status);
        if (!retryable || attempt >= this.maxRetries) {
          throw new PriceSourceError(
            `yahoo-finance2 request failed for ${symbol} after ${attempt} attempt(s)`,
            { symbol, status, retryable, cause: err },
          );
        }
        await sleep(this.backoffDelay(attempt));
      }
    }
  }
}
