import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(process.cwd(), "..", ".env") });

const connectionString = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";


export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./supabase/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString,
  },
});
