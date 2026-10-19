# Market Data Pipeline Feature

## Overview

The Market Data Pipeline ingests free daily OHLCV price history for a fixed universe of 49 US large-cap stocks, stores it in Postgres, and exposes it through typed Hono RPC routes. On top of the price data sits a provider-agnostic decision layer that turns recent bars into a metric bundle and a buy/hold/sell signal.

**Status**: COMPLETED (phase 1)
**Date**: 2026-09-23
**Feature Branch**: `feat-market-data-pipeline`
**Epic**: Market Data Pipeline (daily OHLCV ingestion + decision layer)
**Beads task**: vll.7 (feature documentation)

Phase 1 deliberately excludes paying for Jev; the decision layer is deterministic by default.

---

## 1. Summary

Two halves make up the feature:

1. **Ingestion**: a `packages/market-data` package that fetches daily OHLCV bars from Yahoo Finance (free, no API key, no fees), normalizes them to a provider-agnostic `PriceBar` shape, and upserts them into three Postgres tables. A CLI runs backfills (default 30 years) and incremental updates (default 5 years). A `POST /api/market-data/ingest` route exposes the same engine over HTTP, guarded by Supabase JWT auth and a Postgres advisory lock so overlapping runs are safe.
2. **Decision layer**: an `apps/backend/src/analysis` module that reads recent bars, computes a `MetricBundle` (returns, volatility, SMAs, RSI) in TypeScript, and emits a deterministic buy/hold/sell signal plus a fixed three-question set (choice, score, noul). The `DecisionProvider` interface is the seam where a paid model client can plug in later.

The near-term constraint is stated plainly: **Phase 1 deliberately excludes paying for Jev; the decision layer is deterministic by default.** The Jev client is architecturally anticipated (registry + interface) but not implemented.

---

## 2. Architecture

```
Yahoo Finance (free, unofficial)
        │  chart() + quote(), concurrency 3, delay + jitter, backoff
        ▼
YahooSource (implements PriceSource seam)
        │  PriceBar[] (trade_date = America/New_York session date)
        ▼
IngestEngine.runIngest()
        │  pg_try_advisory_lock(727112233445)  single-flight
        │  one DB transaction per symbol
        │  instrument upsert + bars upsert commit atomically
        ▼
Postgres (Supabase-managed)
        │  instruments · daily_prices · ingestion_runs
        ▼
Hono RPC  /api/market-data/*  (GET universe / prices / latest, POST ingest)
        │
        ▼
Analysis layer  DecisionProvider → DeterministicProvider (jev reserved)
```

### Database schema (`packages/database/src/schema/market_data.ts`, migration `0001_regular_dracula.sql`)

| Table            | Purpose                                                                                                    | Key constraints                                                                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instruments`    | Tradable instruments. Surrogate serial PK; `symbol` is never the PK because tickers change and get reused. | Partial unique index `instruments_symbol_active_unique_idx` on `symbol WHERE is_active = true`; `asset_class` defaults to `equity`; `is_active` defaults to `true`                                                               |
| `daily_prices`   | Daily OHLCV bars per instrument.                                                                           | Unique index `daily_prices_instrument_trade_date_unique_idx` on `(instrument_id, trade_date)`; FK to `instruments.id` with `ON DELETE cascade`; `numeric(12,4)` OHLC columns; `volume` is `bigint` with Drizzle `mode: "number"` |
| `ingestion_runs` | One audit row per run (backfill / update / manual).                                                        | `run_type` and `status` are typed text columns (`running` / `finished` / `failed`); counters `symbols_requested`, `symbols_succeeded`, `records_upserted`; nullable `error`                                                      |

Drizzle relations (`relations.ts`) wire `instruments → many daily_prices` and `daily_prices → one instruments`. The schema is exported from `packages/database/src/index.ts` alongside the existing `users` and `notifications` tables.

### `packages/market-data` (the ingestion package)

| Module                       | Role                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`               | Wire-format domain types: `PriceBar`, `InstrumentMeta`, `PriceSourceOptions` (concurrency 3, delay 2000ms + jitter, maxRetries 5)                                                                                                                             |
| `src/sources/priceSource.ts` | The `PriceSource` seam: `fetchDailyBars(symbol, {years})` and best-effort `fetchInstrumentMeta(symbol)`. Implementations never read `process.env`                                                                                                             |
| `src/sources/yahooSource.ts` | Yahoo Finance adapter. `chart` for bars, `quote` for metadata, typed `PriceSourceError`, semaphore + throttle + exponential backoff. `formatTradeDate` pins the date to America/New_York via `Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" })` |
| `src/universe.ts`            | `DEFAULT_UNIVERSE`: 49 frozen US large-caps across 11 GICS sectors, code-owned so the DB never depends on enrichment                                                                                                                                          |
| `src/ingest/engine.ts`       | `IngestEngine.runIngest`: advisory lock, per-symbol transaction, run audit, best-effort metadata                                                                                                                                                              |
| `src/ingest/upsert.ts`       | `upsertInstrument` (partial-index-aware `onConflictDoUpdate`) and `upsertBars` (`ON CONFLICT (instrument_id, trade_date) DO UPDATE` from `excluded.*`)                                                                                                        |
| `src/ingest/types.ts`        | `IngestParams`, `IngestResult`, `SymbolFailure`, `ConcurrentRunError`, `INGEST_SOURCE = "yahoo"`, `INGEST_LOCK_KEY = 727112233445`                                                                                                                            |
| `src/cli/runCli.ts`          | Shared CLI runner: parses `--years N` / `--years=N`, builds `YahooSource` + `IngestEngine`, prints a run summary, exits 1 on failure                                                                                                                          |
| `src/cli/backfill.ts`        | Entrypoint: `dotenv/config`, then `runCli({ runType: "backfill", defaultYears: 30 })`                                                                                                                                                                         |
| `src/cli/update.ts`          | Entrypoint: `dotenv/config`, then `runCli({ runType: "update", defaultYears: 5 })`                                                                                                                                                                            |

### Backend (`apps/backend`)

- `src/routes/marketData.ts`: the four RPC routes (see section 4). Query helpers (`listUniverse`, `fetchBars`, `fetchLatestBars`, `parseYears`) are exported for tests.
- `src/index.ts`: mounts the handler under `/api/market-data` and re-exports the chained app as `AppType` for the typed frontend client.
- `src/analysis/{types,deterministic,registry,index}.ts`: the decision layer (see section 7).
- `src/env.ts`: `DECISION_PROVIDER` (default `"deterministic"`), plus the Supabase env vars.

---

## 3. Key data-model decisions

These decisions were hard-won corrections during the epic; treat them as contract, not style.

1. **`trade_date` is the America/New_York session date, never UTC-derived.** A bar whose timestamp is 2026-09-22 20:30 UTC (16:30 America/New_York) must carry `tradeDate "2026-09-22"`. `YahooSource.formatTradeDate` enforces this with an `en-CA` formatter pinned to the `America/New_York` timezone. The schema comment on `daily_prices.trade_date` mirrors this.
2. **One DB transaction per symbol.** Bars are fetched over the network outside the transaction; then the instrument upsert and the bars upsert commit atomically. A failure mid-symbol rolls back only that symbol and the run continues with the rest (`failedSymbols` records it).
3. **`numeric(12,4)` OHLC arrive as JS strings from postgres-js and stay strings over the wire.** postgres-js returns NUMERIC as string; the RPC routes return them as-is and consumers parse before arithmetic. `volume` uses `bigint` mode `"number"` so JSON serialization never hits BigInt.
4. **`POST /ingest` uses `pg_try_advisory_lock` single-flight.** A concurrent run gets a typed `ConcurrentRunError`, surfaced as HTTP 409. The lock key is a literal bigint constant (`727112233445`) so every process agrees on it.
5. **Partial unique index on `instruments.symbol WHERE is_active`.** `upsertInstrument` uses `onConflictDoUpdate` with `target + targetWhere` matching the partial index exactly: an active row gets refreshed metadata, an inactive row does not conflict and a fresh active row is inserted.
6. **`onConflictDoUpdate` with `targetWhere` + `excluded.*` bars self-heal.** Re-fetching a window overwrites every OHLCV field from the fresh data, so adjusted-close restatements and provider corrections are repaired on the next run.
7. **`ingestion_runs` audits every batch.** One row per run, created as `running`, finalized to `finished` or `failed` in a single transaction with counters and error text.
8. **Instrument metadata enrichment is best-effort and never fails a symbol.** `fetchInstrumentMeta` returns a null-object on any failure; the engine wraps it in `fetchMetaBestEffort` and falls back to the universe config's `name`/`sector`.
9. **CLI defaults: backfill 30 years, update 5 years.** Both scripts accept `--years N` to override.

---

## 4. API contract

All routes live under the `/api` base path (mounted at `/api/market-data`). Public reads need no auth; `POST /ingest` requires a Supabase Bearer token. Wire convention: OHLC values are strings, `volume` is a number.

