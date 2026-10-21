/// <reference types="node" />

export const env = {
  SUPABASE_URL: process.env.SUPABASE_URL!,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY!,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  /** Passed to analysis `createProvider({ decisionProvider })`; default deterministic. */
  DECISION_PROVIDER: process.env.DECISION_PROVIDER ?? "deterministic",
  /**
   * MCP gateway endpoint carrying the `run_prompt` tool. The judge/critic LLM
   * call (blind process judge + prompt critic) is no longer a direct
   * chat-completions request: the backend sends `run_prompt` over MCP and the
   * gateway's `opencode_agent` container executes the model. A blank URL (or
   * blank auth token) disables the judge routes with a 503.
   */
  MCP_GATEWAY_URL: process.env.MCP_GATEWAY_URL ?? "http://mcp-gateway:8811/mcp",
  /**
   * Bearer token sent to the MCP gateway. Absent/blank disables the judge
   * routes with a 503 (configured-but-unavailable, not a caller mistake).
   */
  MCP_GATEWAY_AUTH_TOKEN: process.env.MCP_GATEWAY_AUTH_TOKEN,
  /** Default model for the judge models (process judge + prompt critic). */
  JUDGE_MODEL: process.env.JUDGE_MODEL ?? "opencode/big-pickle",
};
