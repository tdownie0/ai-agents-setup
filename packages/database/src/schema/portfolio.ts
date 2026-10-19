import type { InferSelectModel } from "drizzle-orm";
import {
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { simulations } from "./simulations.js";

/**
 * Forward paper-trading schema: one analyst subagent's decision per
 * simulation round (`agent_runs`) and its equal-weight picks with entry
 * fills at decision-time close (`portfolio_positions`).
 *
 * Equity curves are computed on the fly by the backend from positions +
 * `daily_prices` — never stored.
 */

export const portfolioWindows = {
  daily: "daily",
  weekly: "weekly",
  monthly: "monthly",
} as const;

export type PortfolioWindow = (typeof portfolioWindows)[keyof typeof portfolioWindows];

export const agentRunStatuses = {
  pending: "pending",
  completed: "completed",
  failed: "failed",
} as const;

export type AgentRunStatus = (typeof agentRunStatuses)[keyof typeof agentRunStatuses];

/**
 * One analyst subagent's decision per simulation round. Rows are inserted
 * only after a successful analyst run, so `completed` is the default;
 * `failed`/`pending` are reserved for a future async flow.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: serial("id").primaryKey(),
    roundId: varchar("round_id", { length: 64 }).notNull(),
    /**
     * Denormalized from the owning `round_jobs` row so a per-stream read needs
     * no join. INVARIANT (R6): this always equals the `round_jobs` value — the
     * fold writes both in one transaction and is the single writer.
     *
     * NOT NULL for the same reason as `round_jobs.round_seq`: it is the chain
     * position used to order a stream's history, and a run without one has no
     * place in any chain.
     */
    simulationId: varchar("simulation_id", { length: 64 }).references(() => simulations.simId, {
      onDelete: "cascade",
    }),
    roundSeq: integer("round_seq").notNull(),
    agentKey: varchar("agent_key", { length: 120 }).notNull(),
    persona: varchar("persona", { length: 200 }).notNull(),
    strategy: varchar("strategy", { length: 60 }).notNull(),
    window: text("window").notNull().$type<PortfolioWindow>(),
    /**
     * Per-decision portfolio value the target weights were applied to, NOT the
     * simulation's starting capital. The chain basis lives on
     * `agent_portfolio_state.initial_capital`.
     */
    initialCapital: numeric("initial_capital", { precision: 14, scale: 2 })
      .notNull()
      .default("100000"),
    status: text("status").notNull().default("completed").$type<AgentRunStatus>(),
    rationale: text("rationale"),
    decisionJson: jsonb("decision_json"),
    error: text("error"),
    replicateOf: varchar("replicate_of", { length: 120 }),
    /** Human label of the prompt template version used for this run (e.g. "v1"). */
    promptSetVersion: varchar("prompt_set_version", { length: 40 }),
    /** sha256 hex of the rendered prompt template. */
    promptHash: varchar("prompt_hash", { length: 64 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One run per agent per round — a replica shares the base agentKey, so
    // consistency checks key off roundId + agentKey.
    uniqueIndex("agent_runs_round_id_agent_key_unique_idx").on(table.roundId, table.agentKey),
    // Per-stream reads: one agent's decisions across a chain, in chain order.
    index("agent_runs_stream_seq_idx").on(table.simulationId, table.agentKey, table.roundSeq),
  ],
);

export type AgentRun = InferSelectModel<typeof agentRuns>;

/**
 * A single equal-weight pick from an agent run, with the entry fill at
 * decision-time close. `shares` is filled at ingest as
 * initialCapital × targetWeight / entryPrice (fractional shares allowed).
 */
export const portfolioPositions = pgTable(
  "portfolio_positions",
  {
    id: serial("id").primaryKey(),
    agentRunId: integer("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    symbol: varchar("symbol", { length: 16 }).notNull(),
    targetWeight: numeric("target_weight", { precision: 7, scale: 6 }).notNull(),
    shares: numeric("shares", { precision: 18, scale: 6 }),
    /**
     * US equity session calendar date (America/New_York close date); never
     * derived from UTC. Same type as `daily_prices.trade_date`.
     */
    entryTradeDate: date("entry_trade_date"),
    entryPrice: numeric("entry_price", { precision: 12, scale: 4 }),
    thesis: text("thesis"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One position per symbol per agent run.
    uniqueIndex("portfolio_positions_agent_run_id_symbol_unique_idx").on(
      table.agentRunId,
      table.symbol,
    ),
  ],
);

export type PortfolioPosition = InferSelectModel<typeof portfolioPositions>;