| Method | Path                              | Auth                                             | Request                                                                                                         | Response                                                                                                                                                                     | Status codes                                                                                                                                                                                                                                         |
| ------ | --------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/market-data/universe`       | none                                             | none                                                                                                            | `UniverseEntryWire[]`: 49 entries `{ symbol, name, sector }`, always from the code-owned `DEFAULT_UNIVERSE`                                                                  | 200                                                                                                                                                                                                                                                  |
| GET    | `/api/market-data/prices/:symbol` | none                                             | optional `?start=YYYY-MM-DD&end=YYYY-MM-DD` (inclusive filters on `trade_date`)                                 | `PriceBarWire[]` oldest-first: `{ tradeDate, open, high, low, close, adjClose, volume, source }`                                                                             | 200; 404 with `{ error, hint: "run POST /api/market-data/ingest first" }` when the symbol is unknown or has no bars in the window                                                                                                                    |
| GET    | `/api/market-data/latest`         | none                                             | none                                                                                                            | `LatestBarWire[]` ordered by symbol: `{ symbol, name, tradeDate, close, adjClose, volume }`; only instruments with at least one bar appear (inner join on `max(trade_date)`) | 200                                                                                                                                                                                                                                                  |
| POST   | `/api/market-data/ingest`         | Bearer token (Supabase JWT via `authMiddleware`) | optional JSON body `{ "years": <positive int> }`; empty body defaults to 1 year; `runType` is always `"manual"` | `IngestResult`: `{ runId, runType, symbolsRequested, symbolsSucceeded, recordsUpserted, failedSymbols: [{ symbol, error }] }`                                                | 200; 400 malformed JSON (`"Invalid JSON body"`) or non-positive/non-integer `years` (`"years must be a positive integer"`); 401 missing or invalid token; 409 `ConcurrentRunError` (`"another ingestion run is in progress"`); 500 any other failure |

Notes on the implementation (`apps/backend/src/routes/marketData.ts`):

- `:symbol` is trimmed and uppercased before lookup.
- `start`/`end` are passed straight to `gte`/`lte` on `trade_date`; pass `YYYY-MM-DD` values.
- `POST /ingest` reads the raw body as text, so an empty body is valid and means "1 year". A body with a `years` field that is not a positive integer returns 400.
- `authMiddleware` (`apps/backend/src/middleware/authMiddleware.ts`) validates the token via `supabase.auth.getUser` and sets `userId` on the context; it throws 401 for a missing `Bearer ` prefix or an invalid token.

---

## 5. Running it

### Prerequisites

- `DATABASE_URL` pointing at the Supabase-managed Postgres (the `@model_md/database` client uses `prepare: false` for the pooler).
- For the backend routes: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (declared in `apps/backend/src/env.ts`), and optionally `DECISION_PROVIDER` and `PORT` (default 3000).

### Ingestion CLI (from `packages/market-data`)

```bash
# Full-history backfill, default 30 years
pnpm market-data:backfill

# Incremental update, default 5 years
pnpm market-data:update

# Override the window
pnpm market-data:backfill --years 10
pnpm market-data:update --years=1
```

The scripts are defined in `packages/market-data/package.json` (`tsx src/cli/backfill.ts` and `tsx src/cli/update.ts`). Each entrypoint imports `dotenv/config` before anything else, so `.env` is loaded at process start; `runCli` then reads `process.argv` and passes config into `runIngest`. Modules under `packages/market-data/src` never read `process.env` themselves.

### Direct engine usage

The CLI and the HTTP route share one entrypoint, so any operator script can do the same:

```ts
import { db } from "@model_md/database";
import { DEFAULT_UNIVERSE, IngestEngine, YahooSource } from "@model_md/market-data";

const result = await new IngestEngine().runIngest({
  source: new YahooSource(),
  universe: DEFAULT_UNIVERSE,
  runType: "manual", // "backfill" | "update" | "manual"
  db,
  years: 5, // optional; omitted → adapter default window
});
```

### Tests

```bash
# Ingest engine + upsert helpers: 13 tests
pnpm --filter @model_md/market-data test

# Decision layer: 20 tests
pnpm --filter @model_md/backend test
```

### Backend dev server

```bash
pnpm --filter @model_md/backend dev   # tsx watch src/index.ts, serves on :3000
```

The frontend Vite dev server (`apps/frontend/vite.config.ts`) proxies `/api` to `http://backend:3000`, so `client.api.marketData.*` calls from the typed Hono client reach the backend in dev. Phase 1 ships no frontend market-data UI; the RPC client surface is ready for the phase-2 dashboards.

---

## 6. Cron / scheduling wiring

Phase 1 ships **no scheduler infrastructure**. The advisory lock makes overlapping runs safe (the loser gets 409), so you can schedule freely without a queue. Two concrete options:

**Option A: system cron hitting the HTTP route.** Run once per trading day after the US market close. The route defaults to a 1-year window; pass `{"years":5}` for an update-sized window. Recommended time: 22:00 America/New_York (well after the 16:00 close, before any next-day data noise).

```cron
# Daily at 22:00 America/New_York, Mon-Fri (cronie supports CRON_TZ)
CRON_TZ=America/New_York
0 22 * * 1-5 curl -fsS -X POST https://api.example.com/api/market-data/ingest \
  -H "Authorization: Bearer $SUPABASE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"years":5}' >> /var/log/market-data-ingest.log 2>&1
```

If your cron daemon does not support `CRON_TZ`, compute the equivalent hour in the host's local timezone and set the host clock to America/New_York.

**Option B: a small scheduled container** running the CLI directly (no HTTP, no token needed, just `DATABASE_URL`):

```bash
# Inside the container, once per day after close
pnpm market-data:update
```

Either way, overlapping runs are safe: `pg_try_advisory_lock(727112233445)` guarantees single-flight, and a second run returns 409 instead of corrupting data. The `ingestion_runs` table records every attempt for audit.

---

## 7. Decision / analysis layer

Location: `apps/backend/src/analysis/`. Public surface is the barrel `index.ts`; consumers import from there only.

### The contract (`types.ts`)

- **`DecisionProvider`**: the single typed seam every decision backend implements. `analyze(symbol, opts?: { asOfTradeDate? }): Promise<AnalysisSnapshot>`.
- **`AnalysisSnapshot`**: `{ symbol, asOfTradeDate, metrics, questions }`, one typed state plus typed questions in a single call.
- **`MetricBundle`**: every number a consumer might need, precomputed in TypeScript: `returns1d/5d/21d/63d/252d` (percent changes on the adjusted series), `volatility21d` (stdev of last 21 daily returns × √252), `sma50`, `sma200`, `sma50AboveSma200`, `rsi14`, `close`, and the never-null `signal`. Long-horizon fields are null for young symbols with no 252-day history.
- **Question schema**: `choice` (pick one of a fixed option set), `score` (bounded numeric rating, e.g. 0-100), `noul` (no-option open prompt, free-text answer). This mirrors the Jev System One taxonomy.

### `DeterministicProvider` (`deterministic.ts`)

Pure DB reads, no network, no `process.env`, fully deterministic for a given database state. It selects the last ~300 bars (`BAR_LIMIT`), parses the string numerics with `Number()` before arithmetic, and computes the bundle. The signal rule (`computeSignal`, unit-tested):

1. RSI ≥ 70 → `sell` (overbought); RSI ≤ 30 → `buy` (oversold). RSI extremes override everything.
2. Otherwise trend (`sma50AboveSma200`) and 5-day momentum must agree: up + positive → `buy`; down + negative → `sell`.
3. Anything else (missing inputs or disagreement) → `hold`.

`generateQuestions` emits the fixed phase-1 set: a `choice` bias question seeded with the signal, a `score` attractiveness question (0-100), and a `noul` thesis prompt.

### Provider selection (`registry.ts` + `env.ts`)

- `createProvider({ decisionProvider })` returns a `DeterministicProvider` by default or for `"deterministic"`.
- `DECISION_PROVIDER` env var (default `"deterministic"`) is exported from `apps/backend/src/env.ts` for callers to pass in. No route wires it yet in phase 1; the registry and interface are the anticipated wiring point.
- `"jev"` is a reserved name: `createProvider({ decisionProvider: "jev" })` throws an Error stating the Jev provider is not implemented in phase 1 and that `JEV_API_KEY` would be required. Unknown names throw with the supported list.

### The Jev note

Jev is a TypeSafe System One: one typed state plus typed questions in one parallel round trip, at $0.042/M input. It cannot do arithmetic or date math, which is exactly why `MetricBundle` carries every number up front and the question layer only reasons over them. The architecture anticipates it (registry + `DecisionProvider` interface + the choice/score/noul taxonomy), but the client is deliberately not implemented in phase 1.

---

## 8. Phase-2 options (explicitly out of phase 1)

