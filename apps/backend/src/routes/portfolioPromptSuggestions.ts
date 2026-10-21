/**
 * Non-blind prompt-suggestion routes (beads task
 * model_md-worktree-feat-portfolio-sim-e4e.4).
 *
 *   POST /portfolio/prompt-suggestions   — auth-protected; run the prompt
 *   critic for ONE persona across one window or all three, upserting one
 *   `prompt_suggestions` row per window.
 *   GET  /portfolio/prompt-suggestions   — auth-protected; list persisted
 *   suggestions, optionally filtered by persona/window/prompt-set version.
 *
 * Unlike the blind process-judge, this critic SEES the prompt text by design.
 * An unknown `personaKey` is rejected at the boundary (400) because the batch
 * resolves the prompt-set definition outside its per-window error handling; a
 * missing MCP gateway config (URL/token) is a 503 (configured-but-unavailable,
 * not a caller mistake).
 */

import { Hono } from "hono";
import { db } from "@model_md/database";
import { ANALYST_WINDOWS, getPersona } from "@model_md/agent-orchestrator";
import type { AnalystWindow } from "@model_md/agent-orchestrator";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { isJudgeConfigured } from "../evaluation/llmClient.js";
import { listSuggestions, runSuggestionBatch } from "../evaluation/promptSuggestions.js";
import type {
  SuggestionBatchOpts,
  SuggestionListFilters,
} from "../evaluation/promptSuggestions.js";

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAnalystWindow(value: string): value is AnalystWindow {
  return (ANALYST_WINDOWS as readonly string[]).includes(value);
}

/**
 * Parse the request body into suggestion-batch options. `personaKey` is
 * required AND validated against the persona catalog here so an unknown key
 * becomes a 400 at this boundary instead of escaping the batch as a 500.
 */
export function parseSuggestionBody(raw: unknown): SuggestionBatchOpts {
  if (!isRecord(raw)) {
    throw new Error("request body must be a JSON object");
  }
  const { personaKey, window, force, model } = raw;
  if (typeof personaKey !== "string" || personaKey.trim().length === 0) {
    throw new Error("body.personaKey must be a non-empty string");
  }
  try {
    getPersona(personaKey);
  } catch (err) {
    throw new Error(messageOf(err));
  }
  const opts: SuggestionBatchOpts = { personaKey };
  if (window !== undefined) {
    if (typeof window !== "string" || !isAnalystWindow(window)) {
      throw new Error(`body.window must be one of: ${ANALYST_WINDOWS.join(", ")}`);
    }
    opts.window = window;
  }
  if (force !== undefined) {
    if (typeof force !== "boolean") throw new Error("body.force must be a boolean");
    opts.force = force;
  }
  if (model !== undefined) {
    if (typeof model !== "string" || model.trim().length === 0) {
      throw new Error("body.model must be a non-empty string");
    }
    opts.model = model.trim();
  }
  return opts;
}

const portfolioPromptSuggestionsApp = new Hono()
  .post("/prompt-suggestions", authMiddleware, async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "request body must be valid JSON" }, 400);
    }
    let opts: SuggestionBatchOpts;
    try {
      opts = parseSuggestionBody(raw);
    } catch (err) {
      return c.json({ error: messageOf(err) }, 400);
    }
    if (!isJudgeConfigured()) {
      return c.json(
        { error: "judge not configured", hint: "set MCP_GATEWAY_URL and MCP_GATEWAY_AUTH_TOKEN" },
        503,
      );
    }
    try {
      const result = await runSuggestionBatch(db, opts);
      return c.json(result);
    } catch (err) {
      return c.json({ error: messageOf(err) }, 500);
    }
  })
  .get("/prompt-suggestions", authMiddleware, async (c) => {
    const filters: SuggestionListFilters = {};
    const personaKey = c.req.query("personaKey");
    if (personaKey !== undefined && personaKey.length > 0) filters.personaKey = personaKey;
    const window = c.req.query("window");
    if (window !== undefined && window.length > 0) filters.window = window;
    const promptSetVersion = c.req.query("promptSetVersion");
    if (promptSetVersion !== undefined && promptSetVersion.length > 0) {
      filters.promptSetVersion = promptSetVersion;
    }
    try {
      const suggestions = await listSuggestions(db, filters);
      return c.json({ suggestions });
    } catch (err) {
      return c.json({ error: messageOf(err) }, 500);
    }
  });

export default portfolioPromptSuggestionsApp;
