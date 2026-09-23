import { relations } from "drizzle-orm";
import { users } from "./users.js";
import { notifications } from "./notifications.js";
import { instruments, dailyPrices } from "./market_data.js";

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
