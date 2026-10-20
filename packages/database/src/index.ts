import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as users from "./schema/users.js";
import * as notifications from "./schema/notifications.js";
import * as marketData from "./schema/market_data.js";
import * as portfolio from "./schema/portfolio.js";
import * as roundJobs from "./schema/roundJobs.js";
import * as relations from "./schema/relations.js";
import * as simulations from "./schema/simulations.js";
import * as portfolioCarryover from "./schema/portfolioCarryover.js";
import * as evalScores from "./schema/evalScores.js";
import * as promptSuggestions from "./schema/promptSuggestions.js";

export const schema = {
  ...users,
  ...notifications,
  ...marketData,
  ...portfolio,
  ...roundJobs,
  ...relations,
  ...simulations,
  ...portfolioCarryover,
  ...evalScores,
  ...promptSuggestions,
};

// Using 'prepare: false' prevents "prepared statement" errors when using
// Supabase's connection pooler.
const client = postgres(process.env.DATABASE_URL!, {
  prepare: false,
});

export const db = drizzle(client, { schema });

export * from "./schema/users.js";
export * from "./schema/notifications.js";
export * from "./schema/market_data.js";
export * from "./schema/portfolio.js";
export * from "./schema/roundJobs.js";
export * from "./schema/relations.js";
export * from "./schema/simulations.js";
export * from "./schema/portfolioCarryover.js";
export * from "./schema/evalScores.js";
export * from "./schema/promptSuggestions.js";
