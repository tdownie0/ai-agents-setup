/**
 * Batch process-judging: resolve target runs, skip what is already scored,
 * call the judge SEQUENTIALLY (free-tier rate limits), and upsert one
 * `run_eval_scores` row per (agentRunId, judgeKey, judgeVersion).
 *
 * The run resolution never touches market data: positions are read only for
 * their whitelist fields (symbol/targetWeight/thesis) and the decide date
 * comes from `round_jobs` — blindness is enforced one layer down in
 * `scoreRun.buildBlindContext`.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { agentRuns, portfolioPositions, roundJobs, runEvalScores } from "@model_md/database";
import type { DbClient } from "@model_md/market-data";
import { env } from "../env.js";
import { scoreRun } from "./scoreRun.js";
import { PROCESS_JUDGE_KEY, RUBRIC_VERSION } from "./rubric.js";

/** Invalid batch target (neither/both of simulationId and roundIds, bad shape). */
export class JudgeTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeTargetError";
  }
}

export interface JudgeBatchOpts {
  simulationId?: string;
  roundIds?: string[];
  judgeKey?: string;
  judgeModel?: string;
  force?: boolean;
}

export interface JudgeRunResult {
  runId: number;
  agentKey: string;
  status: "scored" | "skipped" | "error";
  error?: string;
}

export interface JudgeBatchResult {
  judgeKey: string;
  judgeVersion: string;
  model: string;
  results: JudgeRunResult[];
  summary: { scored: number; skipped: number; errors: number };
}

const SIM_ID_PATTERN = /^sim-[a-z0-9][a-z0-9-]{0,46}$/;

/**
 * Assert the batch addresses runs by exactly one target, with well-formed
 * values. Shared by the route's body parser and `runJudgeBatch` so a direct
 * API caller cannot bypass the same boundary rule.
 */
export function assertJudgeTarget(
  opts: Pick<JudgeBatchOpts, "simulationId" | "roundIds">,
): { simulationId: string } | { roundIds: string[] } {
  const hasSimulation = opts.simulationId !== undefined;
  const hasRounds = opts.roundIds !== undefined;
  if (hasSimulation === hasRounds) {
    throw new JudgeTargetError("exactly one of simulationId or roundIds is required");
  }
  if (hasSimulation) {
    const simulationId = opts.simulationId ?? "";
    if (!SIM_ID_PATTERN.test(simulationId)) {
      throw new JudgeTargetError(
        `simulationId ${JSON.stringify(simulationId)} must match /^sim-[a-z0-9][a-z0-9-]{0,46}$/`,
      );
    }
    return { simulationId };
  }
  const roundIds = opts.roundIds ?? [];
  if (roundIds.length === 0) {
    throw new JudgeTargetError("roundIds must be a non-empty array");
  }
  roundIds.forEach((roundId, index) => {
    if (typeof roundId !== "string" || roundId.trim().length === 0) {
      throw new JudgeTargetError(`roundIds[${index}] must be a non-empty string`);
    }
  });
  return { roundIds: roundIds.map((roundId) => roundId.trim()) };
}

interface TargetRunRow {
  id: number;
  roundId: string;
  simulationId: string | null;
  agentKey: string;
  window: string;
  roundSeq: number;
  rationale: string | null;
  asOfTradeDate: string | null;
}

interface TargetPositionRow {
  agentRunId: number;
  symbol: string;
  targetWeight: string | number;
  thesis: string | null;
}

/**
 * All runs of the target, oldest first. The `round_jobs` join is what makes a
 * simulation-wide batch possible (runs link to rounds by value, R6) and it
 * simultaneously supplies the decide date; an unbooked round has no date the
 * judge could be told about, so its runs are not addressable here.
 */
async function loadTargetRuns(
  client: DbClient,
  target: { simulationId: string } | { roundIds: string[] },
): Promise<TargetRunRow[]> {
  const condition =
    "simulationId" in target
      ? eq(roundJobs.simulationId, target.simulationId)
      : inArray(agentRuns.roundId, target.roundIds);
  return client
    .select({
      id: agentRuns.id,
      roundId: agentRuns.roundId,
      simulationId: agentRuns.simulationId,
      agentKey: agentRuns.agentKey,
      window: agentRuns.window,
      roundSeq: agentRuns.roundSeq,
      rationale: agentRuns.rationale,
      asOfTradeDate: roundJobs.asOfTradeDate,
    })
    .from(agentRuns)
    .innerJoin(roundJobs, eq(agentRuns.roundId, roundJobs.roundId))
    .where(condition)
    .orderBy(asc(agentRuns.id));
}

