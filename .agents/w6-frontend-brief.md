# W6 Brief — Frontend: carryover state in the existing portfolio UI

**Bead:** `model_md-worktree-feat-portfolio-sim-800.6` · **Blocked by:** W4 (routes must exist first)
**Domain:** `apps/frontend` ONLY. This is an EXTENSION of existing UI (R2), not a net-new app.

Oracle's "no portfolio UI today" was WRONG — it read the main repo (`/app/model_md`), not this
worktree. The UI already exists and already follows conventions. Extend it.

## READ FIRST, in this order
1. `.agents/portfolio-ui-inventory.md` — the source of truth for what already renders, and its
   confirmed gaps. Do not re-invent what is there.
2. `.agents/portfolio-carryover-spec.md` — R1 (cadence advisory), R2 (extension), R4 (error codes).
3. `.agents/carryover-export-surface.md` — the real response field names.
4. W4's actual landed code in `apps/backend/src/routes/portfolio.ts` (see CONTRACT RISK below).
5. `apps/frontend/AGENTS.md` — the RPC client pattern is MANDATORY.

## CRITICAL CONTRACT RISK — read before writing any component
`src/lib/api.ts:18-21` already infers frontend types straight off the backend:
```ts
export type ApiLeaderboardRow = InferResponseType<typeof client.api.portfolio.leaderboard.$get>;
export type ApiAgentDetail  = InferResponseType<typeof client.api.portfolio.agents[":id"]["$get"]>;
```
Those are type-level dependencies on W4's route signatures. W4 is editing that same file RIGHT NOW.
Therefore:
- **Read W4's landed `portfolio.ts` before you write components.** Use `InferResponseType` for all
  new types so they track `AppType` automatically. Never hand-write a wire type — it will silently
  drift and `hc<AppType>` will not catch it.
- If W4 changed an existing route's response shape, you MUST update the consumers
  (`PortfolioLeaderboard.tsx`, `PortfolioDetail.tsx`) in the same pass. Do not leave the build red.
- Do not fork a second `hc<AppType>`. Import the singleton from `@/lib/api`. `getAuthHeaders()`
  supplies the Bearer token per request.

## THE HEADLINE GAP (R1 user-confirmed)
The UI's mental model is "one leaderboard row per agent run." It is now **18 concurrent streams**
(6 personas × 3 windows: daily / weekly / monthly) in ONE simulation, each with carried state. So:
- Show the simulation as a unit — a stream grid keyed by `(personaKey, window)`, not a flat run list.
- **Cadence is advisory only.** All 18 streams decide EVERY round. There is no skipping and no
  `nextDueSeq`. Surface "next review due" as metadata via `isDecisionDue` — never as a way to
  explain why a stream is idle. A stale-looking stream means a real gap, not a scheduled skip.
- Per stream, surface carried state: open positions with lots (shares, cost basis, last price, age,
  unrealized P&L), cash, and portfolio value.
- Equity: carry forward between decisions. `EquityChart.tsx` is a hand-rolled SVG — extend it, and
  do NOT add a charting dependency. Chain-forward-fill for halted symbols; the between-decision
  path does not re-snap.

## ERROR SURFACING (R4)
The four 409 codes are distinct. Surface each with what the user should do NEXT, not raw text:
- `ROUND_ALREADY_COMPLETE` — a round for this (simulationId, asOfTradeDate) is done → offer re-decide (`replace=true`).
- `SAME_TRADE_DATE` — one is in flight → tell them to wait, not to retry blindly.
- `STALE_TRADE_DATE` — no new price data → show **current vs required** date (the API returns both).
- `OUT_OF_SEQUENCE` — back-dated → explain ordering; `replace=false` was the choice.
If the backend ever collapses two of these into one, that is a W4 bug — report it, don't paper over it.

## CONSTRAINTS (all user-confirmed)
- **No** router, **no** polling, **no** new test runner, **no** chart dependency.
  Match the existing pattern in `App.tsx`: `view` state + `selectedRunId` drilldown. Refresh on demand.
- No `as any`, no `@ts-ignore`, no `@ts-expect-error`.
- Do not touch `packages/database` or `apps/backend` (W4's domains).
- Do NOT commit to git. Do not create a worktree or run docker.

## VERIFY BEFORE CLOSING
- `pnpm --filter @model_md/frontend build` — must pass.
- `pnpm -w lint` (oxlint) and `pnpm -w fmt:check` (oxfmt) — clean.
- `lsp_diagnostics` clean on every file you changed.
- Close the bead with a reason, then `bd note` the exact components added/extended.