- **Twelve Data implementation** behind the `PriceSource` seam (official API, free key, 800 req/day, `adjust=all`). The interface is its contract; the adapter is not built until a real free key exists.
- **Jev client** implementing `DecisionProvider`, wired through `createProvider("jev")` and `DECISION_PROVIDER=jev`.
- **`analysis_runs` persistence table** to store snapshots and answers.
- **Queue / scheduler infrastructure** (replacing the cron recommendation in section 6).
- **Portfolio simulation** over the stored bars.
- **LLM agents** as additional `DecisionProvider` implementations.
- **RBAC** on the market-data routes.
- **Non-US assets** (the universe is US large-caps only today).
- **DB-seeded universe** (today it is code-owned and frozen).
- **Frontend dashboards** consuming the RPC client (`client.api.marketData.*`).

---

## 9. Verification

- **Lifecycle**: `install`, `verify`, and `build` are green on commit `dc49c4a` (`feat(market-data): RPC routes + vitest suite`), building on `2915e97` (`feat(market-data): ingest engine + analysis layer`) and `cfa4ba4` (`feat(market-data): add ingestion pipeline schema + market-data package`).
- **Test counts**: `packages/market-data/src/ingest/ingest.test.ts` has 13 tests (bar mapping, upsert SQL generation, engine happy path, single-flight lock, symbol-failure isolation, lock release on failure, best-effort metadata). `apps/backend/src/analysis/deterministic.test.ts` has 20 tests (signal rules, question generation, provider analysis, registry behavior).
- **Typecheck**: `lsp_diagnostics` is unreliable in this environment; `tsc --noEmit` (or `pnpm typecheck` at the root) is the authoritative typecheck.

---

## Files changed

| File                                                 | Action | Description                                                                     |
| ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------- |
| `packages/database/src/schema/market_data.ts`        | CREATE | `instruments`, `daily_prices`, `ingestion_runs` tables + partial unique index   |
| `packages/database/src/schema/relations.ts`          | MODIFY | Relations for instruments / daily_prices                                        |
| `packages/database/src/index.ts`                     | MODIFY | Export the market-data schema                                                   |
| `packages/database/drizzle/0001_regular_dracula.sql` | CREATE | Migration for the three tables                                                  |
| `packages/market-data/`                              | CREATE | New package: types, PriceSource seam, YahooSource, universe, ingest engine, CLI |
| `apps/backend/src/routes/marketData.ts`              | CREATE | Four RPC routes under `/api/market-data`                                        |
| `apps/backend/src/index.ts`                          | MODIFY | Mount market-data routes, extend `AppType`                                      |
| `apps/backend/src/analysis/`                         | CREATE | Decision layer: types, deterministic provider, registry, barrel                 |
| `apps/backend/src/env.ts`                            | MODIFY | `DECISION_PROVIDER` env var                                                     |

## Dependencies

- **Ingestion**: `yahoo-finance2` ^3.0.0, `dotenv` ^17.3.1, `drizzle-orm` ^0.45.1, `@model_md/database` (workspace), dev: `tsx` ^4.7.1, `vitest` ^3.0.5.
- **Backend**: `hono` ^4.11.9, `@hono/node-server`, `@supabase/supabase-js`, `@model_md/database`, `@model_md/market-data` (workspace), dev: `vitest` ^3.0.5, `tsx`.

## Related documentation

- Database specialist rules: `packages/database/AGENTS.md`
- Backend specialist rules: `apps/backend/AGENTS.md`
- Beads enforcement and swarm protocol: `.agents/beads-enforcement.md`

---

## 10. Portfolio Simulation + Multi-Agent Financial Analysts

### Overview

The Portfolio Simulation feature turns the market-data OHLCV universe into a forward paper-trading arena. A multi-agent orchestrator spawns six Ph.D-level analyst personas, each with a distinct research methodology, risk stance, and rebalance window. Each analyst reads a self-contained dataset, picks 5 to 10 investments, and emits a JSON decision envelope. The backend valuation engine fills those picks at decision-time close, derives a daily equity curve per run, and ranks the runs into a leaderboard. The frontend renders the leaderboard and per-agent drilldowns with a hand-rolled SVG equity chart.

**Status**: COMPLETED
**Date**: 2026-09-24
**Feature Branch**: `feat-portfolio-sim`
**Epic**: Portfolio Simulation + Multi-Agent Financial Analysts (beads task ez8, swarm epic `model_md-worktree-feat-portfolio-sim-dkq`)
**Beads task**: ez8
**Upstream dependency**: Market Data Pipeline (sections 1-8), which provides the 49-symbol OHLCV universe the analysts pick from.

Phase 1 deliberately spends no Jev. The analyst subagents run headlessly via `opencode run --format json`, and the paid-model seam stays reserved for a future phase.

---

### 10.1 Summary

Three layers make up the feature:

1. **Orchestrator** (`packages/agent-orchestrator/`): a CLI (`pnpm agents:run`) that builds a self-contained analyst dataset from `daily_prices`, spawns varied-persona analyst subagents (no Jev spend), validates their decision envelopes against a frozen contract, and inserts them into the DB with entry fills.
2. **Backend engine** (`apps/backend/src/portfolio/`): a pure derivation layer that computes each run's equity curve from positions plus `daily_prices`, ranks runs by total return, and serves two public RPC routes under `/api/portfolio`.
3. **Frontend** (`apps/frontend/src/components/portfolio/`): a leaderboard of ranked analyst runs with drilldown into per-agent detail, positions, rationale, and an SVG equity chart.

The near-term constraint mirrors the market-data phase: **Phase 1 deliberately excludes paying for Jev; the analyst subagents run headlessly via `opencode run --format json`.** A paid model client can later plug into the `DecisionProvider` seam or the orchestrator's persona spawn cost model.

---

### 10.2 Architecture

```
Analyst personas (6 Ph.D-level, varied prompts, no Jev spend)
        │  opencode run --format json (headless subagent, cwd = worktree root)
        ▼
spawn.ts ── parse NDJSON stdout → extract JSON → validate envelope (contract.ts)
        │  DecisionEnvelope { schemaVersion, roundId, agent, rationale, picks[5-10] }
        ▼
insert.ts ── one transaction: agent_runs row + portfolio_positions rows with entry fills
        │  entryTradeDate = dataset asOfTradeDate · entryPrice = close that day
        │  shares = initialCapital × targetWeight / entryPrice
        ▼
Postgres (Supabase-managed)  agent_runs · portfolio_positions
        │
        ▼
PortfolioEngine (apps/backend/src/portfolio)  valuation.ts + ranking.ts
        │  equity curve from positions + daily_prices (never stored)
        │  leaderboard sorted DESC by totalReturnPct
        ▼
Hono RPC  /api/portfolio/*  (GET leaderboard, GET agents/:id)
        │
        ▼
Frontend  PortfolioLeaderboard → PortfolioDetail → EquityChart (SVG, no chart deps)
```

#### Database schema (`packages/database/src/schema/portfolio.ts`, migration `0002_married_thanos.sql`)

| Table                 | Purpose                                                                    | Key constraints                                                                                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_runs`          | One analyst subagent's decision per simulation round.                      | Serial PK; unique index `agent_runs_round_id_agent_key_unique_idx` on `(round_id, agent_key)`; `replicate_of` self-reference for consistency replicas; `window` typed `daily`/`weekly`/`monthly`; `status` typed `pending`/`completed`/`failed` (default `completed`) |
| `portfolio_positions` | One equal-weight pick per run, with the entry fill at decision-time close. | Serial PK; FK to `agent_runs.id` with `ON DELETE cascade`; unique index `portfolio_positions_agent_run_id_symbol_unique_idx` on `(agent_run_id, symbol)`; `shares` = `initialCapital × targetWeight / entryPrice` (fractional shares allowed)                         |

`agent_runs` carries the run identity and decision: `id`, `agent_key`, `persona`, `strategy`, `window`, `replicate_of`, `round_id`, `initial_capital`, `rationale`, `decision_json`, `status`, and timestamps. The performance metrics `current_value`, `total_return_pct`, `sharpe`, `max_drawdown_pct`, and `as_of_trade_date` are derived by the backend ranking engine from the equity series; they are never stored. `portfolio_positions` stores the entry fill: `id`, `run_id`, `symbol`, `target_weight`, `shares`, `entry_trade_date`, `entry_price`. The marks `name`, `latest_trade_date`, `latest_price`, `value`, and `unrealized_pnl_pct` are computed in the route layer from `daily_prices`.

Drizzle relations (`relations.ts`) wire `agent_runs → many portfolio_positions` and `portfolio_positions → one agent_runs`. The schema is exported from `packages/database/src/index.ts` alongside `users`, `notifications`, and the market-data tables.

#### Backend engine (`apps/backend/src/portfolio/`)

| Module         | Role                                                                                                                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`     | Wire types: `EquityPoint`, `RankingResult`, `REBALANCE_CADENCE` (daily=1, weekly=5, monthly=21), and `parseNumeric` (DB numeric strings parsed to JS numbers at the edge)                                                                                                                 |
| `valuation.ts` | `computeEquitySeries`: shares = `initialCapital × targetWeight / entryPrice`; `entryTradeDate` = the latest `trade_date`; `entryPrice` = that day's close; rebalance to equal target weights every Nth trading day (daily=1, weekly=5, monthly=21); total value preserved by construction |
| `ranking.ts`   | `computeRanking`: total-return-based ranking with Sharpe (mean/stdev × √252, rf=0) and max drawdown (negative %)                                                                                                                                                                          |
| `index.ts`     | `PortfolioEngine` orchestrator: read-only query helpers (`loadRunsForLeaderboard`, `loadRunById`, `loadPositionsForRuns`, `loadBarsForRuns`). The engine never writes; the orchestrator owns ingest                                                                                       |

