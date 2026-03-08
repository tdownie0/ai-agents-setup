import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false });

async function reset() {
  console.log("Resetting database...");

  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;

  await sql`CREATE SCHEMA public`;

  console.log("Database reset complete.");
  process.exit(0);
}
reset().catch((err) => {
  console.error("Reset failed:", err);
  process.exit(1);
});
