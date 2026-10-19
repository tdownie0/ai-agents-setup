/**
 * Judge evaluation scores for an agent run — one row per (run, judge,
 * rubric version). `scores` holds per-criterion scores keyed by criterion
 * id plus an `overall` 1-5; `verdict` is the judge's prose paragraph.
 */

import type { InferSelectModel } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./portfolio.js";

export const runEvalScores = pgTable(
  "run_eval_scores",
  {
    id: serial("id").primaryKey(),
    agentRunId: integer("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    judgeKey: varchar("judge_key", { length: 64 }).notNull(),
    /** Rubric version of the judge (e.g. "1"). */
    judgeVersion: varchar("judge_version", { length: 20 }).notNull(),
    /** Per-criterion scores keyed by criterion id, plus `overall`: 1-5. */
    scores: jsonb("scores").notNull(),
    verdict: text("verdict").notNull(),
    judgeModel: text("judge_model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One score row per judge per rubric version per run.
    uniqueIndex("run_eval_scores_agent_run_id_judge_key_judge_version_unique_idx").on(
      table.agentRunId,
      table.judgeKey,
      table.judgeVersion,
    ),
  ],
);

export type RunEvalScore = InferSelectModel<typeof runEvalScores>;
