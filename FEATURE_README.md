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

| Table                  | Purpose                                                                                                                          | Key constraints                                                                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_runs`           | One analyst subagent's decision per simulation round.                                                                            | Serial PK; unique index `agent_runs_round_id_agent_key_unique_idx` on `(round_id, agent_key)`; `replicate_of` self-reference for consistency replicas; `window` typed `daily`/`weekly`/`monthly`; `status` typed `pending`/`completed`/`failed` (default `completed`) |
| `portfolio_positions`  | One equal-weight pick per run, with the entry fill at decision-time close.                                                      | Serial PK; FK to `agent_runs.id` with `ON DELETE cascade`; unique index `portfolio_positions_agent_run_id_symbol_unique_idx` on `(agent_run_id, symbol)`; `shares` = `initialCapital × targetWeight / entryPrice` (fractional shares allowed) |

`agent_runs` carries the run identity and decision: `id`, `agent_key`, `persona`, `strategy`, `window`, `replicate_of`, `round_id`, `initial_capital`, `rationale`, `decision_json`, `status`, and timestamps. The performance metrics `current_value`, `total_return_pct`, `sharpe`, `max_drawdown_pct`, and `as_of_trade_date` are derived by the backend ranking engine from the equity series; they are never stored. `portfolio_positions` stores the entry fill: `id`, `run_id`, `symbol`, `target_weight`, `shares`, `entry_trade_date`, `entry_price`. The marks `name`, `latest_trade_date`, `latest_price`, `value`, and `unrealized_pnl_pct` are computed in the route layer from `daily_prices`.

Drizzle relations (`relations.ts`) wire `agent_runs → many portfolio_positions` and `portfolio_positions → one agent_runs`. The schema is exported from `packages/database/src/index.ts` alongside `users`, `notifications`, and the market-data tables.

#### Backend engine (`apps/backend/src/portfolio/`)

| Module        | Role                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`    | Wire types: `EquityPoint`, `RankingResult`, `REBALANCE_CADENCE` (daily=1, weekly=5, monthly=21), and `parseNumeric` (DB numeric strings parsed to JS numbers at the edge)                                                                                      |
| `valuation.ts`| `computeEquitySeries`: shares = `initialCapital × targetWeight / entryPrice`; `entryTradeDate` = the latest `trade_date`; `entryPrice` = that day's close; rebalance to equal target weights every Nth trading day (daily=1, weekly=5, monthly=21); total value preserved by construction |
| `ranking.ts`  | `computeRanking`: total-return-based ranking with Sharpe (mean/stdev × √252, rf=0) and max drawdown (negative %)                                                                                |
| `index.ts`    | `PortfolioEngine` orchestrator: read-only query helpers (`loadRunsForLeaderboard`, `loadRunById`, `loadPositionsForRuns`, `loadBarsForRuns`). The engine never writes; the orchestrator owns ingest |

Routes live in `apps/backend/src/routes/portfolio.ts`, mounted `.route("/portfolio", portfolioHandler)` in `apps/backend/src/index.ts`. The backend suite is 19/19 vitest tests passing, tsc clean.

---

### 10.3 API contract

Both routes are public reads (no auth), consistent with the market-data reads. Wire convention: portfolio values are computed numbers, so they go out as JSON numbers (unlike raw OHLC bars, which stay strings). The contract is frozen by gate `contract-portfolio-api`.

| Method | Path                          | Auth | Request                                        | Response                                                                                                                                                                                                                                                                                                                                 | Status codes                                                                                     |
| ------ | ----------------------------- | ---- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| GET    | `/api/portfolio/leaderboard`  | none | optional `?round=<id>`; default latest round   | array sorted DESC by `totalReturnPct`: `[{ runId, agentKey, persona, strategy, window, replicateOf, roundId, initialCapital, currentValue, totalReturnPct, sharpe, maxDrawdownPct, asOfTradeDate, status }]`                                                                                                                             | 200 (empty array when no completed runs)                                                          |
| GET    | `/api/portfolio/agents/:id`   | none | none                                           | `{ runId, agentKey, persona, strategy, window, replicateOf, roundId, initialCapital, currentValue, totalReturnPct, sharpe, maxDrawdownPct, asOfTradeDate, status, rationale, decisionJson, positions: [{ symbol, name, targetWeight, shares, entryTradeDate, entryPrice, latestTradeDate, latestPrice, value, unrealizedPnlPct }], equitySeries: [{ tradeDate, totalValue, returnPct, cash, holdingsValue }] }` | 200; 400 `{ error, hint }` bad id; 404 `{ error, hint }` missing or not completed                 |

Notes on the implementation (`apps/backend/src/routes/portfolio.ts`):

- The leaderboard only includes runs with `status = "completed"` and at least one position; the latest round is resolved by run `created_at`.
- `:id` must be a positive integer; anything else returns 400. A run that does not exist or is not `completed` returns 404.
- The equity series is derived on the fly from positions plus `daily_prices`; nothing is persisted per day.

---

### 10.4 Orchestrator (`packages/agent-orchestrator/`)

| Module        | Role                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `personas.ts` | Six Ph.D-level analyst personas (Dr. Value, Dr. Momentum, Dr. Contrarian, Dr. Macro, Dr. Compounder, Dr. Technical), each with a distinct methodology, risk stance, and rebalance window; prompts written to diverge                                          |
| `dataset.ts`  | Builds a self-contained `rounds/<roundId>/dataset.json` from `daily_prices`: per-symbol returns, volatility21d, RSI-14, SMAs, 52-week range, avg dollar volume. The analyst never touches the DB; dataset.json is the only truth                                  |
| `contract.ts` | The agent-decision contract: `DecisionEnvelope` (schemaVersion 1, roundId, agent, rationale, picks[5-10]) with `validateEnvelope` as the single gate; anything that passes is insertable and valuatable                                                          |
| `spawn.ts`    | Spawns each analyst headlessly via `opencode run --format json`, parses the NDJSON stdout stream, extracts the JSON envelope, validates it, and retries once with a correction hint on failure |
| `insert.ts`   | Inserts one validated envelope in a transaction: one `agent_runs` row plus one `portfolio_positions` row per pick with entry fills; `DuplicateRunError` on an existing `(roundId, agentKey)`    |
| `cli.ts` / `args.ts` | CLI entrypoint `pnpm agents:run -- --round <roundId>`; the only module that reads `process.env` / `process.argv`; pure arg parsing kept import-free for tests                                     |

Flow: build dataset → spawn agents (parallel, capped at `--max-parallel 3`) → validate → insert each → print a summary table. A multi-agent round is tracked as a swarm: epic `model_md-worktree-feat-portfolio-sim-dkq` wraps beads task ez8. The orchestrator suite is 54/54 vitest tests passing, tsc clean. Gate `contract-agent-decision`.

---

### 10.5 Frontend (`apps/frontend/src/components/portfolio/`)

| Component                  | Role                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PortfolioLeaderboard.tsx` | Ranked table (rank, agent, strategy, window, current value, total return, Sharpe, max drawdown, as-of); loading / empty / error+retry states; replica badge; row click drills into the run      |
| `PortfolioDetail.tsx`      | Agent card with stats, rationale, positions table, EquityChart, back link; friendly 400/404 errors rendered from `{ error, hint }`                                                                                                                             |
| `EquityChart.tsx`          | Hand-rolled SVG area/line chart, no chart dependencies; scales `returnPct` with a dashed zero line and gridlines                                                                                |
| `format.ts`                | `formatCurrency`, `formatPct`, `formatWindow` helpers                                                                                                                                                                                                          |

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
