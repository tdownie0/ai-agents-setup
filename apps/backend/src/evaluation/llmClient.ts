/**
 * Direct chat-completions client for the blind process judge.
 *
 * Plain `fetch` against an OpenRouter-compatible endpoint — deliberately no
 * SDK dependency. Free-tier reasoning models rate-limit aggressively, so the
 * client bounds retries on 429/5xx/network failure with exponential backoff
 * (honoring `Retry-After`), applies a per-call timeout, and fails with typed
 * errors that carry HTTP status detail.
 */

import { env } from "../env.js";

/** Thrown when `JUDGE_API_KEY` is absent or blank — callers map it to 503. */
export class JudgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeConfigError";
  }
}

/** A judge API call that failed after retries, with the last HTTP detail. */
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
  maxTokens?: number;
}

/** Initial attempt plus one retry per entry: 1s, 3s, 9s. */
const RETRY_DELAYS_MS = [1_000, 3_000, 9_000] as const;
const REQUEST_TIMEOUT_MS = 90_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `Retry-After` in ms (delta-seconds or HTTP-date), or null when unusable. */
function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
}

async function errorDetail(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  const snippet = body.slice(0, 300);
  return snippet.length > 0 ? `HTTP ${response.status}: ${snippet}` : `HTTP ${response.status}`;
}

/**
 * One chat completion at temperature 0. JSON is demanded by the prompt (no
 * `response_format`), because free-tier reasoning models do not consistently
 * support structured-output parameters.
 */
export async function chatComplete(input: ChatCompleteInput): Promise<string> {
  const apiKey = env.JUDGE_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new JudgeConfigError("judge model API key not configured — set JUDGE_API_KEY");
  }

  const url = `${env.JUDGE_API_BASE.replace(/\/+$/, "")}/chat/completions`;
  const payload = JSON.stringify({
    model: input.model ?? env.JUDGE_MODEL,
    temperature: 0,
    max_tokens: input.maxTokens ?? 4_000,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
  });

  let lastDetail = "";
  let lastStatus: number | null = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt++) {
    attempts = attempt;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: payload,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      lastDetail = `network error: ${errorMessage(err)}`;
      lastStatus = null;
      if (attempt > RETRY_DELAYS_MS.length) break;
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
      continue;
    }

    if (response.ok) {
      const raw = await response.json().catch((err: unknown) => {
        throw new JudgeApiError(
          `judge API returned unparseable JSON: ${errorMessage(err)}`,
          response.status,
          attempt,
        );
      });
      const content =
        typeof raw === "object" && raw !== null && "choices" in raw && Array.isArray(raw.choices)
          ? (raw.choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content
          : undefined;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new JudgeApiError(
          "judge API completion carried no message content (reasoning exhausted max_tokens?)",
          response.status,
          attempt,
        );
      }
      return content;
    }

    lastDetail = await errorDetail(response);
    lastStatus = response.status;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable) {
      throw new JudgeApiError(lastDetail, lastStatus, attempt);
    }
    if (attempt > RETRY_DELAYS_MS.length) break;
    const delay = retryAfterMs(response) ?? RETRY_DELAYS_MS[attempt - 1];
    await sleep(delay);
  }

  throw new JudgeApiError(
    `judge API request failed after ${attempts} attempts: ${lastDetail}`,
    lastStatus,
    attempts,
  );
}
