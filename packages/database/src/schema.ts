import {
  pgTable,
  serial,
  text,
  timestamp,
  boolean,
  uuid,
} from "drizzle-orm/pg-core";
import type { InferSelectModel } from "drizzle-orm";

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  fullName: text("full_name").notNull(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type User = InferSelectModel<typeof users>;

export const notificationTypes = {
  info: "info",
  warning: "warning",
  success: "success",
  error: "error",
} as const;

export type NotificationType =
  (typeof notificationTypes)[keyof typeof notificationTypes];

export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull().$type<NotificationType>(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  read: boolean("read").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Notification = InferSelectModel<typeof notifications>;
