/**
 * MCP client for the judge/critic LLM call.
 *
 * The backend never talks to a chat-completions API (or to docker/opencode)
 * directly: it sends the `run_prompt` tool call to the mcp-gateway over MCP's
 * Streamable HTTP transport, and the gateway's `opencode_agent` container
 * executes the model. Each call builds a fresh, stateless `Client` and closes
 * it in a `finally` so no session state leaks between judge runs.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { env } from "../env.js";

export interface RunPromptInput {
  system: string;
  user: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * Per-attempt timeout the gateway's `run_prompt` tool applies to one
 * `opencode run` execution. Mirrors the tool's own default so both budgets
 * agree even when the caller does not override it.
 */
export const RUN_PROMPT_TIMEOUT_MS = 120_000;

/** The tool retries once, so one call can consume two full attempts. */
export const MCP_MAX_ATTEMPTS = 2;

/**
 * Grace added to the tool's total budget before the SDK request timeout fires.
 *
 * The MCP SDK aborts a request after `DEFAULT_REQUEST_TIMEOUT_MSEC` (60s) when
 * no timeout is given, which preempted slow judge calls: the caller saw
 * "MCP error -32001: Request timed out" instead of the tool's own error, and
 * the run was recorded as an error without the model ever being asked.
 */
export const MCP_REQUEST_TIMEOUT_GRACE_MS = 30_000;

/** Transport-level options handed to the tool call. */
export interface RunPromptCallOptions {
  /** SDK request timeout in ms — must outlast the tool's whole budget. */
  requestTimeoutMs: number;
}

/** Injectable seam so tests can exercise `runPromptWithDeps` without a gateway. */
export interface RunPromptDeps {
  callTool: (
    name: string,
    args: Record<string, unknown>,
    options: RunPromptCallOptions,
  ) => Promise<unknown>;
}

/** One tool call: the arguments to send and the SDK timeout that guards it. */
export interface RunPromptCall {
  args: Record<string, unknown>;
  options: RunPromptCallOptions;
}

/**
 * Build the tool arguments and the SDK request timeout for one call.
 *
 * The tool's `timeoutMs` is PER ATTEMPT and the tool may retry once, so the
 * SDK request timeout must outlast the tool's whole budget
 * (`timeoutMs * attempts + grace`). The tool timeout is also always sent
 * explicitly, so the two sides can never drift apart on a default.
 */
export function buildRunPromptCall(input: RunPromptInput): RunPromptCall {
  const toolTimeoutMs = input.timeoutMs ?? RUN_PROMPT_TIMEOUT_MS;
  const args: Record<string, unknown> = { system: input.system, user: input.user };
  if (input.model !== undefined) args.model = input.model;
  args.timeoutMs = toolTimeoutMs;
  return {
    args,
    options: {
      requestTimeoutMs: toolTimeoutMs * MCP_MAX_ATTEMPTS + MCP_REQUEST_TIMEOUT_GRACE_MS,
    },
  };
}

const CLIENT_INFO = { name: "model-md-backend", version: "1.0.0" } as const;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract the tool's response text from an MCP `callTool` result. Servers
 * answer with `{ content: [{ type: "text", text }] }`; a bare string is also
 * accepted so fakes stay trivial. Anything else is a contract violation.
 */
function extractText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (isRecord(raw) && Array.isArray(raw.content)) {
    const parts = raw.content
      .filter((block): block is { type: "text"; text: string } => {
        if (!isRecord(block)) return false;
        return block.type === "text" && typeof block.text === "string";
      })
      .map((block) => block.text);
    if (parts.length > 0) return parts.join("\n");
  }
  throw new Error("run_prompt returned no text content");
}

/**
 * Parse the `run_prompt` payload: `{"ok":true,"text","attempts"}` on success,
 * `{"ok":false,"error"}` on failure. A failed payload carries its `attempts`
 * onto the thrown error (when present) so `chatComplete` can report them.
 */
function parseRunPromptPayload(raw: unknown): { text: string; attempts: number } {
  const body = extractText(raw);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (err) {
    throw new Error(`run_prompt returned unparseable JSON: ${errorMessage(err)}`);
  }
  if (!isRecord(payload)) {
    throw new Error("run_prompt returned a non-object payload");
  }
  if (payload.ok !== true) {
    const error = new Error(
      typeof payload.error === "string" && payload.error.length > 0
        ? payload.error
        : "run_prompt failed without an error message",
    );
    if (typeof payload.attempts === "number") {
      Object.assign(error, { attempts: payload.attempts });
    }
    throw error;
  }
  if (typeof payload.text !== "string") {
    throw new Error("run_prompt success payload carried no text");
  }
  const attempts =
    typeof payload.attempts === "number" &&
    Number.isInteger(payload.attempts) &&
    payload.attempts >= 1
      ? payload.attempts
      : 1;
  return { text: payload.text, attempts };
}

/** Call `run_prompt` through an injected `callTool` (the test seam). */
export async function runPromptWithDeps(
  input: RunPromptInput,
  deps: RunPromptDeps,
): Promise<{ text: string; attempts: number }> {
  const call = buildRunPromptCall(input);
  const raw = await deps.callTool("run_prompt", call.args, call.options);
  return parseRunPromptPayload(raw);
}

/**
 * Real transport: one fresh `Client` + `StreamableHTTPClientTransport` per
 * call, authenticated with the gateway bearer token, always closed in `finally`.
 */
export async function runPrompt(
  input: RunPromptInput,
): Promise<{ text: string; attempts: number }> {
  const transport = new StreamableHTTPClientTransport(new URL(env.MCP_GATEWAY_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${env.MCP_GATEWAY_AUTH_TOKEN ?? ""}` },
    },
  });
  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(transport);
    return await runPromptWithDeps(input, {
      callTool: async (name, args, options) =>
        client.callTool({ name, arguments: args }, undefined, {
          timeout: options.requestTimeoutMs,
        }),
    });
  } finally {
    await client.close();
  }
}
