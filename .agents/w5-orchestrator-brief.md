# W5 Brief — Carryover state threading in the PRODUCTION runner

**Bead:** `model_md-worktree-feat-portfolio-sim-800.5` · **Blocked by:** W4 (routes must exist first)

## ⚠️ AN EARLIER DRAFT OF THIS BRIEF WAS WRONG — TWO CORRECTIONS

1. It said to thread state through `packages/agent-orchestrator/src/cli.ts`. **Wrong file.**
   `cli.ts` is a deliberately STATELESS standalone CLI: `cli.ts:202` passes `heldSymbols: EMPTY_BOOK`
   with the comment "This CLI opens a fresh book every round... The carryover runner passes the
   real book." Do not change `cli.ts`. It is correct as written.
2. It claimed the runtime is `pnpm`. **It is `bun`** (`bun` / `bunx` on PATH; no `node`/`pnpm`).

**The real carryover runner is `apps/mcp-servers/mcp-portfolio-orchestrator/` — a separate
package. That is YOUR domain.**

## FILE OWNERSHIP

- **YOU own** `apps/mcp-servers/mcp-portfolio-orchestrator/src/**` + its tests.
- **W4 owns** `apps/backend/src/routes/**`, the schema, and `packages/agent-orchestrator/src/insert.ts`.
  You consume W4's HTTP routes; do not edit his files.
- **W2 owns, CLOSED** the validation layer in `packages/agent-orchestrator/src/` (`contract.ts`,
  `contractRules.ts`, `personas.ts`, `holdings.ts`). 80/80 green. Do not edit; import from it.
- `packages/agent-orchestrator/src/spawn.ts` — you may need to thread opts through
  `buildAnalystPrompt`. Never alter validation semantics.

## READ FIRST

1. `.agents/portfolio-carryover-spec.md` — R1, R5, R6, R7, R9, R11.
2. `.agents/carryover-export-surface.md` — real export names.
3. W4's `api-contract-streams` note on bead `.4` — routes + error codes.

---

## FINDING A — BLOCKER: `runner.ts:136` reads a field that does not exist

```ts
picks: spawned.envelope.picks.length,   // runner.ts:136
```

`picks` was RENAMED to `positions` (`contract.ts:26`, `contract.ts:110`:
`positions: DecisionPosition[]`). Compiler: `TS2339: Property 'picks' does not exist on type
'DecisionEnvelope'`. `undefined.length` throws at runtime on every successful run — AFTER the run
is already inserted — so the DB write succeeds and the progress write dies.
**Fix: use `positions`.** Note `index.ts:228` (`picks: agent.picks`) is CORRECT — it reads the
store's own progress counter, which legitimately is `picks: number | null` (`roundStore.ts:39`).
Only `runner.ts:136` is wrong.

## FINDING B — BLOCKER: `spawnViaDocker.ts:179` passes a field the prompt builder does not have

```ts
buildAnalystPrompt({ ..., initialCapital: opts.initialCapital, ... })   // spawnViaDocker.ts:179
```

Compiler: `TS2353: Object literal may only specify known properties, and 'initialCapital' does not
exist in type 'BuildAnalystPromptOptions'`. The prompt builder takes **`portfolioValue`**
(`spawn.ts:213`), not `initialCapital`. So `portfolioValue` is `undefined` inside
`buildAnalystPrompt`, and the prompt renders `portfolioValue=undefined` and an all-cash book
(`money(portfolioValue)` at `spawn.ts:70`).
Also never passed through this seam: `holdings`, `cash`, `holdingsValue`, `roundSeq`,
`priorRoundId`, `simulationId`. `buildAnalystPrompt` already renders all of them — you SUPPLY
them, you do not re-implement the renderer.

## FINDING C — BLOCKER, MOST DANGEROUS: validation is called without `heldSymbols`

```ts
validateEnvelope(parsed, { universe, symbolsWithPrice, expectedWindow }); // spawnViaDocker.ts:214
```

