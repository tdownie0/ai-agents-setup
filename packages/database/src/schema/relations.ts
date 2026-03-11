import { relations } from "drizzle-orm";
import { users } from "./users.js";
import { notifications } from "./notifications.js";

export const usersRelations = relations(users, ({ many }) => ({
  notifications: many(notifications),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, {
    fields: [notifications.userId],
    references: [users.id],
  }),
}));