async function loadPositionsByRun(
  client: DbClient,
  runIds: readonly number[],
): Promise<Map<number, TargetPositionRow[]>> {
  const byRun = new Map<number, TargetPositionRow[]>();
  if (runIds.length === 0) return byRun;
  const rows = await client
    .select({
      agentRunId: portfolioPositions.agentRunId,
      symbol: portfolioPositions.symbol,
      targetWeight: portfolioPositions.targetWeight,
      thesis: portfolioPositions.thesis,
    })
    .from(portfolioPositions)
    .where(inArray(portfolioPositions.agentRunId, [...runIds]));
  for (const row of rows) {
    const list = byRun.get(row.agentRunId) ?? [];
    list.push(row);
    byRun.set(row.agentRunId, list);
  }
  return byRun;
}

async function loadAlreadyScored(
  client: DbClient,
  runIds: readonly number[],
  judgeKey: string,
): Promise<Set<number>> {
  const scored = new Set<number>();
  if (runIds.length === 0) return scored;
  const rows = await client
    .select({ agentRunId: runEvalScores.agentRunId })
    .from(runEvalScores)
    .where(
      and(
        eq(runEvalScores.judgeKey, judgeKey),
        eq(runEvalScores.judgeVersion, RUBRIC_VERSION),
        inArray(runEvalScores.agentRunId, [...runIds]),
      ),
    );
  for (const row of rows) scored.add(row.agentRunId);
  return scored;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runJudgeBatch(
  client: DbClient,
  opts: JudgeBatchOpts,
): Promise<JudgeBatchResult> {
  const target = assertJudgeTarget(opts);
  const judgeKey = opts.judgeKey?.trim() || PROCESS_JUDGE_KEY;
  const model = opts.judgeModel?.trim() || env.JUDGE_MODEL;
  const force = opts.force === true;

  const runs = await loadTargetRuns(client, target);
  const runIds = runs.map((run) => run.id);
  const [positionsByRun, alreadyScored] = await Promise.all([
    loadPositionsByRun(client, runIds),
    loadAlreadyScored(client, runIds, judgeKey),
  ]);

  const results: JudgeRunResult[] = [];
  for (const run of runs) {
    if (!force && alreadyScored.has(run.id)) {
      results.push({ runId: run.id, agentKey: run.agentKey, status: "skipped" });
      continue;
    }
    try {
      const score = await scoreRun({
        run: {
          runId: run.id,
          agentKey: run.agentKey,
          window: run.window,
          roundSeq: run.roundSeq,
          rationale: run.rationale,
        },
        positions: (positionsByRun.get(run.id) ?? []).map((position) => ({
          symbol: position.symbol,
          targetWeight: Number(position.targetWeight),
          thesis: position.thesis,
        })),
        meta: {
          roundId: run.roundId,
          simulationId: run.simulationId,
          asOfTradeDate: run.asOfTradeDate,
        },
        model,
      });
      const scores = { ...score.scores, overall: score.overall };
      await client
        .insert(runEvalScores)
        .values({
          agentRunId: run.id,
          judgeKey,
          judgeVersion: RUBRIC_VERSION,
          scores,
          verdict: score.verdict,
          judgeModel: model,
        })
        .onConflictDoUpdate({
          target: [runEvalScores.agentRunId, runEvalScores.judgeKey, runEvalScores.judgeVersion],
          set: { scores, verdict: score.verdict, judgeModel: model, createdAt: new Date() },
        });
      results.push({ runId: run.id, agentKey: run.agentKey, status: "scored" });
    } catch (err) {
      results.push({
        runId: run.id,
        agentKey: run.agentKey,
        status: "error",
        error: messageOf(err),
      });
    }
  }

  return {
    judgeKey,
    judgeVersion: RUBRIC_VERSION,
    model,
    results,
    summary: {
      scored: results.filter((result) => result.status === "scored").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      errors: results.filter((result) => result.status === "error").length,
    },
  };
}