Compiler: `TS2345` — `Property 'heldSymbols' is missing ... but required in type
'ValidateEnvelopeOptions'`. `heldSymbols` is REQUIRED and explicitly non-optional
(`contract.ts:126`: "REQUIRED, not optional: it drives both the sell-membership check and the
omission check"). **This silently disables the two checks that make carryover safe** — an agent
could sell a symbol it does not hold, or silently omit a holding (i.e. liquidate it by forgetting).
Fix this before anything cosmetic.

## FINDING D — BLOCKER: the spawn call omits `heldSymbols` too

`runner.ts:115` calls the spawner without `heldSymbols`. Compiler: `TS2345` — required in
`SpawnViaDockerOptions`. This is the call site where the carried book must be supplied.

## FINDING E — STRUCTURAL: this package has NEVER been typechecked. That is why A–D survived.

Three independent gaps, all confirmed empirically:

1. `package.json` has only `build` (esbuild, which **strips** types without checking) and `test`
   (vitest). No `typecheck` script.
2. Root `tsconfig.json` `references` = backend, frontend, mcp-database-service, database.
   **This package is absent**, so root `typecheck` never builds it.
3. The package's own `tsconfig.json` sets `rootDir: ./src` but `include`s `tests/**/*`, so
   `bunx tsc --noEmit -p tsconfig.json` dies with `TS6059` **before checking a single line**.

Net effect: **13 type errors, zero type safety, shipped green.** Measured with a temporary probe
config (`rootDir: "."`, `composite: false`) — 4 root causes in `src/`, the remaining 9 are the same
two causes repeated across 6 call sites in `tests/orchestrator.test.ts`.
**Deliverable: make typechecking real and permanent** — fix the `rootDir`/`include` conflict, add
`"typecheck": "tsc --noEmit -p tsconfig.json"`, and add the package to root `references`. A package
with no typecheck cannot be trusted to be type-correct.

Why the test suite stayed green: `runAgents` takes an injectable `deps.spawn` (`runner.ts:42,54`),
and the tests exercise the spawner with a fake `exec` — so the real `.picks` line never runs in
tests. The tests **encode the same bugs** (`orchestrator.test.ts:640` repeats `envelope.picks`).
Fixing the source without fixing the tests will leave you red; fix both.

---

## DELIVERABLES

### 1. Thread carried state (the actual feature)

For each of the 18 streams (6 personas × 3 windows), load the carried book and pass it into the
agent invocation. Required at `runner.ts:115` and threaded through `spawnViaDocker.ts`:

- `heldSymbols` — REQUIRED; drives sell-membership + complete-book omission checks.
- `holdings` — symbol, shares, costBasis, lastPrice, marketValue, weight, holdingDays,
  unrealizedPnlPct (matches `DecisionHolding` in `holdings.ts`).
- `portfolioValue`, `cash`, `holdingsValue`, `roundSeq`, `priorRoundId` (`null` on a stream's
  first round), `simulationId`.
  Source from W4's streams API. `buildAnalystPrompt` already renders all of these.

### 2. One authoritative `roundSeq` (R11a)

`roundSeq` exists twice — `contract.ts:98` (top level) and `contract.ts:106` (inside `agent`) —
and **nothing cross-checks equality**. `contract.ts:202-206` checks the top level against
`expectedRoundSeq`; `contractRules.ts:100` only checks the inner is a positive integer. An agent
echoing `5` above and `3` inside passes silently. Send ONE authoritative value; make both agree.

### 3. Cadence is advisory (R1, user-confirmed)

All 18 streams decide EVERY round. No skipping, no `nextDueSeq`, no no-op agents.
`maxParallel` 3. Surface cadence only via `isDecisionDue`.

### 4. Rerun flags — thin pass-through only

All enforcement lives in W4's route. `takeover=true` KEEPS its meaning (reset a partially failed
round). `replace=true` is NEW/separate (discard a finished round and re-decide). Do not conflate.
Surface W4's 409s as ACTIONABLE text; the four codes are distinct (R4) and must not collapse:
`ROUND_ALREADY_COMPLETE`, `SAME_TRADE_DATE`, `STALE_TRADE_DATE` (include current vs required date),
`OUT_OF_SEQUENCE`.

### 5. Do not fabricate state on the write path

`runner.ts:130` posts only `{ envelope }` to `/api/portfolio/runs`. W4 owns that contract —
coordinate via the bead. Do not invent `simulationId`/`roundSeq` client-side; they must come from
the runner's booking (R6).

## CONSTRAINTS

- No `as any`, no `@ts-ignore`, no `@ts-expect-error`. Deleting the `heldSymbols` requirement to
  make tsc pass is a REGRESSION, not a fix — it re-disables Finding C.
- Do not touch `apps/backend` or `packages/database` (W4's) or `apps/frontend` (W6's).
- Do NOT hand-edit `packages/database/drizzle/`.
- Do NOT commit to git. Do not create a worktree or run docker.

## VERIFY BEFORE CLOSING (runtime is `bun`, not pnpm)

- `cd apps/mcp-servers/mcp-portfolio-orchestrator && bunx tsc --noEmit -p tsconfig.json` — must be
  CLEAN, and you must have made that command possible (Finding E). Zero errors, not "fewer".
- `bun test` in that package — green, with NEW tests: carried state reaches the prompt,
  `heldSymbols` is passed, `positions.length` (not `picks`), and validation rejects selling an
  unheld symbol. Update the 6 stale `orchestrator.test.ts` call sites.
- `bunx oxlint` / `bunx oxfmt --check` clean on changed files.
- Confirm from the repo root that `bunx tsc --build` (root `typecheck`) now includes this package.
- Close the bead with a reason stating: the 13 errors you cleared, and anything tsc found beyond A–E.
