# ACTUAL export surface — brief W4/W5 from THIS, not from the Oracle spec
Captured from disk after W1/W2/W3 wave 1. W4 must import these real names.
The Oracle spec used different/placeholder names in several places. The divergence is listed.

## apps/backend/src/portfolio/carryover.ts (W3, VERIFIED ON DISK)
  interface OpeningBook
  interface DecisionTarget            <-- NOT in Oracle spec (spec inlined an array literal)
  interface BuyFill
  interface SellFill
  interface HoldFill
  type DecisionFill = BuyFill | SellFill | HoldFill
  interface ApplyDecisionInput
  interface ApplyDecisionResult
  function applyDecision(input: ApplyDecisionInput): ApplyDecisionResult
  interface EngineSegment
  function computeChainEquitySeries(...)        <-- signature spans lines 238+
  interface SegmentStep                 <-- NOT in Oracle spec
  interface ChainReplay                 <-- NOT in Oracle spec
  function replaySegmentChain(...)       <-- NOT in Oracle spec; this is the pure rebuild core W4 wraps
  interface DecisionDueInput            <-- NOT in Oracle spec (spec inlined the object)
  function isDecisionDue(input: DecisionDueInput): boolean

## apps/backend/src/portfolio/ranking.ts (W3) — INCOMPLETE AT CAPTURE TIME
  function computeRanking(equitySeries: readonly EquityPoint[]): RankingResult
  !!! The RankingInput / basisCapital overload had NOT landed when this was captured.
  !!! W4 MUST re-read ranking.ts before using computeRanking with an explicit basis.

## packages/agent-orchestrator/src/contract.ts (W2, VERIFIED ON DISK)
  DECISION_SCHEMA_VERSION = 2, MIN_PICKS 5, MAX_PICKS 10,
  WEIGHT_SUM_MIN 0.99, WEIGHT_SUM_MAX 1.01, TARGET_WEIGHT_MAX 1
  interface DecisionPosition   { symbol; targetWeight; thesis }
  interface DecisionHolding    { the per-held-line view for the prompt }
  interface DecisionAgent
  interface DecisionEnvelope
  interface ValidateEnvelopeOptions

## packages/database/src/schema (W1, VERIFIED ON DISK)
  simulations.ts -> simulations
  portfolioCarryover.ts -> agent_portfolio_state, portfolio_position_lots, portfolio_equity_daily
  roundJobs.ts -> + simulationId, roundSeq, advanceMode + unique(simulationId,roundSeq) + chk
  portfolio.ts  -> agent_runs + simulationId, roundSeq + index(simulationId,agentKey,roundSeq)
  All exported from packages/database/src/index.ts. Migration 0004_add_portfolio_carryover.sql.

## W4 FILE OWNERSHIP (R8, prevents merge conflict)
W3 owns carryover.ts + ranking.ts (pure, no DB). W4 owns ALL DB-facing code: routes, atomic
insert+fold wiring, rebuildStream DB plumbing. W4 IMPORTS the functions above; it does NOT edit
carryover.ts. W4 owns the `replaySegmentChain` -> `rebuildStream` DB wrapper.
