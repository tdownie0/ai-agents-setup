/**
 * Judge LLM client — the blind process judge and the prompt critic.
 *
 * Transport is MCP, not HTTP chat-completions: `chatComplete` delegates to the
 * gateway's `run_prompt` tool (see `mcpClient.ts`), where the gateway's
 * `opencode_agent` container executes the model. There is no local retry loop,
 * token cap, or HTTP status anymore — failures surface as `JudgeApiError` with
 * `status: null` and the attempt count reported by the tool payload.
 */

import { env } from "../env.js";
import { runPrompt } from "./mcpClient.js";

/** Thrown when the MCP gateway URL/token is absent or blank — callers map it to 503. */
export class JudgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeConfigError";
  }
}

/** A judge LLM call that failed at the MCP gateway, with the tool's attempt count. */
export class JudgeApiError extends Error {
  readonly status: number | null;
  readonly attempts: number;

  constructor(message: string, status: number | null, attempts: number) {
    super(message);
    this.name = "JudgeApiError";
    this.status = status;
    this.attempts = attempts;
  }
}

export interface ChatCompleteInput {
  system: string;
  user: string;
  model?: string;
  /**
   * Ignored: `opencode run` (the gateway's executor) has no output-token cap.
   * Kept for source compatibility with existing callers.
   */
  maxTokens?: number;
}

/** Whether the MCP gateway transport (URL + bearer token) is configured. */
export function isJudgeConfigured(): boolean {
  return (
    (env.MCP_GATEWAY_URL ?? "").trim().length > 0 &&
    (env.MCP_GATEWAY_AUTH_TOKEN ?? "").trim().length > 0
  );
}

/** Attempt count carried on a failed `run_prompt` payload, else 1. */
function attemptsOf(err: unknown): number {
  if (err instanceof Error && "attempts" in err && typeof err.attempts === "number") {
    return err.attempts;
  }
  return 1;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One judge completion through the MCP gateway's `run_prompt` tool. JSON is
 * demanded by the prompt; the model is `input.model` or `env.JUDGE_MODEL`.
 *
 * @throws {JudgeConfigError} when the gateway URL/token is blank.
 * @throws {JudgeApiError} on any gateway/tool failure (`status` is always null).
 */
export async function chatComplete(input: ChatCompleteInput): Promise<string> {
  if (!isJudgeConfigured()) {
    throw new JudgeConfigError(
      "judge transport not configured — set MCP_GATEWAY_URL and MCP_GATEWAY_AUTH_TOKEN",
    );
  }

  try {
    const { text } = await runPrompt({
      system: input.system,
      user: input.user,
      model: input.model ?? env.JUDGE_MODEL,
    });
    return text;
  } catch (err) {
    throw new JudgeApiError(errorMessage(err), null, attemptsOf(err));
  }
}
