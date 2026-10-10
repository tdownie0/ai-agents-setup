# Portfolio Carryover — Authoritative Design Spec

> Extracted verbatim from the Oracle architecture consultation.
> Lines 1-610 of the source were a divergent scratchpad draft and are DELIBERATELY EXCLUDED.
> If anything here contradicts a note you were given, THIS FILE WINS.

## Bottom line

Introduce a first-class **`simulations`** scope plus a **materialized, rebuildable per-stream book** (`agent_portfolio_state` + `portfolio_position_lots` + `portfolio_equity_daily`), and make **`agent_runs` a decision log rather than the book**. Order by a numeric `round_seq`, never by parsing the string id. Express sells as `targetWeight: 0` and make the envelope a **complete target book** — no `side`, no `quantity`. Remove the mechanical cadence re-snap from valuation; the window becomes _decision cadence_, not _auto-trade cadence_.

---

## 1. Round identity & naming

**Separate "simulation" from "round."** Carryover must be scoped, otherwise a replay of a historical day mutates a book that has already moved past it, and you cannot reset a run without deleting history. This is required by your own decision-2(c), not speculative.

- New `simulations` table; `round_jobs` gains `simulation_id` + `round_seq` (authoritative) + `advance_mode`.
- `agent_runs` denormalizes `simulation_id` + `round_seq` so per-stream reads need no join. **Invariant: they must always equal the `round_jobs` row. Both are written in the same transaction by the fold (§4), which is the single writer.**

**Naming**

| Field     | Convention                                          | Regex                                     |
| --------- | --------------------------------------------------- | ----------------------------------------- |
| `simId`   | `sim-baseline`                                      | `/^sim-[a-z0-9][a-z0-9-]{0,46}$/`         |
| `roundId` | `<simId>-<seq zero-padded 4>` → `sim-baseline-0001` | `/^sim-[a-z0-9][a-z0-9-]{0,46}-\d{4,6}$/` |

