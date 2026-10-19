/**
 * Eval comparison-report route (beads task model_md-worktree-feat-portfolio-sim-ijg).
 *
 *   GET /portfolio/evals/report?simIds=<id1,id2,…>&start=YYYY-MM-DD&end=YYYY-MM-DD&judgeKey=process
 *
 * Sibling of `portfolioEvals.ts` (already past the 250-line module ceiling):
 * groups judge scores + deterministic stream metrics by (personaKey,
 * promptSetVersion) with low-n warnings, so two sims — one per prompt
 * version — can be compared side by side from one payload. Reads only,
 * unauthenticated: same convention as the other eval GETs. Mounted in
 * `index.ts` BEFORE `portfolioEvals` so the static `/evals/report` path wins
 * over that app's `/evals/:simId` param route (Hono matches registration
 * order first).
 */

import { Hono } from "hono";
import { db } from "@model_md/database";
import { buildEvalReport } from "../evaluation/report.js";
import { parseOptionalDate } from "./portfolioEvals.js";

const SIM_ID_PATTERN = /^sim-[a-z0-9][a-z0-9-]{0,46}$/;
const MAX_SIMS = 10;

interface QueryError {
  error: string;
  hint: string;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Parse `simIds` into a deduplicated 1..10-id list. Missing, empty, or
 * duplicate entries are all 400s: a duplicate would silently double-count a
 * replicate, and an empty entry means a malformed comma list.
 */
export function parseSimIdsParam(
  raw: string | undefined,
): { value: string[] } | { error: QueryError } {
  const text = raw?.trim() ?? "";
  if (text.length === 0) {
    return {
      error: {
        error: "simIds query param is required",
        hint: "simIds must be a comma-separated list of 1..10 simulation ids (sim-…)",
      },
    };
  }
  const entries = text.split(",").map((entry) => entry.trim());
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (entry.length === 0) {
      return {
        error: {
          error: `simIds[${index}] is empty`,
          hint: "remove stray commas; every entry between commas must be a simulation id",
        },
      };
    }
    if (!SIM_ID_PATTERN.test(entry)) {
      return {
        error: {
          error: `simIds[${index}] ${JSON.stringify(entry)} is not a valid simulation id`,
          hint: "simulation ids match /^sim-[a-z0-9][a-z0-9-]{0,46}$/",
        },
      };
    }
    if (seen.has(entry)) {
      return {
        error: {
          error: `duplicate simId ${JSON.stringify(entry)}`,
          hint: "list each simulation once; replicates are separate simulations with their own simIds",
        },
      };
    }
    seen.add(entry);
  }
  if (entries.length > MAX_SIMS) {
    return {
      error: {
        error: `too many simIds (${entries.length})`,
        hint: `pass at most ${MAX_SIMS} simulations per report`,
      },
    };
  }
  return { value: entries };
}

const portfolioEvalReportApp = new Hono().get("/evals/report", async (c) => {
  const simIds = parseSimIdsParam(c.req.query("simIds"));
  if ("error" in simIds) return c.json(simIds.error, 400);
  const start = parseOptionalDate(c.req.query("start"), "start");
  if ("error" in start) return c.json(start.error, 400);
  const end = parseOptionalDate(c.req.query("end"), "end");
  if ("error" in end) return c.json(end.error, 400);
  if (start.value !== undefined && end.value !== undefined && start.value > end.value) {
    return c.json(
      {
        error: "start must not be after end",
        hint: "start and end are inclusive YYYY-MM-DD bounds with start <= end",
      },
      400,
    );
  }
  const judgeKey = c.req.query("judgeKey")?.trim();
  try {
    const report = await buildEvalReport(db, {
      simIds: simIds.value,
      start: start.value,
      end: end.value,
      judgeKey: judgeKey === "" ? undefined : judgeKey,
    });
    return c.json(report);
  } catch (err) {
    return c.json({ error: messageOf(err) }, 500);
  }
});

export default portfolioEvalReportApp;
