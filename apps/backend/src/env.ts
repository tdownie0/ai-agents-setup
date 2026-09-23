/// <reference types="node" />

export const env = {
  SUPABASE_URL: process.env.SUPABASE_URL!,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY!,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  /** Passed to analysis `createProvider({ decisionProvider })`; default deterministic. */
  DECISION_PROVIDER: process.env.DECISION_PROVIDER ?? "deterministic",
};
