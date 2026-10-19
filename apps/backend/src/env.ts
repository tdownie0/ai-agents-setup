/// <reference types="node" />

export const env = {
  SUPABASE_URL: process.env.SUPABASE_URL!,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY!,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  /** Passed to analysis `createProvider({ decisionProvider })`; default deterministic. */
  DECISION_PROVIDER: process.env.DECISION_PROVIDER ?? "deterministic",
  /**
   * OpenRouter-compatible chat-completions key for the blind process judge
   * (`POST /portfolio/evals/judge`). Absent/empty disables the route with a 503.
   */
  JUDGE_API_KEY: process.env.JUDGE_API_KEY,
  /** Chat-completions base URL; defaults to the OpenRouter public endpoint. */
  JUDGE_API_BASE: process.env.JUDGE_API_BASE ?? "https://openrouter.ai/api/v1",
  /** Default reasoning model for the process judge. */
  JUDGE_MODEL: process.env.JUDGE_MODEL ?? "nvidia/nemotron-3-super-120b-a12b:free",
};
