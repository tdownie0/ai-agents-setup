import { relations } from "drizzle-orm";
import { users } from "./users.js";
import { notifications } from "./notifications.js";
import { instruments, dailyPrices } from "./market_data.js";
import { agentRuns, portfolioPositions } from "./portfolio.js";
import { roundAgentProgress, roundJobs } from "./roundJobs.js";

export const usersRelations = relations(users, ({ many }) => ({
  notifications: many(notifications),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, {
    fields: [notifications.userId],
    references: [users.id],
  }),
}));

export const instrumentsRelations = relations(instruments, ({ many }) => ({
  dailyPrices: many(dailyPrices),
}));

export const dailyPricesRelations = relations(dailyPrices, ({ one }) => ({
  instrument: one(instruments, {
    fields: [dailyPrices.instrumentId],
    references: [instruments.id],
  }),
}));

export const agentRunsRelations = relations(agentRuns, ({ many }) => ({
  portfolioPositions: many(portfolioPositions),
}));

export const portfolioPositionsRelations = relations(portfolioPositions, ({ one }) => ({
  agentRun: one(agentRuns, {
    fields: [portfolioPositions.agentRunId],
    references: [agentRuns.id],
  }),
}));

export const roundJobsRelations = relations(roundJobs, ({ many }) => ({
  agents: many(roundAgentProgress),
}));

export const roundAgentProgressRelations = relations(roundAgentProgress, ({ one }) => ({
  round: one(roundJobs, {
    fields: [roundAgentProgress.roundId],
    references: [roundJobs.roundId],
  }),
  run: one(agentRuns, {
    fields: [roundAgentProgress.runId],
    references: [agentRuns.id],
  }),
}));