- Keep `ROUND_ID_PATTERN` (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/`) as the **dataset-dir safety** guard, unchanged — `rounds.test.ts:43` asserts `W1.A_2026-09-22` is valid. Apply the stricter `SIM_ROUND_ID_PATTERN` only on the new carryover create path.
- `rounds/<roundId>/dataset.json` stays exactly as-is; the dir name just becomes structured. Nothing in `datasetPathFor` changes.

**Ordering:** `ORDER BY round_seq`. Never parse the id. Concretely this is required — `loadRunsForLeaderboard` (`portfolio/index.ts:46`) orders by `desc(agentRuns.createdAt)`, and with 18 agents inserting concurrently `createdAt` is _insertion finish time_, so "latest round" is currently whichever agent finished last.

---

## 2. Rerun semantics

`asOfTradeDate` is `MAX(daily_prices.trade_date)` (`dataset.ts:273-282`) — a global max, so a same-day relaunch yields an identical decision date. All enforcement goes in the **backend** (`POST /portfolio/rounds/:roundId/job`); the MCP server keeps a thin pass-through. The DB unique index is the last line of defense, not the policy.

| Case                                      | Detection                                                                             | Action                                                                                                                             | Enforced in            |
| ----------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **(a)** duplicate launch, round in flight | `round_jobs` row exists, non-terminal                                                 | **409** (today's behavior, `roundJobs.ts:292-306`) — keep                                                                          | DB PK + route          |
| **(a')** duplicate launch, round finished | row exists, terminal                                                                  | **409** `ROUND_ALREADY_COMPLETE`                                                                                                   | Route                  |
| **(b)** intentional same-day re-decision  | row exists, terminal, `replace=true`                                                  | **200/201** — delete that round's `agent_runs` (cascade → positions) + its equity rows, then re-fold affected streams from round 1 | Route, one transaction |
| **(c)** replay/backfill of a past day     | `asOfTradeDate <= max(stream.last_trade_date)` for a selected stream, `replace=false` | **409** `OUT_OF_SEQUENCE` — the fold is forward-only; a back-dated round would emit equity out of order                            | Route                  |
| **(c')** replay as a clean experiment     | same, but a _different_ `simId`                                                       | **Allowed** — opens a fresh book, chain basis = current capital                                                                    | Route                  |
| **(d)** new day                           | `MAX(trade_date) > max(stream.last_trade_date)`                                       | **Allowed**                                                                                                                        | Route                  |

`replace` is safe because the fold is a **deterministic replay over `agent_runs` + `portfolio_positions` + `daily_prices`** — all in the DB. Rollback needs no snapshot table; it is a recompute. This is why I reject the snapshot-rollback design in §4.

---

## 3. Envelope v2 — sell representation

**Recommendation: `targetWeight: 0` for liquidation, `weight >= 0`, complete target book. No `side`, no `quantity`, no `delta`, no `trimFraction`.**

Why, against the actual code and prompts:

- `valuation.ts:139-151` already re-snaps shares to `targetWeight` on every boundary. The entire sizing path — validation, sum-to-1, share math, rebalance — is target-weight machinery. Switching to `side`/`quantity` discards it and adds share/cash math, rounding, and a new cash-solvency validation model.
- **Target weight already expresses a trim exactly.** "Halve JNJ" _is_ `targetWeight: jnjWeight / 2`. A `trimFraction` field adds a second sizing primitive the fold and engine must both honor, for zero added expressiveness.
- All six personas state "weights MUST sum to 1.0" and describe fully-invested books; `dr-macro` demands "at least 2 defensive and 2 cyclical names at all times." Keeping sum=1.0 preserves every prompt and the cadence math.
- Three personas already reference a book they were never shown (dr-value `:76`, dr-momentum `:108`, dr-compounder `:202`). The fix is showing them the book, not giving them new verbs.

**The one real gap — omission must not be ambiguous.** Today omission is a silent full reallocation; with a carried book that is dangerous (a model that forgets one name dumps it). Rule: **the envelope is a complete target book.** Any currently-held symbol absent from the envelope is a _validation error_ listing it.

**Weight-sum rule:** sum over `targetWeight > 0` entries ∈ `[0.99, 1.01]`, rounding preserved. Zero-weight entries contribute 0. That is the entire change.

```ts
export const DECISION_SCHEMA_VERSION = 2 as const;
export const MIN_PICKS = 5; // unchanged: counts BUYS only
export const MAX_PICKS = 10; // unchanged: buys only
export const WEIGHT_SUM_MIN = 0.99;
export const WEIGHT_SUM_MAX = 1.01;
export const TARGET_WEIGHT_MAX = 1;

export interface DecisionPosition {
  symbol: string;
  /** Target share of TOTAL portfolio value. 0 = liquidate entirely. */
  targetWeight: number;
  thesis: string;
}

/** One currently-held line, as the agent sees it. */
export interface DecisionHolding {
  symbol: string;
  shares: number;
  costBasis: number; // per-share average cost
  lastPrice: number;
  marketValue: number;
  weight: number; // current share of total value
  holdingDays: number;
  unrealizedPnlPct: number;
}

export interface DecisionAgent {
  agentKey: string;
  persona: string;
  strategy: string;
  window: DecisionWindow;
  /** Total value the target weights apply to (cash + holdings at asOf). */
  portfolioValue: number;
  cash: number;
  holdingsValue: number;
  /** null on a stream's first round. */
  priorRoundId: string | null;
  roundSeq: number;
  replicateOf?: string;
}

export interface DecisionEnvelopeV2 {
  schemaVersion: 2;
  roundId: string;
  simulationId: string;
  roundSeq: number;
  agent: DecisionAgent;
  rationale: string;
  /** COMPLETE target book: keep (>0) + explicit exits (===0). No omissions. */
  positions: DecisionPosition[];
}

export interface ValidateEnvelopeOptions {
  universe: readonly string[];
  /** Symbols with ≥1 bar as of the decision date — required for BUYS only. */
  symbolsWithPrice: ReadonlySet<string>;
  /** Symbols the stream currently holds. Drives the omission + sell checks. */
  heldSymbols: ReadonlySet<string>;
  expectedWindow?: DecisionWindow;
  /** Value the weights must sum against. Enables the cash-solvency check. */
  portfolioValue?: number;
  expectedSimulationId?: string;
  expectedRoundSeq?: number;
}
```

**Validation rules (v2)**

1. `schemaVersion === 2`.
2. `positions` is an array; no duplicate symbols (unchanged).
3. **Buys** (`targetWeight > 0`): count ∈ `[5, 10]`; `0 < w <= 1`; symbol ∈ universe; symbol ∈ `symbolsWithPrice`.
4. **Sells** (`targetWeight === 0`): unlimited count; symbol **must** be in `heldSymbols`; symbol **need not** be in `universe` or `symbolsWithPrice` — you must be able to exit a name that stopped trading or was delisted from the feed. This is a deliberate relaxation.
5. A symbol cannot appear twice, so "sell then rebuy" is just a new positive `targetWeight`.
6. `round(Σ targetWeight over buys, 6dp) ∈ [0.99, 1.01]`.
7. **Omission:** `heldSymbols \ {symbols in envelope}` must be empty, else error naming each omitted symbol.
8. `envelope.simulationId === expectedSimulationId` and `envelope.roundSeq === expectedRoundSeq` when supplied (anti-drift against the runner's bookkeeping).
9. `AGENT_KEY_PATTERN`, window pinning, `replicateOf` — all unchanged.

**Rename `picks` → `positions` and `weight` → `targetWeight` deliberately.** `picks` is factually wrong once exits exist, and `targetWeight` matches the existing `portfolio_positions.target_weight` column, removing a translation layer. Since `schemaVersion` is already a breaking bump, make the names honest rather than carrying a lie through a new contract.

**`initialCapital` → `portfolioValue`.** After round 1, "initial capital" is false. `agent_runs.initial_capital` will store the **per-decision portfolio value** the weights applied to; the chain basis lives on `agent_portfolio_state.initial_capital` (§4). This semantic shift is the reason the wire field must be renamed.

---

## 4. Persistence model

**Recommendation: (a) + (c), with the state table as a _materialized cache_ over a deterministic fold — not an authoritative ledger.**

Why not (b): `UNIQUE (agent_run_id, symbol)` makes a position structurally unable to span runs, and cash is not derivable per-run. (b) is impossible as stated.

Why not "authoritative lots": a `sellFraction`-free target-weight fold is fully deterministic from `agent_runs` + `portfolio_positions` + `daily_prices`. Authoritative mutable state would need its own reconciliation path. Making it a cache means **replace, delete, and re-fold are one code path** (`rebuildStream`) — they cannot diverge, and `replace` needs no snapshot table.

### Tables

```sql
-- 1. simulation scope
CREATE TABLE simulations (
  id             serial PRIMARY KEY,
  sim_id         varchar(64) NOT NULL UNIQUE,   -- /^sim-[a-z0-9][a-z0-9-]{0,46}$/
  label          text,
  initial_capital numeric(14,2) NOT NULL DEFAULT 100000,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- 2. round_jobs: add ordering + scope (nullable for backfill, then tightened)
ALTER TABLE round_jobs
  ADD COLUMN simulation_id varchar(64) REFERENCES simulations(sim_id) ON DELETE CASCADE,
  ADD COLUMN round_seq     integer,
  ADD COLUMN advance_mode  text NOT NULL DEFAULT 'carry',  -- 'fresh' | 'carry'
  ADD CONSTRAINT round_jobs_advance_mode_chk CHECK (advance_mode IN ('fresh','carry'));
CREATE UNIQUE INDEX round_jobs_simulation_round_seq_unique_idx
  ON round_jobs (simulation_id, round_seq);

-- 3. agent_runs: denormalized scope + ordering (self-describing, no join)
ALTER TABLE agent_runs
  ADD COLUMN simulation_id varchar(64) REFERENCES simulations(sim_id) ON DELETE CASCADE,
  ADD COLUMN round_seq integer;
CREATE INDEX agent_runs_stream_seq_idx ON agent_runs (simulation_id, agent_key, round_seq);

-- 4. the carried book — MATERIALIZED CACHE
CREATE TABLE agent_portfolio_state (
  id               serial PRIMARY KEY,
  simulation_id    varchar(64) NOT NULL REFERENCES simulations(sim_id) ON DELETE CASCADE,
  persona_key      varchar(120) NOT NULL,
  window           text NOT NULL,
  seq              integer NOT NULL,                    -- last applied round_seq
  last_trade_date  date NOT NULL,
  last_round_id    varchar(64),
  initial_capital  numeric(14,2) NOT NULL,              -- CHAIN basis, never changes
  cash             numeric(16,4) NOT NULL DEFAULT 0,
  holdings_value   numeric(18,4) NOT NULL DEFAULT 0,
  total_value      numeric(18,4) NOT NULL DEFAULT 0,
  target_json      jsonb,                               -- [{symbol,targetWeight}] in force
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_portfolio_state_stream_unique_idx UNIQUE (simulation_id, persona_key, window)
);

-- 5. open lots with cost basis surviving across runs
CREATE TABLE portfolio_position_lots (
  id                   serial PRIMARY KEY,
  state_id             integer NOT NULL REFERENCES agent_portfolio_state(id) ON DELETE CASCADE,
  symbol               varchar(16) NOT NULL,
  shares               numeric(18,6) NOT NULL DEFAULT 0,
  cost_basis           numeric(16,6) NOT NULL DEFAULT 0,  -- per-share avg, shares-weighted
  target_weight        numeric(7,6) NOT NULL DEFAULT 0,
  opened_from_round_id varchar(64) NOT NULL,
  opened_trade_date    date NOT NULL,
  last_trade_date      date,
  last_price           numeric(12,4),
  realized_pnl         numeric(16,4) NOT NULL DEFAULT 0,
  thesis               text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portfolio_position_lots_state_symbol_unique_idx UNIQUE (state_id, symbol)
);

-- 6. chain equity curve (materialized; makes the 18-stream board one cheap read)
CREATE TABLE portfolio_equity_daily (
  id             serial PRIMARY KEY,
  state_id       integer NOT NULL REFERENCES agent_portfolio_state(id) ON DELETE CASCADE,
  trade_date     date NOT NULL,
  cash           numeric(18,4) NOT NULL,
  holdings_value numeric(18,4) NOT NULL,
  total_value    numeric(18,4) NOT NULL,
  round_seq      integer,                                -- seq in force on this date
  CONSTRAINT portfolio_equity_daily_state_date_unique_idx UNIQUE (state_id, trade_date)
);
```

### The fold

Pure and DB-free in `apps/backend/src/portfolio/carryover.ts`, so `portfolio.test.ts` can cover it with inline fixtures. `insertRun` gains a `tx` parameter so insert + fold commit **atomically** — that is what prevents a run existing with the state un-advanced (which would otherwise deadlock a retry behind `DuplicateRunError`).

```ts
export interface OpeningBook {
  cash: number;
  shares: ReadonlyMap<string, number>; // carried in
  costBasis: ReadonlyMap<string, number>;
  targetWeights: ReadonlyMap<string, number>;
}

export interface ApplyDecisionInput {
  openingBook: OpeningBook;
  /** Chain basis for the round's entry valuation. */
  basisCapital: number;
  /** This round's COMPLETE target book (buys >0, exits ===0). */
  targets: ReadonlyArray<{ symbol: string; targetWeight: number }>;
  /** symbol → close on asOfTradeDate: both the mark AND the fill price. */
  prices: Readonly<Record<string, number>>;
  asOfTradeDate: string;
}

export interface ApplyDecisionResult {
  nextBook: OpeningBook;
  fills: ReadonlyArray<{
    symbol: string;
    side: "buy" | "sell" | "hold";
    shares: number;
    price: number;
    realizedPnl: number;
  }>;
  realizedPnl: number;
  totalValue: number;
}

export function applyDecision(input: ApplyDecisionInput): ApplyDecisionResult;
export function rebuildStream(input: {
  simulationId: string;
  personaKey: string;
  window: PortfolioWindow;
}): Promise<void>; // recompute from round 1
```

Semantics: mark the opening book at `asOfTradeDate` closes → `totalValue` → for each target, `targetShares = totalValue × targetWeight / price` → `deltaShares = targetShares − heldShares`; exiting names get `targetShares = 0` → full liquidation → proceeds to cash; new `costBasis` is shares-weighted average; a zero-delta line is a `hold` with **no** trade. No cash constraint can be violated because every target is a fraction of the same mark — which is the concrete payoff of target-weight over `side`/`quantity`.

---

## 5. Equity & ranking across the chain

**`computeEquitySeries` stays exactly as-is** (legacy single-segment) and `computeRanking(series)` keeps its current signature. Both are **additive-only**, so `portfolio.test.ts` passes untouched. Add:

```ts
export interface EngineSegment {
  roundId: string;
  roundSeq: number;
  /** First date to emit. For k>0 this is the trading day AFTER the prior segment's decide date. */
  openTradeDate: string;
  /** asOfTradeDate of this round; the decision applies at this date's close. */
  decideTradeDate: string;
  /** Chain-level starting capital. Identical across every segment. */
  basisCapital: number;
  window: PortfolioWindow;
  openingBook: OpeningBook;
  decisions: ReadonlyArray<{ symbol: string; targetWeight: number }>;
}

/** Continuous chain series: segments in roundSeq order, deduplicated by tradeDate. */
export function computeChainEquitySeries(
  segments: readonly EngineSegment[],
  barsBySymbol: BarsBySymbol,
): EquityPoint[];
```

Four concrete changes vs. today:

1. **`returnPct` denominator is `basisCapital`**, passed in explicitly. It is no longer re-derived per segment.
2. **Cash comes from `openingBook.cash`**, never from `initialCapital − Σ shares×entryPrice` (`valuation.ts:69-70`). Cash is a fold output, so it must be persisted; this is the change that kills the derived-cash assumption.
3. **The cadence re-snap at `valuation.ts:139-151` is removed.** Between decisions, shares and cash are fixed. That block is precisely what makes the system behave like a perpetual round-1 book — it re-imposes the first round's target weights forever, silently, forever. The agent now decides the book. **Between a decision and the next, the book drifts with the market; it is never mechanically re-snapped.**
4. **Cadence survives, redefined as a due-date signal** rather than an auto-trader. Keep `REBALANCE_CADENCE` exported (its test stays green) and add:

```ts
export function isDecisionDue(opts: {
  window: PortfolioWindow;
  tradingDaysSinceLastDecision: number; // null on a stream's first round → true
}): boolean; // >= REBALANCE_CADENCE[window]
```

This preserves the meaning of the window end-to-end (surfaced in the UI as "next review due") and stops the engine from trading without a decision.

**Ranking — the basis must be injected, not inferred.** `ranking.ts:29` uses `first.totalValue` as the basis, which is exactly right for one segment and exactly wrong for a concatenated chain (it resets return at every boundary). Overload to preserve the existing call shape:

```ts
export interface RankingInput {
  equitySeries: readonly EquityPoint[];
  /** Chain starting capital. Omit for a legacy single-round series. */
  basisCapital?: number;
}
export function computeRanking(input: RankingInput | readonly EquityPoint[]): RankingResult;
```

Omitted → `first.totalValue` (today's behavior, tests unaffected). Provided → chain basis. `totalReturnPct` uses the basis; sharpe/vol/drawdown already work off consecutive points and need no change **provided the segments are contiguous and date-deduplicated** — so `computeChainEquitySeries` must dedupe by `tradeDate` (last write wins) and segment _k_ must open the trading day after segment _k−1_'s decide date. Add a test that pins this.

Also: expose the already-computed `annualizedVolPct` on `LeaderboardRowWire`. Additive, non-breaking, and the board wants it.

---

## 6. Exposing 18 streams

**Yes — this requires the §4 state, decisively.** "Current positions for `dr-value--daily`" cannot be answered from `agent_runs` without folding 18 streams over all bars on every request.

**New routes** (mount under the existing `/api/portfolio`):

| Route                                                           | Returns                                                                                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /portfolio/simulations`                                    | sims + chain summary (round count, last trade date, stream count)                                                                                                                     |
| `GET /portfolio/simulations/:simId/streams`                     | **the 18-stream board** — one row per (persona, window): cash, holdings, total, `totalReturnPct` vs chain basis, sharpe, drawdown, positionCount, lastDecisionDate, `nextDecisionDue` |
| `GET /portfolio/simulations/:simId/streams/:personaKey/:window` | drilldown: open lots (shares, cost basis, target weight, unrealized P&L), equity series, ordered decision history                                                                     |
| `GET /portfolio/simulations/:simId/rounds`                      | rounds ordered by `roundSeq` (with the asOf/status of each)                                                                                                                           |

**Preserved, with corrected semantics:**

- `GET /leaderboard?sim=<simId>` → **new preferred** — all 18 streams' chain performance.
- `GET /leaderboard?round=<roundId>` → **unchanged** — a per-round snapshot. Different question, still valid.
- `GET /agents/:id` → **unchanged** — a single run's drilldown.
- Bare `GET /leaderboard` (no params) → keep working, but fix the selection: `ORDER BY round_seq DESC` via `round_jobs`, falling back to `createdAt` only when `round_seq IS NULL` (legacy rows). Strip `roundId` only if a `simId` is supplied.

These stay public (no auth), consistent with the existing portfolio/market-data reads. Flagging it rather than silently changing it: if this dashboard is meant to be private, that's a separate decision — the current surface is already public.

---

## 7. Agent day-advance policy

**Recommendation: reject, do not skip and do not re-decide.** With a carried book, a same-date re-decision is actively harmful:

- The dataset is `MAX(trade_date)`; a same-day round gets byte-identical input. The book is marked at the same close it just traded at, so the fold re-trades at stale prices.
- `roundSeq` advances and `holdingDays` resets to 0, destroying the one piece of state three personas' rules depend on (dr-momentum `:108` and dr-compounder `:202` are both _trend-flip_ rules — a flip is measured on **new bars**; on identical data nothing flips and nothing should change).
- Cost: 18 agents × up to 10 minutes for churn that carries no information.

**Rules**

1. A new round for `(simulationId, asOfTradeDate)` → **409** `SAME_TRADE_DATE` if any round for that pair is non-terminal; **409** `ROUND_ALREADY_COMPLETE` if terminal. Hint: `replace=true` for (b), or wait for new price data.
2. A new round advances the chain only when `MAX(daily_prices.trade_date) > max(stream.last_trade_date)` for every selected stream. Otherwise **409** `STALE_TRADE_DATE` with the current vs. required date — the single most useful error the user can get.
3. `takeover=true` (today's crash-recovery flag) **retains its meaning**: reset a _partially failed_ round for re-execution. `replace=true` is a _new_ flag: discard a _finished_ round's decisions and re-decide. Different jobs; do not conflate them.

**Window cadence is advisory, not a launch gate.** A round still runs all 18 agents, preserving the persona×window cross product that `orchestrator.test.ts:138` asserts. A `weekly` agent asked to decide daily now has the book in front of it, and `WINDOW_CADENCE.weekly` ("patience between reviews is part of the edge") is finally _expressible_ — it keeps its targets. That is a benefit of carryover, not a conflict. Cadence surfaces in the UI via `isDecisionDue` (§5).

---

## Build sequence

| #      | Work unit                                                                                                                                                                                                                                | Domain       | Depends on | Parallel |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------- | -------- |
| **W1** | Schema: `simulations`, `round_jobs`+`agent_runs` additions, `agent_portfolio_state`, `portfolio_position_lots`, `portfolio_equity_daily`; exports in `packages/database/src/index.ts`; `pnpm db:generate --name=add_portfolio_carryover` | DB           | —          | —        |
| **W2** | Envelope v2: `contract.ts` (types + rules 1-9), `ENVELOPE_SCHEMA_JSON`, `buildEnvelopeExample`, `buildAnalystPrompt` (**new HOLDINGS section**), personas.ts (`{{holdings}}` token)                                                      | Orchestrator | —          | ‖ W3     |
| **W3** | Engine: `applyDecision` / `rebuildStream` fold, `computeChainEquitySeries`, `isDecisionDue`, `computeRanking` overload — pure, no DB                                                                                                     | Backend      | —          | ‖ W2     |
| **W4** | Persistence + routes: atomic insert+fold, `simulations`/`streams`/`rounds` routes, leaderboard `round_seq` ordering, rerun policy (`replace`/`SAME_TRADE_DATE`/`STALE_TRADE_DATE`), `annualizedVolPct` on the wire                       | Backend      | W1, W3     | —        |
| **W5** | Orchestrator: pass holdings/`portfolioValue`/`cash`/`roundSeq` into spawn, `positions.length` for progress, expose `replace`, surface the 409s as actionable MCP text                                                                    | Orchestrator | W2, W4     | ‖ W6     |
| **W6** | Frontend: 18-stream board, positions table, equity sparkline, "next review due"                                                                                                                                                          | Frontend     | W4         | ‖ W5     |

Gate names: `schema-portfolio-carryover` → `contract-envelope-v2` + `engine-chain-equity` → `api-contract-streams` → done.

**Mandatory test edits** (v2 intentionally inverts two v1 assertions; everything else is additive):

| File                         | Change                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract.test.ts:249`       | `weight: 0` **must now PASS** → invert to an acceptance test; add sell-path tests (sell not in `symbolsWithPrice` → valid; sell of an unheld symbol → invalid) |
| `contract.test.ts:253`       | message becomes `"0 <= targetWeight <= 1"`; `1.5` still rejected                                                                                               |
| `contract.test.ts:374`       | `"schemaVersion must be 2"`                                                                                                                                    |
| `spawn.test.ts:48`           | `initialCapital=100000` → `portfolioValue=100000` (keep the `Pick 5–10 symbols` line verbatim — it stays in the prompt)                                        |
| `orchestrator.test.ts:51-69` | `VALID_ENVELOPE` → v2 shape; add `heldSymbols` to the spawner options                                                                                          |
| `portfolio.test.ts`          | **unchanged** — additive-only engine                                                                                                                           |
| `rounds.test.ts`             | **unchanged** — `RunStatusWire` gains fields only, and it asserts fields individually                                                                          |

**Effort: Large (3d+).** W1+W2+W3 in parallel is ~1.5-2d; W4 is the critical path at ~1d.

---

## Uncertainties and what would resolve them

1. **Existing dev rows.** `agent_runs`/`portfolio_positions`/`round_jobs` are populated in the dev DB. The nullable→tighten migration needs a backfill. `pnpm db:reset` exists and this is a feature worktree — **I'd default to a reset**, not a backfill. Resolve by asking whether the 6 existing `rounds/*` dirs hold anything worth keeping.
2. **Is per-stream cadence gating wanted?** I chose "all 18 run every round; cadence is advisory." If the intent is that a `weekly` stream should _skip_ a daily round, that is a different design (agents that no-op, per-stream `nextDueSeq`) and roughly doubles W4. Resolve by confirming "a round is a global time step" is the intent.
3. **Frontend scope.** `apps/frontend/src` has **no** portfolio UI today (no leaderboard/portfolio references), so W6 is net-new rather than an extension. Confirm it's in this pass.
4. **Pre-existing bias, now compounding.** Fills are at the same close used to compute the signal (`insert.ts:128`, `entryPrice` = `asOfTradeDate` close), so a decision is filled at a close it could only have observed after that close closed. Mildly optimistic, pre-existing, and it compounds over many rounds. Not introduced here — worth a footnote in `FEATURE_README.md`, not a redesign.
5. **No transaction costs.** Zero-cost re-snapping slightly flatters everyone and is now more visible as agents trade more often. Explicitly out of scope; flag it rather than model it.

**Optional future consideration (not in this pass):** the `latestPrice` vs. `equitySeries` post-`asOfTradeDate` inconsistency in `AgentDetailWire` (`routes/portfolio.ts:207-228`) disappears naturally once positions come from lots priced at `last_trade_date` — verify it does, don't fix it separately.

---

## RESOLVED DECISIONS (user-confirmed — these CLOSE the Uncertainties section above)

**R1 — Per-stream cadence gating: REJECTED. All 18 streams decide on every round.**
Cadence is advisory metadata surfaced in the UI via `isDecisionDue()` ("next review due").
This preserves the persona x window cross product asserted by `orchestrator.test.ts:138`.
Do NOT implement per-stream skipping, `nextDueSeq`, or no-op agents. W4 stays ~1d.

**R2 — Frontend scope: IN SCOPE, and it is an EXTENSION, not net-new.**
An existing portfolio UI lives in the worktree at `apps/frontend/src/components/portfolio`.
Oracle's "no portfolio UI today" finding was WRONG: it inspected the main repo
(`/app/model_md`) instead of the worktree. W6 must extend the components already there and
follow their established conventions. Do not invent a parallel UI.

**R3 — Existing dev data: DISCARD. The dev DB will be reset.**
`pnpm db:reset` in this worktree. Legacy `agent_runs` / `portfolio_positions` / `round_jobs`
rows come from the stateless architecture being replaced and have no carryover meaning.
Therefore: do NOT write a backfill. Migration may go straight to the final constraints.

**R4 — Error codes, precisely (the four are adjacent but distinct):**

- `ROUND_ALREADY_COMPLETE` — a round for this (simulationId, asOfTradeDate) exists and is terminal.
- `SAME_TRADE_DATE` — a round for this (simulationId, asOfTradeDate) exists and is non-terminal.
- `STALE_TRADE_DATE` — no new price data: `MAX(daily_prices.trade_date) <= max(stream.last_trade_date)`. Response MUST include current vs required date.
- `OUT_OF_SEQUENCE` — back-dated round: `asOfTradeDate <= max(stream.last_trade_date)` with `replace=false`.

**R5 — Atomicity (load-bearing, from the discarded scratchpad but ADOPTED into the final answer):**
`insertRun` MUST gain an optional `tx` parameter so that run-insert and the state fold commit
in ONE transaction. Without this, a partial failure leaves the run inserted but the state
un-advanced, and any retry deadlocks behind `DuplicateRunError`. The fold is the single writer.
The `rebuildStreams` self-heal read path was explicitly DROPPED — do not implement it.

**R6 — Denormalization invariant:**
`agent_runs.simulation_id` and `agent_runs.round_seq` MUST always equal the values on the
corresponding `round_jobs` row. Both are written in the same transaction by the fold.
`simulations.sim_id` + `round_jobs.round_seq` is authoritative. Also: do NOT add an FK from
`agent_runs.round_id` to `round_jobs` (legacy rows would break).

**R7 — The legacy single-segment engine is FROZEN. Add a parallel chain path instead.**
An earlier plan proposed editing `valuation.ts` to remove the per-candle re-snap. That is REJECTED.
`apps/backend/src/portfolio/valuation.ts` is byte-immutable, and so is `portfolio.test.ts`
(sha256 `dd75109efc784b99321e98526863677b972e385394218af745a6975160026a18`). Legacy
`computeEquitySeries` keeps its cadence re-snap because those 19 tests exercise it.
The new behaviour lives in `carryover.ts` as `computeChainEquitySeries`, which never re-snaps:
between decisions, shares and cash are held FIXED and only the mark moves, with the same
forward-fill technique for halted symbols. Two engines coexist; do not unify them.

**R8 — File ownership (strict, to avoid merge conflicts):**

- W3 owns and has SHIPPED `apps/backend/src/portfolio/carryover.ts`, `ranking.ts`, and
  `carryover.test.ts`. They are imports, not edit targets.
- W4 owns all DB-facing code: routes, the atomic insert+fold transaction, and the `rebuildStream`
  DB wrapper around `replaySegmentChain`.
- W2 owns and has SHIPPED the orchestrator's validation layer (80/80 green).
- W6 owns the frontend exclusively.
  Editing another wave's file is a merge conflict, not a contribution.

**R9 — W4 OWNS `insert.ts`. The earlier "do not touch the orchestrator package" line was WRONG.**
The W4 brief contained two instructions that cannot both hold: "make `insertRun` accept a `tx`"
(which requires editing `packages/agent-orchestrator/src/insert.ts`) and "do NOT touch the
orchestrator package". The second was a manager error. Resolution: W4 MAY and MUST edit
`insert.ts` to satisfy R5. Every other orchestrator file stays off-limits to W4.

**R10 — THE INSERT SEAM IS CURRENTLY UNWIRED. Do NOT add NOT NULL before fixing it.**
As shipped by W2, `insert.ts` writes NONE of the carryover columns. `grep -c simulationId` and
`grep -c roundSeq` in `src/insert.ts` both return 0, and the `agentRuns.values()` block at
`insert.ts:113` writes only `roundId, agentKey, persona, strategy, window, initialCapital, status,
rationale, decisionJson, replicateOf, startedAt, completedAt`. That insert is the ONLY source writer
of `agent_runs` in the repo.
W4 MUST write BOTH `simulationId` and `roundSeq` on that insert, sourced from the runner's booking,
making R6 true in code rather than merely in a comment.
This defect is invisible to static analysis: W1 left both columns nullable, so the Drizzle
`values()` type does not require them. `tsc` stays green and `db:check` passes. The failure is at
RUNTIME — every `insertRun` throws a not-null violation and the feature dies on first write.
Reassurance: `packages/database/scripts/reset.ts` runs `DROP SCHEMA public CASCADE`, so a freshly
initialized DB holds zero `agent_runs` rows and the NOT NULL constraint applies cleanly. It fails
only against a DB that already contains runs, so sequence the migration AFTER reset.

**R11 — Two known latent defects found in review. Do not silently propagate them.**
(a) `roundSeq` exists TWICE in the envelope — `contract.ts:98` (top level) and `contract.ts:106`
(inside `agent`). Validation checks each independently but NEVER cross-checks that they are equal,
so an agent echoing `5` at top level and `3` inside `agent` passes validation silently. The fold
MUST read `roundSeq` from ONE authoritative source and reject on mismatch.
(b) RESOLVED — NOT A DEFECT. W2 miscounted its own deviation: the `{{holdings}}` token is present in
only 2 of 6 personas (`dr-momentum` line 110, `dr-compounder` line 205), not "2 of 3". W2 also
justified omitting it from `dr-value` because `spawn.test.ts` asserts that prompt verbatim. That
justification is still wrong in principle — a test asserting current behaviour is not a constraint,
and if a test blocks a spec requirement the test is what changes. But the FUNCTIONAL concern is
moot, and the manager has now verified it rather than passing it downstream as a risk:
`spawn.ts:265-269` substitutes the token only where a persona body contains it, while
`spawn.ts:286-288` appends a `HOLDINGS` section UNCONDITIONALLY to every prompt. Both renderers are
empty-safe: `holdings.ts:66-72` emits an explicit "this stream holds no positions ... you hold
nothing, therefore you omit nothing" message for round 1, and `holdings.ts:98-100` does the same for
the digest. All 6 personas therefore receive the carried book, and the round-1 case — which is the
case for all 18 streams at the start of a simulation — is handled explicitly.
W5 does NOT need to re-verify this. The token is a persona-mandate digest, not the delivery channel.