Routes live in `apps/backend/src/routes/portfolio.ts`, mounted `.route("/portfolio", portfolioHandler)` in `apps/backend/src/index.ts`. The backend suite is 19/19 vitest tests passing, tsc clean.

---

### 10.3 API contract

Both routes are public reads (no auth), consistent with the market-data reads. Wire convention: portfolio values are computed numbers, so they go out as JSON numbers (unlike raw OHLC bars, which stay strings). The contract is frozen by gate `contract-portfolio-api`.

| Method | Path                         | Auth | Request                                      | Response                                                                                                                                                                                                                                                                                                                                                                                                        | Status codes                                                                      |
| ------ | ---------------------------- | ---- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| GET    | `/api/portfolio/leaderboard` | none | optional `?round=<id>`; default latest round | array sorted DESC by `totalReturnPct`: `[{ runId, agentKey, persona, strategy, window, replicateOf, roundId, initialCapital, currentValue, totalReturnPct, sharpe, maxDrawdownPct, asOfTradeDate, status }]`                                                                                                                                                                                                    | 200 (empty array when no completed runs)                                          |
| GET    | `/api/portfolio/agents/:id`  | none | none                                         | `{ runId, agentKey, persona, strategy, window, replicateOf, roundId, initialCapital, currentValue, totalReturnPct, sharpe, maxDrawdownPct, asOfTradeDate, status, rationale, decisionJson, positions: [{ symbol, name, targetWeight, shares, entryTradeDate, entryPrice, latestTradeDate, latestPrice, value, unrealizedPnlPct }], equitySeries: [{ tradeDate, totalValue, returnPct, cash, holdingsValue }] }` | 200; 400 `{ error, hint }` bad id; 404 `{ error, hint }` missing or not completed |

Notes on the implementation (`apps/backend/src/routes/portfolio.ts`):

- The leaderboard only includes runs with `status = "completed"` and at least one position; the latest round is resolved by run `created_at`.
- `:id` must be a positive integer; anything else returns 400. A run that does not exist or is not `completed` returns 404.
- The equity series is derived on the fly from positions plus `daily_prices`; nothing is persisted per day.

---

### 10.4 Orchestrator (`packages/agent-orchestrator/`)

| Module               | Role                                                                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `personas.ts`        | Six Ph.D-level analyst personas (Dr. Value, Dr. Momentum, Dr. Contrarian, Dr. Macro, Dr. Compounder, Dr. Technical), each with a distinct methodology, risk stance, and rebalance window; prompts written to diverge             |
| `dataset.ts`         | Builds a self-contained `rounds/<roundId>/dataset.json` from `daily_prices`: per-symbol returns, volatility21d, RSI-14, SMAs, 52-week range, avg dollar volume. The analyst never touches the DB; dataset.json is the only truth |
| `contract.ts`        | The agent-decision contract: `DecisionEnvelope` (schemaVersion 1, roundId, agent, rationale, picks[5-10]) with `validateEnvelope` as the single gate; anything that passes is insertable and valuatable                          |
| `spawn.ts`           | Spawns each analyst headlessly via `opencode run --format json`, parses the NDJSON stdout stream, extracts the JSON envelope, validates it, and retries once with a correction hint on failure                                   |
| `insert.ts`          | Inserts one validated envelope in a transaction: one `agent_runs` row plus one `portfolio_positions` row per pick with entry fills; `DuplicateRunError` on an existing `(roundId, agentKey)`                                     |
| `cli.ts` / `args.ts` | CLI entrypoint `pnpm agents:run -- --round <roundId>`; the only module that reads `process.env` / `process.argv`; pure arg parsing kept import-free for tests                                                                    |

Flow: build dataset → spawn agents (parallel, capped at `--max-parallel 3`) → validate → insert each → print a summary table. A multi-agent round is tracked as a swarm: epic `model_md-worktree-feat-portfolio-sim-dkq` wraps beads task ez8. The orchestrator suite is 54/54 vitest tests passing, tsc clean. Gate `contract-agent-decision`.

---

### 10.5 Frontend (`apps/frontend/src/components/portfolio/`)

