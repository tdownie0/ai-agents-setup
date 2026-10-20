/// <reference types="node" />

export const env = {
  SUPABASE_URL: process.env.SUPABASE_URL!,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY!,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  /** Passed to analysis `createProvider({ decisionProvider })`; default deterministic. */
  DECISION_PROVIDER: process.env.DECISION_PROVIDER ?? "deterministic",
  /**
   * Chat-completions key for the judge models (the blind process judge and the
   * prompt critic). Falls back to `OPENROUTER_API_KEY` — `||` so an empty
   * string falls through too. Absent/empty disables the judge route with a 503.
   */
  JUDGE_API_KEY: process.env.JUDGE_API_KEY || process.env.OPENROUTER_API_KEY,
  /**
   * Chat-completions base URL; `JUDGE_API_BASE`/`JUDGE_MODEL` may point at ANY
   * OpenAI-compatible endpoint — e.g. Gemini's
   * `https://generativelanguage.googleapis.com/v1beta/openai`. Defaults to the
   * OpenRouter public endpoint.
   */
  JUDGE_API_BASE: process.env.JUDGE_API_BASE ?? "https://openrouter.ai/api/v1",
  /** Default model for the judge models (process judge + prompt critic). */
  JUDGE_MODEL: process.env.JUDGE_MODEL ?? "nvidia/nemotron-3-super-120b-a12b:free",
};
