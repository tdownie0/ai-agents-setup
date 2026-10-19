/**
 * Blind process-judge batch route (beads task …-5uc).
 *
 *   POST /portfolio/evals/judge   — auth-protected; judge runs of a simulation
 *   or an explicit round list with the locked "process" rubric.
 *
 * Response is the `runJudgeBatch` result: per-run status (scored/skipped/error)
 * plus a summary. Runs are processed sequentially at the service layer because
 * free-tier judge models rate-limit; a missing `JUDGE_API_KEY` is a 503 (the
 * service is configured-but-unavailable, not a caller mistake).
 */

import { Hono } from "hono";
import { db } from "@model_md/database";
import { env } from "../env.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { assertJudgeTarget, JudgeTargetError, runJudgeBatch } from "../evaluation/judgeBatch.js";
import type { JudgeBatchOpts } from "../evaluation/judgeBatch.js";

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the request body into batch options: JSON-shape checks here, the
 * target's value rules (exactly-one, sim-id pattern, non-empty ids) in the
 * shared `assertJudgeTarget` so this boundary and the service enforce one rule.
 */
export function parseJudgeBatchBody(raw: unknown): JudgeBatchOpts {
  if (!isRecord(raw)) {
    throw new Error("request body must be a JSON object");
  }
  const opts: JudgeBatchOpts = {};
  const { simulationId, roundIds, judgeKey, judgeModel, force } = raw;
  if (simulationId !== undefined) {
    if (typeof simulationId !== "string") throw new Error("body.simulationId must be a string");
    opts.simulationId = simulationId;
  }
  if (roundIds !== undefined) {
    if (!Array.isArray(roundIds)) throw new Error("body.roundIds must be an array of strings");
    const entries: unknown[] = roundIds;
    for (const [index, entry] of entries.entries()) {
      if (typeof entry !== "string") {
        throw new Error(`body.roundIds[${index}] must be a string`);
      }
    }
    opts.roundIds = entries as string[];
  }
  if (judgeKey !== undefined) {
    if (typeof judgeKey !== "string" || judgeKey.trim().length === 0) {
      throw new Error("body.judgeKey must be a non-empty string");
    }
    if (judgeKey.length > 64) throw new Error("body.judgeKey must be at most 64 characters");
    opts.judgeKey = judgeKey.trim();
  }
  if (judgeModel !== undefined) {
    if (typeof judgeModel !== "string" || judgeModel.trim().length === 0) {
      throw new Error("body.judgeModel must be a non-empty string");
    }
    opts.judgeModel = judgeModel.trim();
  }
  if (force !== undefined) {
    if (typeof force !== "boolean") throw new Error("body.force must be a boolean");
    opts.force = force;
  }
  assertJudgeTarget(opts);
  return opts;
}

const portfolioJudgeApp = new Hono().post("/evals/judge", authMiddleware, async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "request body must be valid JSON" }, 400);
  }
  let opts: JudgeBatchOpts;
  try {
    opts = parseJudgeBatchBody(raw);
  } catch (err) {
    return c.json({ error: messageOf(err) }, 400);
  }
  if (env.JUDGE_API_KEY === undefined || env.JUDGE_API_KEY.trim().length === 0) {
    return c.json({ error: "judge model API key not configured", hint: "set JUDGE_API_KEY" }, 503);
  }
  try {
    const result = await runJudgeBatch(db, opts);
    return c.json(result);
  } catch (err) {
    if (err instanceof JudgeTargetError) return c.json({ error: err.message }, 400);
    return c.json({ error: messageOf(err) }, 500);
  }
});

export default portfolioJudgeApp;
