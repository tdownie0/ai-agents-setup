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

import type { InferSelectModel } from "drizzle-orm";
import {
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

export function isTerminalRoundJobStatus(status: RoundJobStatus): boolean {
  return TERMINAL_ROUND_JOB_STATUSES.includes(status);
}

export const roundAgentStatuses = {
  pending: "pending",
  running: "running",
  inserted: "inserted",
  failed: "failed",
} as const;

export type RoundAgentStatus = (typeof roundAgentStatuses)[keyof typeof roundAgentStatuses];

/**
 * One row per round. `round_id` is the natural key (a round is launched once at
 * a time), so it is the primary key rather than a surrogate id.
 */
export const roundJobs = pgTable("round_jobs", {
  roundId: varchar("round_id", { length: 64 }).primaryKey(),
  status: text("status").notNull().default("launching").$type<RoundJobStatus>(),
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
});

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
