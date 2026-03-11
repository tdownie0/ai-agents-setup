import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as users from "./schema/users.js";
import * as notifications from "./schema/notifications.js";
import * as relations from "./schema/relations.js";

export const schema = {
  ...users,
  ...notifications,
  ...relations,
};

// Using 'prepare: false' prevents "prepared statement" errors when using
// Supabase's connection pooler.
const client = postgres(process.env.DATABASE_URL!, {
  prepare: false,
});

export const db = drizzle(client, { schema });

export * from "./schema/users.js";
export * from "./schema/notifications.js";
export * from "./schema/relations.js";
