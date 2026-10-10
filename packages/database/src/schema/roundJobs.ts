/**
 * Durable orchestration state for a simulation round.
 *
 * The portfolio-orchestrator MCP server runs as a throwaway container per tool
 * call (the docker MCP gateway uses `docker run --rm -i` per request), so it
 * CANNOT hold round progress in process memory. These two tables are the
 * durable record that `get_round_status` reads back from any process:
 *
 *   round_jobs           — one row per round: lifecycle status + launch params
 *   round_agent_progress — one row per (round, agent): per-agent status/run id
 *
 * `agent_runs` remains the record of *inserted decisions*; these tables are the
 * record of *orchestration progress*, including agents that failed or never ran.
 */

import { sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./portfolio.js";
import { simulations } from "./simulations.js";

export const roundJobStatuses = {
  launching: "launching",
  running: "running",
  done: "done",
  partial: "partial",
  error: "error",
} as const;

export type RoundJobStatus = (typeof roundJobStatuses)[keyof typeof roundJobStatuses];

/** Terminal statuses never transition again; a new launch needs a takeover. */
export const TERMINAL_ROUND_JOB_STATUSES: readonly RoundJobStatus[] = ["done", "partial", "error"];

/**
 * How a round relates to the chain it belongs to.
 *
 * `carry` advances the stream's book from its previous round (the default);
 * `fresh` opens a new book at the current capital, leaving the chain basis
 * alone. Mirrors the `round_jobs_advance_mode_chk` check constraint.
 */
export const advanceModes = {
  fresh: "fresh",
  carry: "carry",
} as const;

export type AdvanceMode = (typeof advanceModes)[keyof typeof advanceModes];

export function isTerminalRoundJobStatus(status: RoundJobStatus): boolean {
  return TERMINAL_ROUND_JOB_STATUSES.includes(status);
}

export const roundAgentStatuses = {
  pending: "pending",
  running: "running",
  inserted: "inserted",
  failed: "failed",
  /**
   * The stream's cadence window had not elapsed when the round launched, so the
   * agent was deliberately NOT spawned and carries its book forward. A success
   * state, not a failure: it neither inserts a run nor blocks the round.
   */
  not_due: "not_due",
} as const;

export type RoundAgentStatus = (typeof roundAgentStatuses)[keyof typeof roundAgentStatuses];

/**
 * One row per round. `round_id` is the natural key (a round is launched once at
 * a time), so it is the primary key rather than a surrogate id.
 *
 * `simulation_id` + `round_seq` is the AUTHORITATIVE chain ordering — order by
 * `round_seq`, never by parsing the id string, and never by `created_at` (with
 * 18 agents inserting concurrently `created_at` is insertion finish time, so
 * "latest round" would be whichever agent finished last). Both are nullable:
 * rounds launched on the pre-carryover path carry neither, and readers fall
 * back to `created_at` only for those rows.
 */
export const roundJobs = pgTable(
  "round_jobs",
  {
    roundId: varchar("round_id", { length: 64 }).primaryKey(),
    status: text("status").notNull().default("launching").$type<RoundJobStatus>(),
    simulationId: varchar("simulation_id", { length: 64 }).references(() => simulations.simId, {
      onDelete: "cascade",
    }),
    /**
     * Chain position, NOT NULL: every round has exactly one position in its
     * simulation's chain, and a unique index on `(simulation_id, round_seq)`
     * cannot reject duplicate NON-NULL pairs while the column is nullable —
     * several NULL rows coexist silently. Ordering is `round_seq`, never the id
     * string and never `created_at` (with 18 agents inserting concurrently,
     * `created_at` is insertion finish time, so "latest round" would be
     * whichever agent finished last).
     */
    roundSeq: integer("round_seq").notNull(),
    advanceMode: text("advance_mode").notNull().default(advanceModes.carry).$type<AdvanceMode>(),
    /**
     * US equity session calendar date (America/New_York close date) the round was
     * built from; never derived from UTC. Same semantics as
     * `daily_prices.trade_date`.
     */
    asOfTradeDate: date("as_of_trade_date"),
    /** Dataset path as visible inside the agent container (diagnostics only). */
    datasetPath: text("dataset_path"),
    maxParallel: integer("max_parallel").notNull(),
    capital: numeric("capital", { precision: 14, scale: 2 }).notNull(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Last line of defense for the rerun policy (the route owns the 409s): one
    // round per chain position per simulation.
    uniqueIndex("round_jobs_simulation_round_seq_unique_idx").on(
      table.simulationId,
      table.roundSeq,
    ),
    check("round_jobs_advance_mode_chk", sql`${table.advanceMode} IN ('fresh','carry')`),
  ],
);

export type RoundJob = InferSelectModel<typeof roundJobs>;

/**
 * One row per analyst agent per round. `run_id` links to the inserted
 * `agent_runs` row once the envelope has been persisted; it stays null for
 * agents that failed or are still pending.
 */
export const roundAgentProgress = pgTable(
  "round_agent_progress",
  {
    id: serial("id").primaryKey(),
    roundId: varchar("round_id", { length: 64 })
      .notNull()
      .references(() => roundJobs.roundId, { onDelete: "cascade" }),
    agentKey: varchar("agent_key", { length: 120 }).notNull(),
    personaKey: varchar("persona_key", { length: 120 }).notNull(),
    status: text("status").notNull().default("pending").$type<RoundAgentStatus>(),
    runId: integer("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    picks: integer("picks"),
    attempts: integer("attempts"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One progress row per agent per round; re-launch upserts on this key.
    uniqueIndex("round_agent_progress_round_id_agent_key_unique_idx").on(
      table.roundId,
      table.agentKey,
    ),
    // Leaderboard-style reads: all agents of a round, stable order.
    index("round_agent_progress_round_id_idx").on(table.roundId),
  ],
);

export type RoundAgentProgress = InferSelectModel<typeof roundAgentProgress>;
