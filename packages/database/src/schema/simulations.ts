/**
 * `simulations` — the first-class scope a carryover book lives in.
 *
 * A simulation is one continuous experiment over an ordered chain of rounds.
 * It exists so carryover can be scoped: a replay of a historical day must not
 * mutate a book that has already moved past it, and a run must be resettable
 * without deleting history. `round_jobs.simulation_id` + `round_seq` is the
 * authoritative ordering; `sim_id` is the human-stable handle.
 */

import type { InferSelectModel } from "drizzle-orm";
import { numeric, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * One simulation. `simId` is the natural key (`/^sim-[a-z0-9][a-z0-9-]{0,46}$/`)
 * because every child table FKs to it; the surrogate `id` is never referenced.
 *
 * `initialCapital` is the chain's starting capital — the basis every round's
 * `returnPct` is measured against, and the value
 * `agent_portfolio_state.initial_capital` is seeded from.
 */
export const simulations = pgTable("simulations", {
  id: serial("id").primaryKey(),
  simId: varchar("sim_id", { length: 64 }).notNull().unique(),
  label: text("label"),
  initialCapital: numeric("initial_capital", { precision: 14, scale: 2 })
    .notNull()
    .default("100000"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Simulation = InferSelectModel<typeof simulations>;
