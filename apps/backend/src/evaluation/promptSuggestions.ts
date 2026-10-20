/**
 * Prompt-suggestion persistence + batch orchestration (the structural mirror
 * of `judgeBatch.ts`, minus the blindness contract — here the critic is
 * supposed to see the prompt).
 *
 * Per target window: resolve the prompt-set definition, skip when a
 * `prompt_suggestions` row already exists for the full unique key
 * (persona/window/prompt-set version/source hash/judge/judge version), else
 * build a failure digest from `agent_runs`, call the critic, and insert or
 * upsert that one row. Windows run SEQUENTIALLY (free-tier rate limits) and a
 * failure in one window is recorded, never propagated.
 */

import { and, desc, eq, like, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { agentRuns, promptSuggestions } from "@model_md/database";
import type { PortfolioWindow } from "@model_md/database";
import type { DbClient } from "@model_md/market-data";
import {
  ANALYST_WINDOWS,
  PROMPT_SET_VERSION,
  agentKeyFor,
  getPromptSetDefinition,
} from "@model_md/agent-orchestrator";
import type { AnalystWindow, PromptSetDefinition } from "@model_md/agent-orchestrator";
import { env } from "../env.js";
import { CRITIC_VERSION, PROMPT_CRITIC_KEY, critiquePromptSet } from "./promptCritic.js";
import type { FailureNote, PromptProposal } from "./promptCritic.js";

/** Failed-run error samples gathered for the critic, truncated to this length. */
const FAILURE_SAMPLE_MAX_CHARS = 300;
/** At most this many distinct failure samples reach the critic. */
const FAILURE_SAMPLE_LIMIT = 10;

export interface SuggestionBatchOpts {
  personaKey: string;
  window?: AnalystWindow;
  force?: boolean;
  model?: string;
}

export interface SuggestionBatchWindowResult {
  personaKey: string;
  window: string;
  promptHash: string;
  status: "generated" | "skipped" | "error";
  suggestionId?: number;
  error?: string;
}

export interface SuggestionBatchResult {
  judgeKey: string;
  judgeVersion: string;
  model: string;
  promptSetVersion: string;
  results: SuggestionBatchWindowResult[];
  summary: { generated: number; skipped: number; errors: number };
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Failure digest for one prompt set: failed `agent_runs` rows of the stream
 * (the base `agentKey` plus `#…` replica suffixes) stamped with the same
 * `promptSetVersion`, aggregated to a total count plus up to 10 DISTINCT
 * truncated `error` strings. Prompt-set metadata only — no run payload.
 */
async function loadFailureDigest(db: DbClient, def: PromptSetDefinition): Promise<FailureNote[]> {
  const rows = await db
    .select({ error: agentRuns.error })
    .from(agentRuns)
    .where(
      and(
        or(eq(agentRuns.agentKey, def.agentKey), like(agentRuns.agentKey, `${def.agentKey}#%`)),
        eq(agentRuns.promptSetVersion, def.promptSetVersion),
        eq(agentRuns.status, "failed"),
      ),
    );
  const totalFailures = rows.length;
  const samples: string[] = [];
  for (const row of rows) {
    if (row.error === null) continue;
    const sample = row.error.slice(0, FAILURE_SAMPLE_MAX_CHARS);
    if (!samples.includes(sample)) samples.push(sample);
    if (samples.length >= FAILURE_SAMPLE_LIMIT) break;
  }
  return samples.map((error) => ({ error, totalFailures }));
}

/** Existing suggestion row id for the full unique key, or undefined. */
async function findExistingSuggestion(
  db: DbClient,
  def: PromptSetDefinition,
  judgeKey: string,
  judgeVersion: string,
): Promise<number | undefined> {
  const rows = await db
    .select({ id: promptSuggestions.id })
    .from(promptSuggestions)
    .where(
      and(
        eq(promptSuggestions.personaKey, def.personaKey),
        eq(promptSuggestions.window, def.window),
        eq(promptSuggestions.promptSetVersion, def.promptSetVersion),
        eq(promptSuggestions.sourcePromptHash, def.promptHash),
        eq(promptSuggestions.judgeKey, judgeKey),
        eq(promptSuggestions.judgeVersion, judgeVersion),
      ),
    );
  return rows[0]?.id;
}

/**
 * Critique every target window (one explicit window, else all three) for one
 * persona, upserting one `prompt_suggestions` row per window on the full
 * unique key. One window's failure becomes an `error` entry; the remaining
 * windows still run.
 */
export async function runSuggestionBatch(
  db: DbClient,
  opts: SuggestionBatchOpts,
): Promise<SuggestionBatchResult> {
  const judgeKey = PROMPT_CRITIC_KEY;
  const judgeVersion = CRITIC_VERSION;
  const model = opts.model?.trim() || env.JUDGE_MODEL;
  const force = opts.force === true;
  const windows: readonly AnalystWindow[] =
    opts.window !== undefined ? [opts.window] : ANALYST_WINDOWS;

  const results: SuggestionBatchWindowResult[] = [];
  for (const window of windows) {
    const def = getPromptSetDefinition(opts.personaKey, window);
    try {
      const existingId = await findExistingSuggestion(db, def, judgeKey, judgeVersion);
      if (existingId !== undefined && !force) {
        results.push({
          personaKey: def.personaKey,
          window,
          promptHash: def.promptHash,
          status: "skipped",
          suggestionId: existingId,
        });
        continue;
      }
      const failures = await loadFailureDigest(db, def);
      const critique = await critiquePromptSet({ definition: def, failures, model });
      const row = {
        personaKey: def.personaKey,
        window: def.window,
        promptSetVersion: def.promptSetVersion,
        sourcePromptHash: def.promptHash,
        judgeKey,
        judgeVersion,
        critiques: critique.critiques,
        proposals: critique.proposals,
        judgeModel: model,
      };
      const inserted = await db
        .insert(promptSuggestions)
        .values(row)
        .onConflictDoUpdate({
          target: [
            promptSuggestions.personaKey,
            promptSuggestions.window,
            promptSuggestions.promptSetVersion,
            promptSuggestions.sourcePromptHash,
            promptSuggestions.judgeKey,
            promptSuggestions.judgeVersion,
          ],
          set: {
            critiques: critique.critiques,
            proposals: critique.proposals,
            judgeModel: model,
            createdAt: new Date(),
          },
        })
        .returning({ id: promptSuggestions.id });
      results.push({
        personaKey: def.personaKey,
        window,
        promptHash: def.promptHash,
        status: "generated",
        suggestionId: inserted[0]?.id,
      });
    } catch (err) {
      results.push({
        personaKey: def.personaKey,
        window,
        promptHash: def.promptHash,
        status: "error",
        error: messageOf(err),
      });
    }
  }

  return {
    judgeKey,
    judgeVersion,
    model,
    promptSetVersion: PROMPT_SET_VERSION,
    results,
    summary: {
      generated: results.filter((result) => result.status === "generated").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      errors: results.filter((result) => result.status === "error").length,
    },
  };
}

export interface SuggestionListFilters {
  personaKey?: string;
  window?: string;
  promptSetVersion?: string;
}

/** One suggestion row shaped for the API wire, with the currency stamp. */
export interface SuggestionListItem {
  id: number;
  personaKey: string;
  window: string;
  promptSetVersion: string;
  sourcePromptHash: string;
  judgeKey: string;
  judgeVersion: string;
  critiques: string;
  proposals: PromptProposal[];
  judgeModel: string;
  /** ISO-8601 creation timestamp (wire format). */
  createdAt: string;
  /** Row matches the CURRENT prompt-set version and rendered prompt hash. */
  isCurrent: boolean;
}

function isWindow(value: string): value is PortfolioWindow {
  return (ANALYST_WINDOWS as readonly string[]).includes(value);
}

/** Suggestion rows for the API, filtered on the provided keys, newest first. */
export async function listSuggestions(
  db: DbClient,
  filters: SuggestionListFilters,
): Promise<SuggestionListItem[]> {
  const conditions: SQL[] = [];
  if (filters.personaKey !== undefined) {
    conditions.push(eq(promptSuggestions.personaKey, filters.personaKey));
  }
  if (filters.window !== undefined) {
    if (!isWindow(filters.window)) return [];
    conditions.push(eq(promptSuggestions.window, filters.window));
  }
  if (filters.promptSetVersion !== undefined) {
    conditions.push(eq(promptSuggestions.promptSetVersion, filters.promptSetVersion));
  }
  const rows = await db
    .select()
    .from(promptSuggestions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(promptSuggestions.createdAt));
  return rows.map((row) => ({
    id: row.id,
    personaKey: row.personaKey,
    window: row.window,
    promptSetVersion: row.promptSetVersion,
    sourcePromptHash: row.sourcePromptHash,
    judgeKey: row.judgeKey,
    judgeVersion: row.judgeVersion,
    critiques: row.critiques,
    proposals: Array.isArray(row.proposals) ? (row.proposals as PromptProposal[]) : [],
    judgeModel: row.judgeModel,
    createdAt: row.createdAt.toISOString(),
    isCurrent:
      row.promptSetVersion === PROMPT_SET_VERSION &&
      row.sourcePromptHash === getPromptSetDefinition(row.personaKey, row.window).promptHash,
  }));
}