| Component                  | Role                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PortfolioLeaderboard.tsx` | Ranked table (rank, agent, strategy, window, current value, total return, Sharpe, max drawdown, as-of); loading / empty / error+retry states; replica badge; row click drills into the run |
| `PortfolioDetail.tsx`      | Agent card with stats, rationale, positions table, EquityChart, back link; friendly 400/404 errors rendered from `{ error, hint }`                                                         |
| `EquityChart.tsx`          | Hand-rolled SVG area/line chart, no chart dependencies; scales `returnPct` with a dashed zero line and gridlines                                                                           |
| `format.ts`                | `formatCurrency`, `formatPct`, `formatWindow` helpers                                                                                                                                      |

Wire types `ApiLeaderboardRow` and `ApiAgentDetail` are derived via `InferResponseType` in `apps/frontend/src/lib/api.ts`, the centralized Hono client (no raw fetch). `App.tsx` is session-gated with Portfolio/Users tab navigation (default Portfolio view) and lightweight `selectedRunId` routing; deliberately no react-router. Gate `ui-contract-portfolio`.

---

### 10.6 Verification

- **Lifecycle**: `install`, `verify`, and `build` SUCCESS; workspace lint PASS; frontend `tsc` PASS.
- **Format**: a 41-file repo-wide fmt churn was applied via lifecycle `format` (commit `e5a28d9`); all checks green at epic close.
- **Test counts**: backend portfolio engine 19/19 vitest tests; orchestrator 54/54 vitest tests.
- **Commits**: `98766b6` (schema), `70dc47e` (backend), `e862c11` (orchestrator), `0841f48` (frontend), `e5a28d9` (format).

---

### 10.7 Beads & Gates

- **Epic**: `model_md-worktree-feat-portfolio-sim-ez8` (beads task ez8; the multi-agent round swarm epic `model_md-worktree-feat-portfolio-sim-dkq` wraps it).
- **Gates**:
  - `schema-portfolio`: DB schema for `agent_runs` / `portfolio_positions` (migration `0002_married_thanos.sql`)
  - `contract-portfolio-api`: frozen API contracts for `/api/portfolio/*`
  - `contract-agent-decision`: the `DecisionEnvelope` handoff between orchestrator and backend
  - `ui-contract-portfolio`: frontend leaderboard / detail / chart contract

---

### 10.8 Future work (explicitly out of phase 1)

- A paid model client can plug into the `DecisionProvider` seam (see the Market Data section) or the orchestrator's persona spawn cost model.
- No Jev spend in phase 1 by design; the analyst subagents run headlessly via `opencode run --format json`.

---

## 11. Round history & snapshot selector

### Overview

A **simulation** owns a persistent book; a **round** is one dated decision step inside it. Until now
the Streams board could only show the _current_ book, so there was no way to inspect what the board
looked like at an earlier chain position. This adds a round list plus a per-round snapshot read, and a
dropdown to select among them.

### 11.1 API contract

| Route                                                | Returns                                                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /portfolio/simulations/:simId/rounds`           | `{ roundId, roundSeq, asOfTradeDate \| null, status, runCount }[]`, ordered by `roundSeq` ASC      |
| `GET /portfolio/simulations/:simId/rounds/:roundSeq` | `{ simulationId, roundId, roundSeq, decideTradeDate, basisCapital, streams: StreamSummaryWire[] }` |

`snapshot.streams` has the **same element shape** as the existing
`GET /portfolio/simulations/:simId/streams` response, so the frontend renders both through one table.
`roundSeq` is a positive integer; a malformed value is a 400, an unknown sim or out-of-range
`roundSeq` is a 404.

### 11.2 Key decision: no snapshot table

The obvious design is a per-round position snapshot table. This deliberately does **not** add one.

`planChainRebuild` already replays a stream's whole chain from round 1 and is pure — the fold is
forward-only and deterministic, so replaying a _prefix_ of rounds reproduces exactly the book in force
after that round. A snapshot is therefore just:

```
planChainRebuild({ key, basisCapital, rounds: rounds.filter(r => r.roundSeq <= target), bars })
```

The round history is already the ledger, so a second copy would be a derived cache that can only ever
disagree with it. This is the same reasoning that made the state cache disposable.

Consequence: a snapshot costs a replay per stream. That is acceptable because round count grows with
trading days (small), and the read is pure — no writes, no locks, no transaction.

### 11.3 Semantics worth knowing

- **Ranking reads the replayed curve, not the live cache.** Every metric on a snapshot row comes from
  the same round prefix, so the row is internally consistent. Mixing a cached curve with a replayed
  book would produce a self-contradictory row.
- **A stream that had not folded by `roundSeq` reports the untouched chain basis, not a −100% loss.**
  It never held a position, so nothing was lost. The alternative would make an early round look like a
  total loss for every stream that joined later.
- **Rounds are ordered by `round_seq`, never `created_at`.** With 18 agents inserting concurrently,
  `created_at` is insertion _finish_ time, so it would rank by whichever agent happened to write last.
  A unique index on `(simulation_id, round_seq)` makes `round_seq` a total order.
- **Undated rounds stay in the list.** A round booked but never reached a dataset date is surfaced with
  `asOfTradeDate: null` rather than filtered out, so it cannot silently vanish from the history.

### 11.4 Known related defect (not fixed here)

The **legacy** leaderboard (`apps/backend/src/portfolio/index.ts`, `loadRunsForLeaderboard`) resolves
"latest round" with `orderBy(desc(agentRuns.roundSeq))`. Legacy standalone runs have
`round_seq = NULL`, and PostgreSQL's `DESC` defaults to `NULLS FIRST`, so legacy rows outrank the
carryover rows (`round_seq = 1`) and hijack resolution. Symptom: the legacy Runs tab shows stale
September portfolios that read as "price movement" when they mean "wrong round". Fix is
`desc(roundSeq NULLS LAST)` with a `created_at DESC` fallback for legacy rows. Left out of this change
because it is a separate defect in the frozen legacy engine, not part of round-snapshot history.

### 11.5 Frontend round selector (`StreamBoard.tsx`)

A native `<select>` lists `Latest (live book)` plus one option per round, labelled
`Round <seq> — <date> · <n> runs` (a round booked without a date renders `no date`). Default selection
is the newest chain position, whose snapshot is the book the board showed before the selector existed.

- Wire types `ApiSimulationRound` / `ApiRoundSnapshot` are **derived** from `@model_md/backend`'s
  `AppType` via the file's existing `Extract` idiom rather than hand-copied, so a backend shape change
  breaks `tsc` instead of drifting silently at runtime.
- Live and snapshot modes share **one** table renderer — `snapshot.streams` has the same element shape
  as the live streams list, so the grouping/rendering path is unchanged.
- A snapshot renders **only** when `snapshot.roundSeq === selectedRoundSeq` (`snapshotInView`). If two
  round requests race, a late response is stored but not displayed, so wrong-round data can never be
  shown. A failed request leaves the previously rendered table up (never blanks the board) and reuses
  the file's existing destructive banner.
- The caption always describes the table actually on screen — including `Loading round N snapshot…`
  and `snapshot unavailable — showing the live book` — rather than assuming the fetch succeeded.
- Selector is hidden entirely when the simulation has no recorded rounds; a single round still renders it.
- Switching simulations clears the previous rounds/snapshot first, so the prior book's data can never
  appear under a newly-chosen simulation.

**Known limitation (accepted):** snapshot requests are not aborted or sequence-guarded. A stale
response that lands last leaves `snapshotInView` false, so the board falls back to the live book with an
"unavailable" caption until the next selection. No incorrect data is ever displayed, and it
self-corrects, so an `AbortController` was judged not worth the added state.

### 11.6 Verification

- Backend: `tsc --noEmit` clean; `155/155` vitest tests pass (8 files), including 4 new cases covering
  `parseRoundSeq` rejection of non-positive integers and the snapshot freezing at the requested round
  rather than the newest one.
- Frontend: `tsc --noEmit -p tsconfig.app.json` clean; `oxlint` 0 warnings / 0 errors on both changed files.
- **Not covered:** neither new route has been exercised against a live database — the backend is
  unreachable from the agent container (`localhost:3000` and `backend:3000` both refuse connection), so
  the DB-touching paths (`loadSimulationRounds`'s `count(*)` grouping and the multi-stream replay) are
  verified by types and unit tests only. Worth one manual browser check.

### 11.7 Beads

- **Epic**: `model_md-worktree-feat-portfolio-sim-8vg`
- Backend task `model_md-worktree-feat-portfolio-sim-31w` — closed after commit + verify.

## 12. Rebalance cadence gate

### Overview

Every round was spawning all 18 streams, so a `weekly`/`monthly` stream rebalanced on **every**
daily round — its window was decorative. The fix makes the window a real decision boundary: a
stream only decides once enough **trading days** have elapsed since its last decision.

### 12.1 Decision

The gate lives in the **backend launch path**, not the orchestrator. The orchestrator runs as a
throwaway `docker run --rm -i` container per tool call, so any gate it owned would be bypassable and
non-durable. The launch gate is server-side and writes the per-stream disposition in the **same
transaction** as the `round_jobs` row.

### 12.2 Mechanics

- **`computeRosterDue`** (`apps/backend/src/portfolio/carryoverStore.ts`) counts trading days since
  each stream's last decision from the price calendar (`loadTradingDatesBetween`) — the same
  calendar the fold marks against, so weekends and holidays never advance the count. The calendar is
  loaded **once** for the whole roster, not per stream.
- **`isDecisionDue`** (`carryover.ts`) applies `REBALANCE_CADENCE` (daily = 1, weekly = 5,
  monthly = 21 trading days). `null` (a stream's first round) is always due.
- **`round_agent_progress.status`** gains a **`not_due`** value (TS union only; the column is `text`,
  so no migration). A `not_due` stream is stamped in the launch transaction and **not spawned**; the
  orchestrator filters it out via **`selectDueJobs`** (`jobs.ts`).
- **`deriveFinalStatus`** treats `not_due` as settled success — an all-`not_due` round is `done`,
  never `error`/`partial`.
- **Backstop**: `POST /portfolio/runs` returns **409 `NOT_DUE`** if a stream the gate marked
  `not_due` posts a run anyway, so a book can never advance ahead of its cadence.
- **Takeover / replace bypass** the gate: they are deliberate re-runs, and the stream's state still
  shows the round's own date (0 trading days), so without the bypass nothing would re-launch.
- **Equity marking** stays lazy: a carried stream's mark is back-filled across gap days by
  `computeChainEquitySeries` when it next decides. The UI's existing `behind` affordance
  (`StreamBoard.tsx`) is the honest read-side signal; no mark-only fold was added, because that
  would introduce a second writer and break the single-writer invariant.

### 12.3 Supersedes the earlier spec

This reverses **§R1** and uncertainty #2 of `.agents/portfolio-carryover-spec.md`, which chose
"cadence is advisory; all 18 run every round." That choice was falsified empirically — weekly/monthly
streams rebalanced daily. The 18-wide persona×window roster is retained; only the **disposition** of
a non-due stream changed (skip, not decide).

### 12.4 Verification

- `tsc --build` clean on the changed packages.
- `roundJobs.test.ts` (23), `carryover.test.ts`, and `orchestrator.test.ts` green, including new
  cases for `statusForAgent`, `selectDueJobs`, and `deriveFinalStatus` with `not_due`.
- **Not covered:** the DB-touching `computeRosterDue` / launch-gate paths are exercised by the
  feature lifecycle (`execute_lifecycle(action="verify")`), not by the shell — the agent container
  cannot reach the database directly.

### 12.5 Beads

- **Epic**: `model_md-worktree-feat-portfolio-sim-ii8`
- `ii8.1`–`ii8.5`, `ii8.7`: schema, launch gate, 409 backstop, orchestrator status/filter, tests.
- `ii8.6` (frontend): no change required — the `behind` indicator already reflects a carried book.
- `ii8.8`: lifecycle verify.

---

## 13. Portfolio eval harness (as-of replay, on-read scoring, driver)

### Overview

The carryover chain was only ever driven forward from "today". An **eval harness** makes it possible
to replay a simulation over an arbitrary **historical window** and score the result: rebuild each
round's dataset as of a pinned past trade date, drive the analyst stream walk-forward across the
window, and score the materialized equity ledger over any `[start, end]`.

Three phases, all in the `feat-portfolio-sim` worktree:

1. **As-of pinning** (cpn.1): thread an optional `asOfTradeDate` through the dataset build, the round
   dataset route, and the `start_agent_round` MCP tool so a round can decide as of a historical close.
2. **Driver** (cpn.3): a `run_eval_period` MCP tool that walks a window, skipping dates where no
   stream is due, launching one pinned round per due date sequentially.
3. **Scoring** (cpn.2): on-read backend routes that slice the chain ledger to a window and return
   per-stream metrics plus an equal-weight benchmark.

**Status**: COMPLETED
**Feature Branch**: `feat-portfolio-sim`
**Epic**: `model_md-worktree-feat-portfolio-sim-cpn`
**Beads**: cpn.1, cpn.2, cpn.3 (closed); cpn.4 (integration/docs)

### 13.1 As-of pinning (cpn.1, commit `16ec9ff`)

- **`buildDataset`** (`packages/agent-orchestrator/src/dataset.ts`) gains an optional
  `asOfTradeDate`. When set, it is validated as a strict `YYYY-MM-DD` calendar date (rollovers like
  `2026-02-30` rejected) and used as the decision date instead of the global `MAX(trade_date)`. The
  existing `fetchBars` already filters `trade_date <= asOf`, so every derived metric (returns, SMA,
  RSI, volatility, 52-week range) is computed from bars at or before the pin. A pin that predates
  every ingested bar yields an empty universe and is refused the same way the empty-table path is —
  no useless dataset is persisted.
- **`POST /api/portfolio/rounds/:roundId/dataset`** (`apps/backend/src/routes/rounds.ts`) accepts an
  optional `{ asOfTradeDate }` body. `parseAsOfTradeDate` (exported, unit-tested) returns `undefined`
  for absent/null, a validated date string otherwise, and throws `AsOfTradeDateError` → 400 for
  anything malformed. The no-data 409 now carries a pin-aware hint
  (`no price bars exist on or before <date>`).
- **`start_agent_round`** (`apps/mcp-servers/mcp-portfolio-orchestrator/src/index.ts`) gains an
  optional `asOfTradeDate` param and forwards it to the dataset POST. The dataset's **resolved**
  `asOfTradeDate` is what is threaded into `store.startRound`, so the booking date always equals the
  dataset date (the `POST /runs` consistency invariant is preserved).

### 13.2 Driver — `run_eval_period` (cpn.3, commit `3aadf57`)

An MCP tool on the portfolio-orchestrator server. Inputs: `simId`, `start`, `end`, plus the
`start_agent_round` roster options (`agents`, `windows`, `maxParallel`, `capital`).

1. Fetch the window's trade dates (`GET /api/portfolio/trading-dates`).
2. Read each stream's last decision date from `GET /api/portfolio/simulations/:simId/streams`
   (`lastTradeDate`) — the same field the backend's `computeRosterDue` counts from, so client and
   launch gate agree. A stream absent from the summary has not folded yet, so its first round is due.
3. Walk dates **ascending**; **skip** any date where no selected stream is due. Due-ness mirrors the
   cadence: daily = 1, weekly = 5, monthly = 21 trading days in `(lastDecision, date]`. The calendar
   is extended back to the earliest selected stream's last decision so an elapsed count never reads
   short.
4. On each due date, launch a **pinned round** (`roundId` `eval-<simId>-<date>`,
   `asOfTradeDate = date`) with the same flow as `start_agent_round` (build dataset → book round →
   run only the streams the launch gate left `pending`). Rounds run **sequentially** — a date's
   due-ness depends on the marks the previous round wrote — and stream state is refetched after every
   fold.
5. **Fail-stop**: the first backend 409 (`OUT_OF_SEQUENCE` / `STALE_TRADE_DATE` /
   `ROUND_ALREADY_COMPLETE` / …) stops the walk and reports the blocking date, code, hint, and next
   step (the fold is forward-only, so continuing past a refusal would book later rounds on a chain
   that never advanced).

New modules: `src/evalPeriod.ts` (orchestration), `src/evalCadence.ts` (cadence mirror + calendar +
round-id), `src/pinnedRound.ts` (one pinned round), `src/rerunActions.ts` (the rerun-action map,
now shared with `start_agent_round`). The tool is registered in `index.ts` and allow-listed in
`infra/bin/mcp-gateway-setup/local-mcp.yaml.template`. The tool blocks for the whole window (minutes
per round × number of due dates).

### 13.3 On-read scoring (cpn.2, commit `4b8515a`)

Two public backend reads, computed on demand from the materialized chain ledger — **no new tables,
no stored metrics** (the same no-snapshot-table philosophy as §11.2):

| Method | Path                           | Request                                | Response                                                                   |
| ------ | ------------------------------ | -------------------------------------- | -------------------------------------------------------------------------- |
| GET    | `/api/portfolio/trading-dates` | optional `?start=&end=` (`YYYY-MM-DD`) | `{ tradeDates: string[] }` — distinct `daily_prices.trade_date`, ascending |
| GET    | `/api/portfolio/evals/:simId`  | required `?start=&end=` (`YYYY-MM-DD`) | `{ simId, start, end, tradingDays, benchmark, streams[] }`                 |

- **`apps/backend/src/portfolio/evalMetrics.ts`** is the pure math layer (no DB, no env):
  `sliceStreamEquity` slices a stream's equity rows to `(start, end]` with the baseline being the
  last row at or before `start` (a stream that began inside the window uses its first in-window row
  and is flagged). `computeStreamEvalMetrics` reuses `computeRanking` with the slice's baseline as the
  basis, and returns `null` risk metrics (Sharpe, annualized vol) when the slice has fewer than two
  rows — no fabricated volatility from a single point. `computeEqualWeightBenchmark` is the mean
  per-symbol `adjClose(last) / adjClose(first) − 1` over the 49-symbol `DEFAULT_UNIVERSE`, method
  tagged `equal-weight buy-and-hold on adjClose`.
- A stream with no book in the period reports `"no book in period"` rather than a flat 0%.
- **`apps/backend/src/routes/portfolioEvals.ts`** is the thin edge: parse → load → call the pure
  functions → respond. `parseRequiredDate` / `parseOptionalDate` are exported and unit-tested;
  required dates are 400 when absent or malformed, and an unknown simulation is 404. Per-stream
  decision counts come from `agent_runs ⋈ round_jobs` filtered by `as_of_trade_date ∈ [start, end]`.
- Mounted in `apps/backend/src/index.ts` (`portfolioEvalsHandler` under `/portfolio`).

### 13.4 Semantics worth knowing

- **A pin changes the decision date, not the calendar.** `asOfTradeDate` selects the bar window and
  the booking date; it does not fabricate bars or shift `trade_date`.
- **Due-date jumping avoids empty rounds.** The driver never books a round on a date where every
  selected stream is not-due, so a weekly/monthly stream is not re-run daily during a replay.
- **The reader is independent of the driver.** Scoring reads whatever the chain ledger already holds
  for `[start, end]`; a partial replay scores the rounds that exist.
- **Benchmark has no SPY.** The universe is US large-caps; the benchmark is equal-weight buy-and-hold
  **across those 49 symbols**, method string returned for transparency.

### 13.5 Verification

- **Lifecycle**: `execute_lifecycle(action="verify")` SUCCESS on the integration worktree.
- **Test counts**: `packages/agent-orchestrator` **92/92** (7 new dataset as-of tests);
  `apps/backend` **185/185** (17 new `evalMetrics` tests + `rounds.test.ts` as-of cases);
  `mcp-portfolio-orchestrator` **86/86** (17 new `evalPeriod` tests, existing 69 intact).
- **Typecheck**: `tsc --noEmit` clean on `agent-orchestrator`, `apps/backend`, and the MCP package.
- **Lint**: `oxlint` 0 warnings / 0 errors on every changed file.
- **Commits**: `16ec9ff` (as-of pinning), `4b8515a` (on-read eval routes), `3aadf57` (`run_eval_period`).
- **Not covered:** the replay driver has not been exercised against a live backend/DB end-to-end —
  its due-date and sequencing logic is proven by unit tests against a stub that plays the backend's
  cadence gate; the DB-touching scoring paths are covered by `verify` and unit tests only.

### 13.6 Beads

- **Epic**: `model_md-worktree-feat-portfolio-sim-cpn`
- `cpn.1` — as-of pinning (closed)
- `cpn.2` — on-read eval metrics routes (closed)
- `cpn.3` — `run_eval_period` driver (closed)
- `cpn.4` — integration: lifecycle verify + this documentation + epic close

---

## 14. Replay efficiency: reduced-roster evals + per-date dataset cache

### Overview

Two low-risk levers cut the opencode token / API-call cost of replaying a fixed historical window. Neither changes any simulation semantics: the fold, bookkeeping, cadence gate, and scoring are untouched — only _which streams decide_ and _how often a dataset is recomputed_.

### 14.1 Reduced-roster eval convention

Every round spawns one cold `opencode run --format json` session per selected `(persona × window)` stream — the full roster is 6 personas × 3 windows = **18 sessions per round**, and a week-long `run_eval_period` replay multiplies that by the number of due dates. Each session cold-loads the worktree instructions plus its persona prompt, so the roster width is the dominant cost.

When the goal is prompt/process refinement rather than a full-court read, pass an explicit subset instead of `all`:

```text
run_eval_period(simId, start, end, agents="dr-value,dr-momentum", windows="daily")
```

- `agents` accepts `"all"`, a comma-separated persona list, or an array.
- `windows` accepts `"all"`, `"daily"`, `"weekly"`, `"monthly"` (comma-separated).

Selecting 2 personas instead of 6 cuts the session count ~3×; pairing it with `windows="daily"` reduces the 3 rebalance windows to 1 for another ~3×. Nothing about the fold, the book, or scoring changes — only which streams run.

### 14.2 Dataset cache by `asOfTradeDate`

`buildDataset` (`packages/agent-orchestrator/src/dataset.ts`) caches the computed per-symbol universe under `<outDir>/.dataset-cache/<asOfTradeDate>.json`, keyed by decision date. A pinned replay rebuilds each date's dataset once per simulation; on the second and later builds the 49-symbol `fetchBars` loop is skipped and the cached universe is reused (`summary.cached === true`).

- **Pinned builds only.** The unpinned live path always rebuilds, because bars for the current trade date can still accrue within the day — caching it would silently serve a stale, partial universe.
- **Invalidation is a miss, never an error.** A bump to `DATASET_SCHEMA_VERSION`, an `asOfTradeDate` mismatch, or a changed `DEFAULT_UNIVERSE` fingerprint (sha256 of the serialized universe) all fall through to a fresh DB build. A corrupt cache file is a miss.
- **Escape hatch:** set env `DATASET_CACHE=off` or pass `useCache: false` to disable the read and the write.
- The per-round `rounds/<roundId>/dataset.json` is still written on every build, with a fresh `generatedAt` and its own `roundId` — it remains the round's source of truth for entry fills and validation.
- Writes are atomic (temp file + rename); any cache I/O failure is swallowed so a build can never fail because of the cache.

### 14.3 Verification

- `packages/agent-orchestrator`: **100/100** (tests include 8 dataset-cache cases), `tsc --build` exit 0.
- `apps/backend`: **188/188** unaffected (the added `cached` summary field is additive).
- `execute_lifecycle(action="verify")` SUCCESS on the `model_md-worktree-feat-portfolio-sim` worktree (job `01a14f0b-be6b-743a-923d-6cb3973f7f52`).

### 14.4 Beads

- `model_md-worktree-feat-portfolio-sim-2pc` — per-date dataset cache.
- `model_md-worktree-feat-portfolio-sim-8f2` — this documentation.

---

## 15. Prompt-set versioning, blind process judge, compare report

### Overview

Editing an analyst prompt and replaying a window used to leave no trail of which runs came from which prompt text. This section documents the three pieces that close that gap:

1. **Version stamping**: every analyst run persists a human label (`prompt_set_version`) and a sha256 digest (`prompt_hash`) of the prompt template it was built from.
2. **Blind process judge**: an LLM rubric scores each run's reasoning process, never its outcome, into `run_eval_scores`, one row per `(agent_run_id, judge_key, judge_version)`.
3. **Compare report**: `GET /api/portfolio/evals/report` groups runs by `(personaKey, promptSetVersion)` across replicates and a decide-date range, so one payload puts a v1 simulation and a v2 simulation side by side, with warnings when the sample is too small to mean anything.

### 15.1 The versioning recipe

**Where the constant lives.** `PROMPT_SET_VERSION` (currently `"v1"`) is the single exported constant in `packages/agent-orchestrator/src/promptVersion.ts`. One label covers the whole prompt set: the six persona mandates in `personas.ts` (their prose, not the per-window/per-book substitutions), the complete-book rule, the envelope schema text, the example envelope, and the assembly scaffolding in `buildAnalystPrompt` (section headers, separators, fixed instruction sentences).

**Cutting a new version.** Change the prompts, bump the constant from `"v1"` to `"v2"`, done. The label is coarse by design: it names the family, while the per-run hash pins the exact bytes an individual run saw.

**What the hash covers.** `buildAnalystPrompt` (`packages/agent-orchestrator/src/spawn.ts`) hashes the STATIC template from `buildPromptTemplate` through `hashPromptTemplate`: sha256 hex, 64 chars, utf8. The locked recipe:

- **Hashed**: the persona mandate with only `{{cadence}}` substituted (`{{holdings}}` stays literal, and cadence is a per-window template input), `COMPLETE_BOOK_RULE`, `ENVELOPE_SCHEMA_JSON`, the example envelope with its run-state pinned to canonical values (roundId `prompt-template`, portfolioValue `100000`, no exit line; persona and window identity come from the caller and count as template input), and the literal scaffolding strings both assemblies read.
- **Never hashed**: the volatile per-run inputs, meaning the holdings digest, `portfolioValue`, `roundId`, `simulationId`, `correctionHint`, and `asOfTradeDate`. The full prompt is the template with those sections interleaved back in.

Both assemblies read the same shared constants, so editing a literal there changes the prompt and its hash together.

**What gets persisted.** Only the digest and the label; the built prompt text is never stored. The stamps travel through the spawners (`spawnAnalyst` in `spawn.ts`, the docker runner in `apps/mcp-servers/mcp-portfolio-orchestrator/src/runner.ts`, and the orchestrator CLI in `cli.ts`) and land via `POST /api/portfolio/runs`, whose body carries `promptSetVersion` and `promptHash` as optional top-level fields beside the envelope (`parseRunInsertBody` in `apps/backend/src/routes/rounds.ts`: a present stamp must be a non-empty string, an absent one stores NULL). The carryover fold accepts the same optional stamps inside its one-transaction insert (`insertRunAndFold` in `apps/backend/src/portfolio/carryoverStore.ts`).

**Columns.** `agent_runs.prompt_set_version` (`varchar(40)`) and `agent_runs.prompt_hash` (`varchar(64)`), both nullable, in `packages/database/src/schema/portfolio.ts`; migration `packages/database/drizzle/0006_add_prompt_version_columns.sql`. Runs written before this feature existed keep NULL in both columns and group under a null `promptSetVersion` in the report.

**Drift detection.** Each report group carries `promptHashes`, the sorted distinct non-null digests among its runs. More than one entry means the group mixed template bytes: a bump or edit reached some runs but not others.

### 15.2 The blind process judge

Files: `apps/backend/src/evaluation/rubric.ts`, `scoreRun.ts`, `llmClient.ts`, `judgeBatch.ts`.

**Identity.** `judgeKey` is `"process"` (`PROCESS_JUDGE_KEY`) and `judgeVersion` is `"1"` (`RUBRIC_VERSION`), both defined in `rubric.ts` and persisted to `run_eval_scores.judge_key` and `run_eval_scores.judge_version`.

**The rubric.** Every score is an integer anchored 1 (worst) to 5 (best):

| id                           | name                       | question                                                                                                            |
| ---------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `c1_thesis_evidence_fit`     | Thesis-evidence fit        | Does each position's thesis bind to facts the analyst actually had at decision time?                                |
| `c2_internal_consistency`    | Internal consistency       | Do the rationale, the per-position theses, and the target weights agree, and is the complete-book rule honored?     |
| `c3_risk_logic_coherence`    | Risk-logic coherence       | Is the concentration, downside-risk, and rebalance-cadence reasoning sound and matched to the stated risk posture?  |
| `c4_position_sizing_logic`   | Position-sizing logic      | Do the target weights follow the analyst's own conviction ranking and relative magnitude?                           |
| `c5_macro_context_reasoning` | Macro-context reasoning    | Does the run engage the market regime and context for its window appropriately, without inventing facts?            |
| `overall`                    | Holistic reasoning quality | Given the five criteria, what single integer 1-5 best captures the overall quality of this run's reasoning process? |

On top of the six scores the judge writes a `verdict`: one short paragraph of 3 to 5 sentences that summarizes strengths and weaknesses, references criteria by id where useful, and judges only the reasoning process on the page. `validScores` (`rubric.ts`) accepts exactly the five criterion ids plus `overall`, each an integer 1-5, with no extra or missing keys.

**Blindness is a contract.** `buildBlindContext` (`scoreRun.ts`) assembles the judge input from an explicit whitelist only: `personaKey` (the `agentKey` up to its last `--`), `window`, `roundId`, `simulationId`, `asOfTradeDate`, `roundSeq`, `rationale`, and each position as `{symbol, targetWeight, thesis}`. No prices or OHLC, no fills, no PnL, no returns or equity curves, no benchmark or drawdown figures, no Sharpe or other risk metric, and no `decision_json` ever reach the judge; the theses already carry the evidence the analyst relied on. The system prompt states the same rule on the wire: the judge is shown no market outcomes, scores the quality of the reasoning process only, and must never speculate about how the decisions performed.

**Output handling.** The judge must answer with one JSON object shaped `{"scores": {...five criterion ids...}, "overall", "verdict"}`. `parseJudgeOutput` validates it and throws `JudgeOutputError` on anything malformed or off-rubric, and a throw persists nothing: the run comes back in the batch as `status: "error"` with the message.

**Idempotent batch semantics.** `run_eval_scores` carries a unique index on `(agent_run_id, judge_key, judge_version)` (migration `0007_add_run_eval_scores.sql`). Inside `runJudgeBatch` (`judgeBatch.ts`):

- A run already scored under the same `judgeKey` at the current `RUBRIC_VERSION` is skipped (`status: "skipped"`), so re-posting a batch is safe. Rows under an older rubric version do not count as scored and get re-scored at the current one.
- Scoring upserts with `onConflictDoUpdate` on that same triple, so `"force": true` deliberately overwrites the stored row.
- Runs are judged sequentially, because free-tier judge models rate-limit aggressively.
- Targets resolve through an INNER JOIN to `round_jobs`, which supplies the decide date; a run whose round was never booked is not addressable.
- Positions are loaded only for `{symbol, targetWeight, thesis}`, never their prices.

### 15.3 Endpoint reference

| Method | Path                          | Auth                                       | Request                                                                                                                                                                                                                                                                                     | Response                                                                                                                                                    | Status codes                                                                                                         |
| ------ | ----------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/portfolio/evals/judge`  | Supabase Bearer (`authMiddleware`)         | JSON body with exactly one of `simulationId` (must match `/^sim-[a-z0-9][a-z0-9-]{0,46}$/`) or `roundIds` (non-empty string array); optional `judgeKey` (non-empty, at most 64 chars, default `process`), `judgeModel` (non-empty, default `JUDGE_MODEL`), `force` (boolean, default false) | `{ judgeKey, judgeVersion, model, results: [{ runId, agentKey, status: "scored" \| "skipped" \| "error", error? }], summary: { scored, skipped, errors } }` | 200; 400 invalid JSON, body shape, or target; 503 missing key with `{ error, hint: "set JUDGE_API_KEY" }`; 500 other |
| GET    | `/api/portfolio/evals/report` | none (read-only, like the other eval GETs) | `simIds` required: comma-separated list of 1 to 10 unique simulation ids; `start` and `end` optional inclusive `YYYY-MM-DD` decide-date bounds (`start` must not be after `end`); `judgeKey` optional, default `process`                                                                    | `EvalReport` payload described below                                                                                                                        | 200; 400 missing/empty/invalid/duplicate/too-many `simIds`, malformed dates, or `start` after `end`; 500 `{ error }` |

**Judge response fields.** `judgeKey` and `judgeVersion` echo the effective keys, `model` is the judge model actually used, `results` is one entry per target run in insertion order (`runId` is the `agent_runs.id`), and `summary` counts the three statuses.

**Report response shape.** Loaded by `buildEvalReport` (`apps/backend/src/evaluation/report.ts`), assembled by the pure `assembleEvalReport` (`reportAggregates.ts`):

- `start`, `end`: the effective inclusive bounds actually applied. An omitted side defaults to the min or max decide date among matched runs; both are `null` only when nothing matched and neither was given.
- `judgeKey`, `simIds`: echoed back as processed.
- `groups[]`, sorted by `personaKey` then `promptSetVersion` (a null version sorts as an empty string). Each group holds:
  - `personaKey`, `promptSetVersion`: the group key. `personaKey` is the `agentKey` up to its last `--` (`personaKeyOf`).
  - `runs`, `scoredRuns`, `unscoredRuns`: matched runs, how many have a `run_eval_scores` row for the requested `judgeKey`, and the remainder.
  - `replicates`: distinct simulations among the group's runs. `tradingDays`: distinct round decide dates.
  - `promptHashes`: sorted distinct non-null digests, the drift check from §15.1.
  - `judge`: `{ judgeModels, criteria }` where `criteria` maps each of the five criterion ids plus `overall` to `{ mean, median, min, max }`, all `null` when nobody scored. Means are rounded to 4 decimals; rows whose JSONB fails `validScores` contribute nothing.
  - `windows`: `daily`, `weekly`, `monthly`, each `{ runs, replicates, metrics: { totalReturnPct, annualizedVolPct, sharpe, maxDrawdownPct, simCount } }`. The metric values are means across the group's replicate streams sliced to the effective range, `null` when no stream contributed; `simCount` counts the contributing streams.
  - `warnings`: the warning codes fired for this group.
- `warnings[]`: one entry per (group, code) as `{ group: { personaKey, promptSetVersion }, code, message }`.

When several `judgeVersion` rows exist for a run under the requested `judgeKey`, the report prefers `RUBRIC_VERSION`, else the highest version lexicographically (the unique index allows at most one row per triple, so the version alone decides). A run whose round has no decide date, or whose `simulation_id` is NULL, cannot be placed in the range or counted as a replicate, so it is dropped from the report.

**Warning codes:**

| code                 | fires when                             | message                                                            |
| -------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `replicates_lt_3`    | the group's distinct simulations < 3   | `replicates=<n> below 3: deltas below 3 replicates are noise`      |
| `trading_days_lt_20` | the group's distinct decide dates < 20 | `tradingDays=<n> below 20: deltas below 20 trading days are noise` |

**Mount order.** In `apps/backend/src/index.ts` the report app registers before `portfolioEvals`, because Hono matches registration order first and the static `/evals/report` path has to win over that app's `/evals/:simId` param route.

### 15.4 The compare loop

How to A/B two prompt versions end to end:

1. **Baseline.** Leave `PROMPT_SET_VERSION` at its current label, create a simulation (`POST /api/portfolio/simulations`), and replay a date window into it with the `run_eval_period` MCP tool (`simId`, `start`, `end`, plus the roster options; mechanics in §13.2). A reduced roster (`agents=`, `windows=`) keeps cost sane when the goal is prompt refinement (§14.1).
2. **Edit and bump.** Change the prompt set, then bump `PROMPT_SET_VERSION` to the next label.
3. **Candidate.** Create a second simulation with a fresh `simId` and replay the SAME window with the same roster. Use a fresh sim: the group key is the stamp on each run, so bumping mid-replay would split one simulation's runs across version groups.
4. **Judge both.** Call `POST /api/portfolio/evals/judge` with `{ "simulationId": "<sim-a>" }` and a Supabase Bearer token, then the same for sim B. Re-posting is safe because already-scored runs are skipped; pass `"force": true` only when a deliberate re-score is wanted.
5. **Compare.** `GET /api/portfolio/evals/report?simIds=sim-a,sim-b&start=<YYYY-MM-DD>&end=<YYYY-MM-DD>`. Groups arrive one per `(personaKey, promptSetVersion)`, so each persona's v1 and v2 rows sit next to each other: judge criterion means, per-window return and risk means across replicates, and the warning codes on each group.

**Low-n caveat.** `replicates` counts distinct simulations in a group and `tradingDays` counts distinct decide dates. One sim per version over a short window lands below both thresholds by construction, and the report says exactly that through `replicates_lt_3` and `trading_days_lt_20`: deltas at that size are noise. For a comparison worth trusting, run at least 3 fresh simulations per prompt version over a window spanning at least 20 decide dates before reading any score gap.

The judge compares process quality only. Window metrics in the same payload (returns, Sharpe, drawdown) are outcome numbers grouped alongside it, but the judge never sees them (§15.2), and the low-n rule applies to those deltas too.

### 15.5 Environment configuration

| Variable         | Default                                  | Role                                                                                                                                                                                                                                        |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JUDGE_API_KEY`  | (unset)                                  | OpenRouter-compatible chat-completions key. Absent or blank makes the judge route answer 503 (`{ error: "judge model API key not configured", hint: "set JUDGE_API_KEY" }`); the report route is unaffected and still serves stored scores. |
| `JUDGE_API_BASE` | `https://openrouter.ai/api/v1`           | Chat-completions base URL. The client posts to `<base>/chat/completions` with trailing slashes stripped.                                                                                                                                    |
| `JUDGE_MODEL`    | `nvidia/nemotron-3-super-120b-a12b:free` | Default judge model; a per-request `judgeModel` in the batch body overrides it.                                                                                                                                                             |

All three are read in `apps/backend/src/env.ts`. The feature stack (`infra/docker-compose.feature.yml`) passes `JUDGE_API_KEY=${OPENROUTER_API_KEY}` into the backend container, so the key itself comes from the host `.env` as `OPENROUTER_API_KEY`. `JUDGE_API_BASE` and `JUDGE_MODEL` are not set there, so their defaults apply.

Free-tier behavior: `llmClient.ts` calls at temperature 0 with `max_tokens` 4000, retries 429, 5xx, and network failures with 1s/3s/9s backoff that honors `Retry-After`, times each call out at 90 seconds, and gives up with a typed error carrying the last HTTP detail. The batch feeds runs to it one at a time for the same reason, and the rubric JSON is demanded through the prompt rather than a `response_format` parameter, because free-tier reasoning models do not consistently support structured-output parameters.

### 15.6 Beads

- `model_md-worktree-feat-portfolio-sim-85f`: DB, prompt_set_version and prompt_hash columns on agent_runs.
- `model_md-worktree-feat-portfolio-sim-a8w`: DB, run_eval_scores table.
- `model_md-worktree-feat-portfolio-sim-cjd`: orchestrator, PROMPT_SET_VERSION constant and prompt_hash threading.
- `model_md-worktree-feat-portfolio-sim-5uc`: backend, rubric v1, blind scoreRun, judge batch route.
- `model_md-worktree-feat-portfolio-sim-ijg`: backend, report aggregation with low-n warnings.
- `model_md-worktree-feat-portfolio-sim-176`: tests, hash stability, version threading, judge idempotency, blind context, report low-n.
- `model_md-worktree-feat-portfolio-sim-o7x`: this documentation.

Dependency chain: `85f` blocks `cjd`; `cjd` and `a8w` block `5uc`; `5uc` blocks `ijg`; `ijg` blocks `176`; `176` blocks `o7x`.
