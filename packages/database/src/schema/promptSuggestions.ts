/**
 * Judge-proposed prompt suggestions for a persona/window — one row per
 * (persona, window, prompt-set version, source prompt hash, judge, judge
 * version). `critiques` is the judge's prose analysis; `proposals` holds
 * the structured prompt edits keyed for deterministic re-application.
 */

import type { InferSelectModel } from "drizzle-orm";
import { jsonb, pgTable, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import type { PortfolioWindow } from "./portfolio.js";

export const promptSuggestions = pgTable(
  "prompt_suggestions",
  {
    id: serial("id").primaryKey(),
    personaKey: varchar("persona_key", { length: 50 }).notNull(),
    window: text("window").notNull().$type<PortfolioWindow>(),
    promptSetVersion: varchar("prompt_set_version", { length: 40 }).notNull(),
    /** sha256 hex of the rendered source prompt being critiqued. */
    sourcePromptHash: varchar("source_prompt_hash", { length: 64 }).notNull(),
    judgeKey: varchar("judge_key", { length: 64 }).notNull(),
    /** Judge version of the judge (e.g. "1"). */
    judgeVersion: varchar("judge_version", { length: 20 }).notNull(),
    /** Judge's prose critique of the source prompt. */
    critiques: text("critiques").notNull(),
    /** Structured prompt edits proposed by the judge. */
    proposals: jsonb("proposals").notNull(),
    judgeModel: text("judge_model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One suggestion row per judge per rubric version per source prompt.
    uniqueIndex("prompt_suggestions_identity_unique_idx").on(
      table.personaKey,
      table.window,
      table.promptSetVersion,
      table.sourcePromptHash,
      table.judgeKey,
      table.judgeVersion,
    ),
  ],
);

export type PromptSuggestion = InferSelectModel<typeof promptSuggestions>;
