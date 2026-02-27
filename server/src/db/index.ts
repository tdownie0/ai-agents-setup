import 'dotenv/config';
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

// Using 'prepare: false' prevents "prepared statement" errors when using 
// Supabase's connection pooler.
const client = postgres(process.env.DATABASE_URL!, {
  prepare: false
});

export const db = drizzle(client, { schema });
