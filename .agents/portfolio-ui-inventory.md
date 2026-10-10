# Portfolio UI Inventory — W6 briefing source of truth

Gathered from the WORKTREE only. Oracle's "no portfolio UI" finding was WRONG (it read the main repo).
Worktree: /app/worktrees/model_md-worktree-feat-portfolio-sim

## Existing files (W6 EXTENDS these; it is NOT net-new)

- src/components/portfolio/PortfolioLeaderboard.tsx (179) — props { onSelectRun: (runId:number)=>void }, self-fetching
- src/components/portfolio/PortfolioDetail.tsx (283) — props { runId:number; onBack:()=>void }, self-fetching
- src/components/portfolio/EquityChart.tsx (122) — PURE presentational, props { series, className? }, hand-rolled SVG 600x220
- src/components/portfolio/format.ts (17) — formatCurrency / formatPct(value, withSign?) / formatWindow
- src/lib/api.ts (30) — derives ApiLeaderboardRow + ApiAgentDetail via InferResponseType
- src/App.tsx (115) — useState<View>("portfolio"|"users") default "portfolio"; selectedRunId: number|null; NO router
- src/components/ui/{table,card,button}.tsx — shadcn new-york, slate base, lucide icons

## Conventions that MUST be followed (verified, not guessed)

- Plain React hooks. NO state library, NO TanStack Query.
- Import { client } from "@/lib/api". DO NOT pass getAuthHeaders() — portfolio routes are PUBLIC.
- Fetch-once in useEffect with a `cancelled` cleanup flag. NO polling anywhere; refresh is a manual Button.
- Parent owns selection state; child owns fetching; onSelectRun / onBack callbacks.
- cn() for every conditional class. NEVER hardcode a class string conditionally.
- tabular-nums on EVERY number. text-right on numeric TableHead + TableCell.
- P&L colors: text-emerald-600 / text-red-600 in tables; emerald-500/red-500 in SVG.
- Secondary text: text-muted-foreground. Sizes step text-xs -> text-sm -> text-lg/xl.
- Panels: rounded-lg border bg-muted/30 p-3 (stats) | rounded-md border (table) | Card.
- Space sections with space-y-6 (detail) / space-y-4 (leaderboard). Icons h-4 w-4.
- Empty states: centered, text-sm text-muted-foreground.
- Reuse the Stat tile pattern (PortfolioDetail.tsx:38-53) for per-stream KPIs.
- Reuse format.ts for ALL number formatting. Do not duplicate formatters.

## Verified ABSENT (do not assume, do not add a dependency for these)

- NO chart library (no recharts/d3/plotly/victory/nivo/visx). EquityChart is hand-rolled SVG.
- NO router library. Extend the View union + nullable-id pattern instead.
- NO test runner, NO test script, NO component tests. Frontend package.json scripts: dev, build, lint, preview.
  => W6 quality gate is `pnpm -w lint` + `pnpm --filter @model_md/frontend build`. Tests are NOT required.
- NO src/hooks/. No ui/select.tsx, ui/badge.tsx, ui/tabs.tsx, ui/dialog.tsx.
- EquityChart has NO compact/sparkline mode. An 18-up sparkline needs a new mode added to it.

## Already exists vs. genuinely missing (vs the 18-stream requirement)

EXISTS: sharpe, max drawdown, total return, current value, asOfTradeDate, persona, agentKey,
strategy, window, positions table (9 cols), equity area chart, position count as a
"{n} holdings" card description only.
MISSING: the 18-stream board itself; rendered per-stream cash/holdings/total (fields exist on
EquityPointWire as cash/holdingsValue/totalValue but NO component reads them);
position count as a column; a sparkline; last decision date; next review due;
open lots; polling.

## API consumed today

- client.api.portfolio.leaderboard.$get({}) -> ApiLeaderboardRow[]
- client.api.portfolio.agents[":id"].$get({param:{id}}) -> ApiAgentDetail
  NOTE: /api/portfolio is a SHARED mount: portfolioHandler + roundsHandler + roundJobsHandler are all
  mounted on that prefix in apps/backend/src/index.ts. Beware prefix collisions when adding routes.

## Rejected scope (do not build)

- Do NOT add a test runner to the frontend. Out of scope; the repo has none.
- Do NOT add a charting dependency. Extend EquityChart with a compact mode.
- Do NOT add a router. Follow the existing View union pattern.
- Chain basis / last decision date / next review due come from W1+W3+W4 (see portfolio-carryover-spec.md).
  W6 renders them once W4's streams route returns them; W6 does NOT invent them.
