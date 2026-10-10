/**
 * Durable round-job state RPC routes.
 *
 * The portfolio-orchestrator MCP server is a throwaway container per tool call
 * (the docker MCP gateway runs `docker run --rm -i` per request), so it cannot
 * hold round progress in process memory. These routes are the durable record
 * that `get_round_status` reads back from ANY process:
 *
 *   POST /portfolio/rounds/:roundId/job                      - launch (409 if already launched)
 *   GET  /portfolio/rounds/:roundId/job                      - round status + per-agent progress
 *   PATCH /portfolio/rounds/:roundId/job                     - transition round status
 *   PUT  /portfolio/rounds/:roundId/job/agents/:agentKey     - upsert per-agent progress
 *
 * `agent_runs` stays the record of INSERTED decisions; these tables are the
 * record of ORCHESTRATION progress, including agents that failed or never ran.
 * Launching is guarded here (not in the MCP process) so a duplicate launch is
 * rejected even when the round is re-polled from a different container.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { windowFromAgentKey } from "@model_md/agent-orchestrator";
import { db, isTerminalRoundJobStatus, roundAgentProgress, roundJobs } from "@model_md/database";
import type {
  PortfolioWindow,
  RoundAgentProgress,
  RoundAgentStatus,
  RoundJob,
  RoundJobStatus,
} from "@model_md/database";
import {
  computeRosterDue,
  loadLatestTradeDate,
  loadNextRoundSeq,
  loadRoundsForTradeDate,
  loadSimulation,
  loadStreamLastTradeDates,
  replaceRoundInTx,
} from "../portfolio/carryoverStore.js";
import type { Queryable, RosterStream } from "../portfolio/carryoverStore.js";
import { decideRerun, isRerunRejection, rerunRejectionStatus } from "../portfolio/rerunPolicy.js";
import { parseRoundId } from "./rounds.js";

export interface RoundJobWire {
  roundId: string;
  status: RoundJobStatus;
  asOfTradeDate: string | null;
  datasetPath: string | null;
  maxParallel: number;
  capital: string;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
  /**
   * The booking this round was actually admitted at. `gateCarryoverLaunch`
   * resolves `roundSeq` server-side (explicit value, a replaced round's slot, or
   * the next free one), so the client can only learn it by reading it back here.
   * The orchestrator must echo this into the analyst prompt: without it the
   * prompt falls back to `roundSeq=1` and the run-insert booking cross-check
   * rejects every chained round past the first. `null` for a standalone launch.
   */
  simulationId: string | null;
  roundSeq: number;
}

export interface RoundAgentProgressWire {
  agentKey: string;
  personaKey: string;
  status: RoundAgentStatus;
  runId: number | null;
  picks: number | null;
  attempts: number | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export function toRoundJobWire(job: RoundJob): RoundJobWire {
  return {
    roundId: job.roundId,
    status: job.status,
    asOfTradeDate: job.asOfTradeDate ?? null,
    datasetPath: job.datasetPath,
    maxParallel: job.maxParallel,
    capital: job.capital,
    error: job.error,
    startedAt: job.startedAt.toISOString(),
    completedAt: iso(job.completedAt),
    updatedAt: job.updatedAt.toISOString(),
    simulationId: job.simulationId,
    roundSeq: job.roundSeq,
  };
}

export function toRoundAgentProgressWire(progress: RoundAgentProgress): RoundAgentProgressWire {
  return {
    agentKey: progress.agentKey,
    personaKey: progress.personaKey,
    status: progress.status,
    runId: progress.runId,
    picks: progress.picks,
    attempts: progress.attempts,
    error: progress.error,
    startedAt: iso(progress.startedAt),
    completedAt: iso(progress.completedAt),
    updatedAt: progress.updatedAt.toISOString(),
  };
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ROUND_JOB_STATUSES: readonly RoundJobStatus[] = [
  "launching",
  "running",
  "done",
  "partial",
  "error",
];

const ROUND_AGENT_STATUSES: readonly RoundAgentStatus[] = [
  "pending",
  "running",
  "inserted",
  "failed",
  "not_due",
];

export interface StartRoundBody {
  agents: { agentKey: string; personaKey: string }[];
  maxParallel: number;
  capital: number;
  asOfTradeDate?: string;
  datasetPath?: string;
  takeover: boolean;
  /** Carries the round into a simulation's chain; absent = legacy launch. */
  simulationId?: string;
  /** Explicit chain position. Omit to take the next one after the sim's highest. */
  roundSeq?: number;
  /** Re-decide a FINISHED round for the same date instead of being rejected. */
  replace: boolean;
}

export function parseStartRoundBody(value: unknown): StartRoundBody {
  if (!isRecord(value)) {
    throw new Error("request body must be a JSON object");
  }
  const rawAgents = value.agents;
  if (!Array.isArray(rawAgents) || rawAgents.length === 0) {
    throw new Error("body.agents must be a non-empty array of { agentKey, personaKey }");
  }
  const agents = rawAgents.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.agentKey !== "string" ||
      entry.agentKey.trim().length === 0 ||
      typeof entry.personaKey !== "string" ||
      entry.personaKey.trim().length === 0
    ) {
      throw new Error(`body.agents[${index}] must be { agentKey: string, personaKey: string }`);
    }
    return { agentKey: entry.agentKey.trim(), personaKey: entry.personaKey.trim() };
  });

  const maxParallel = value.maxParallel;
  if (typeof maxParallel !== "number" || !Number.isInteger(maxParallel) || maxParallel <= 0) {
    throw new Error("body.maxParallel must be a positive integer");
  }
  const capital = value.capital;
  if (typeof capital !== "number" || !Number.isFinite(capital) || capital <= 0) {
    throw new Error("body.capital must be a positive number");
  }
  if (value.asOfTradeDate !== undefined && typeof value.asOfTradeDate !== "string") {
    throw new Error("body.asOfTradeDate must be a YYYY-MM-DD string when present");
  }
  if (value.datasetPath !== undefined && typeof value.datasetPath !== "string") {
    throw new Error("body.datasetPath must be a string when present");
  }
  if (value.takeover !== undefined && typeof value.takeover !== "boolean") {
    throw new Error("body.takeover must be a boolean when present");
  }
  if (value.replace !== undefined && typeof value.replace !== "boolean") {
    throw new Error("body.replace must be a boolean when present");
  }
  if (value.simulationId !== undefined) {
    if (
      typeof value.simulationId !== "string" ||
      !/^sim-[a-z0-9][a-z0-9-]{0,46}$/.test(value.simulationId)
    ) {
      throw new Error("body.simulationId must match /^sim-[a-z0-9][a-z0-9-]{0,46}$/ when present");
    }
  }
  if (value.roundSeq !== undefined) {
    if (
      typeof value.roundSeq !== "number" ||
      !Number.isInteger(value.roundSeq) ||
      value.roundSeq < 1
    ) {
      throw new Error("body.roundSeq must be a positive integer when present");
    }
  }
  if (value.roundSeq !== undefined && value.simulationId === undefined) {
    throw new Error(
      "body.roundSeq requires body.simulationId — a chain position is scoped to a simulation",
    );
  }

  return {
    agents,
    maxParallel,
    capital,
    asOfTradeDate: value.asOfTradeDate as string | undefined,
    datasetPath: value.datasetPath as string | undefined,
    takeover: value.takeover === true,
    simulationId: value.simulationId as string | undefined,
    roundSeq: value.roundSeq as number | undefined,
    replace: value.replace === true,
  };
}

export interface PatchRoundJobBody {
  status: RoundJobStatus;
  error?: string;
}

export function parsePatchRoundJobBody(value: unknown): PatchRoundJobBody {
  if (!isRecord(value)) {
    throw new Error("request body must be a JSON object");
  }
  const status = value.status;
  if (typeof status !== "string" || !ROUND_JOB_STATUSES.includes(status as RoundJobStatus)) {
    throw new Error(`body.status must be one of ${ROUND_JOB_STATUSES.join(", ")}`);
  }
  if (value.error !== undefined && typeof value.error !== "string") {
    throw new Error("body.error must be a string when present");
  }
  return { status: status as RoundJobStatus, error: value.error as string | undefined };
}

export interface PutAgentProgressBody {
  status: RoundAgentStatus;
  runId?: number;
  picks?: number;
  attempts?: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export function parsePutAgentProgressBody(value: unknown): PutAgentProgressBody {
  if (!isRecord(value)) {
    throw new Error("request body must be a JSON object");
  }
  const status = value.status;
  if (typeof status !== "string" || !ROUND_AGENT_STATUSES.includes(status as RoundAgentStatus)) {
    throw new Error(`body.status must be one of ${ROUND_AGENT_STATUSES.join(", ")}`);
  }
  for (const field of ["runId", "picks", "attempts"] as const) {
    const raw = value[field];
    if (raw !== undefined && raw !== null && (typeof raw !== "number" || !Number.isInteger(raw))) {
      throw new Error(`body.${field} must be an integer when present`);
    }
  }
  for (const field of ["error", "startedAt", "completedAt"] as const) {
    const raw = value[field];
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      throw new Error(`body.${field} must be a string when present`);
    }
  }
  const asDate = (raw: unknown): Date | undefined => {
    if (raw === undefined || raw === null) return undefined;
    const parsed = new Date(raw as string);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  };
  return {
    status: status as RoundAgentStatus,
    runId: (value.runId as number | undefined) ?? undefined,
    picks: (value.picks as number | undefined) ?? undefined,
    attempts: (value.attempts as number | undefined) ?? undefined,
    error: (value.error as string | undefined) ?? undefined,
    startedAt: asDate(value.startedAt)?.toISOString(),
    completedAt: asDate(value.completedAt)?.toISOString(),
  };
}

const toDate = (value: string | undefined): Date | null => {
  if (value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/**
 * A launch the gate refused. `decideRerun` supplies the four carryover codes;
 * the two pre-policy codes below are raised before it can run, because the
 * inputs it needs do not exist yet (no such simulation, or no prices at all).
 */
interface LaunchRejection {
  ok: false;
  code: string;
  terminal: boolean;
  error: string;
  hint: string;
  detail: unknown;
}

type CarryoverGate =
  | {
      body: StartRoundBody;
      replaceRoundIds: string[];
      agentStatusByKey: Map<string, RoundAgentStatus>;
    }
  | { rejection: LaunchRejection };

/**
 * Apply `decideRerun` to a carryover launch and resolve the chain position.
 *
 * Runs BEFORE any write so a rejected launch leaves nothing behind. The seq it
 * returns is either the caller's explicit `roundSeq` or the one the policy
 * implies: the replaced round's own position for a `replace`, otherwise the
 * next free slot in the simulation.
 */
async function gateCarryoverLaunch(body: StartRoundBody): Promise<CarryoverGate> {
  const simulationId = body.simulationId;
  if (simulationId === undefined) {
    // A standalone round is not carryover, so every agent launches as `pending`.
    return { body, replaceRoundIds: [], agentStatusByKey: new Map() };
  }

  const simulation = await loadSimulation(db, simulationId);
  if (simulation === undefined) {
    return {
      rejection: {
        ok: false,
        error: `simulation "${simulationId}" does not exist`,
        code: "UNKNOWN_SIMULATION",
        terminal: false,
        hint: "Create the simulation first — POST /api/portfolio/simulations.",
        detail: { simulationId },
      },
    };
  }

  const latestTradeDate = await loadLatestTradeDate(db);
  // A carryover round is always dated: the fold marks the book at that close.
  // Falling back to the newest available close is what the spec calls
  // "asOfTradeDate is MAX(daily_prices.trade_date) by construction".
  const asOfTradeDate = body.asOfTradeDate ?? latestTradeDate;
  if (asOfTradeDate === null) {
    return {
      rejection: {
        ok: false,
        error: "no price data is available — a carryover round cannot be dated",
        code: "STALE_TRADE_DATE",
        terminal: false,
        hint: "Run market-data ingestion before launching a round.",
        detail: { asOfTradeDate: null, latestTradeDate },
      },
    };
  }

  const existingRounds = await loadRoundsForTradeDate(db, simulationId, asOfTradeDate);
  const streamLastTradeDates = await loadStreamLastTradeDates(db, simulationId);
  const decision = decideRerun({
    replace: body.replace,
    asOfTradeDate,
    existingRounds,
    latestTradeDate,
    streamLastTradeDates,
  });
  if (isRerunRejection(decision)) return { rejection: decision };

  const roundSeq =
    body.roundSeq ??
    (decision.replaceRoundIds.length > 0
      ? // A replace inherits the position it replaces, so the chain keeps one
        // entry per date instead of leaving a hole.
        await replacedRoundSeq(db, decision.replaceRoundIds)
      : await loadNextRoundSeq(db, simulationId));

  const agentStatusByKey = await resolveAgentStatuses(body, simulationId, asOfTradeDate);

  return {
    body: { ...body, simulationId, asOfTradeDate, roundSeq },
    replaceRoundIds: decision.replaceRoundIds,
    agentStatusByKey,
  };
}

/**
 * Decide each requested agent's launch status from its cadence window.
 *
 * This is the single mechanical gate that makes weekly/monthly streams rebalance
 * on their own boundary instead of every round. It runs inside the launch path
 * so the `not_due` stamp and the job row are written in the same transaction, and
 * it is server-side so a throwaway orchestrator container cannot bypass it.
 */
async function resolveAgentStatuses(
  body: StartRoundBody,
  simulationId: string,
  asOfTradeDate: string,
): Promise<Map<string, RoundAgentStatus>> {
  const statusByKey = new Map<string, RoundAgentStatus>();
  // A takeover/replace is a deliberate re-run: every stream must be pending, or
  // nothing re-launches (its state still shows this round's date → 0 trading days).
  if (body.takeover || body.replace) {
    for (const agent of body.agents) statusByKey.set(agent.agentKey, "pending");
    return statusByKey;
  }
  const roster: RosterStream[] = [];
  for (const agent of body.agents) {
    const window = windowFromAgentKey(agent.agentKey);
    if (window !== undefined) {
      roster.push({ agentKey: agent.agentKey, personaKey: agent.personaKey, window });
    }
  }
  const due = await computeRosterDue(db, simulationId, asOfTradeDate, roster);
  const dueByKey = new Map(due.map((entry) => [entry.agentKey, entry.due]));
  for (const agent of body.agents) {
    statusByKey.set(agent.agentKey, statusForAgent(agent.agentKey, dueByKey));
  }
  return statusByKey;
}

/**
 * Map one agentKey to its launch status from the resolved due map.
 *
 * Exported for unit testing: the DB-backed due computation is exercised by the
 * feature lifecycle, but this mapping — including its two deliberate fallbacks —
 * is pure. An agentKey with no decodable window cannot be cadence-gated, and a
 * key absent from the map is launched rather than silently skipped.
 */
export function statusForAgent(
  agentKey: string,
  dueByKey: ReadonlyMap<string, boolean>,
): RoundAgentStatus {
  if (windowFromAgentKey(agentKey) === undefined) return "pending";
  return (dueByKey.get(agentKey) ?? true) ? "pending" : "not_due";
}

/** The lowest `round_seq` among the rounds a replace is discarding. */
async function replacedRoundSeq(client: Queryable, roundIds: readonly string[]): Promise<number> {
  const rows = await client
    .select({ seq: roundJobs.roundSeq })
    .from(roundJobs)
    .where(inArray(roundJobs.roundId, [...roundIds]));
  const seqs = rows.map((row) => row.seq);
  return seqs.length === 0 ? 1 : Math.min(...seqs);
}

const roundJobsApp = new Hono()
  .post("/rounds/:roundId/job", async (c) => {
    let roundId: string;
    try {
      roundId = parseRoundId(c.req.param("roundId"));
    } catch (err) {
      return c.json({ error: messageOf(err) }, 400);
    }

    let rawBody: unknown;
    try {
      rawBody = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: "request body must be valid JSON" }, 400);
    }
    let body: StartRoundBody;
    try {
      body = parseStartRoundBody(rawBody);
    } catch (err) {
      return c.json({ error: messageOf(err) }, 400);
    }

    // Carryover launches are gated by `decideRerun`; legacy launches (no
    // simulationId) skip it and get seq 1, since they are outside every chain.
    let replaceRoundIds: string[] = [];
    let agentStatusByKey = new Map<string, RoundAgentStatus>();
    if (body.simulationId !== undefined) {
      const gate = await gateCarryoverLaunch(body);
      if ("rejection" in gate) return c.json(gate.rejection, rerunRejectionStatus);
      body = gate.body;
      replaceRoundIds = gate.replaceRoundIds;
      agentStatusByKey = gate.agentStatusByKey;
    }

    const newJobValues = {
      roundId,
      status: "launching" as const,
      simulationId: body.simulationId ?? null,
      roundSeq: body.roundSeq ?? 1,
      asOfTradeDate: body.asOfTradeDate ?? null,
      datasetPath: body.datasetPath ?? null,
      maxParallel: body.maxParallel,
      capital: String(body.capital),
      error: null,
      startedAt: new Date(),
      completedAt: null,
    };

    // One transaction for the whole launch, because a `replace` is a swap: the
    // discarded round's decisions go, its streams re-fold, and the new job
    // takes the freed `(simulation_id, round_seq)` slot. Any other interleaving
    // leaves a chain that is neither the old one nor the new one.
    const launched = await db.transaction(async (tx) => {
      if (replaceRoundIds.length > 0 && body.simulationId !== undefined) {
        await replaceRoundInTx(tx, {
          simulationId: body.simulationId,
          roundIds: replaceRoundIds,
        });
        // The re-decided round inherits the discarded round's chain position, so
        // the old job row must be gone before the new one claims that slot.
        // `round_agent_progress` cascades with it, which is correct: that round
        // is being discarded, not resumed.
        await tx.delete(roundJobs).where(inArray(roundJobs.roundId, [...replaceRoundIds]));
      }

      // Atomic launch guard: `onConflictDoNothing` + `returning()` collapses the
      // check-then-write race. A concurrent second launch loses the PK conflict,
      // gets zero rows back, and falls into the 409 below — so a round can never
      // be launched twice by two overlapping tool calls.
      const rows = body.takeover
        ? await tx
            .insert(roundJobs)
            .values(newJobValues)
            .onConflictDoUpdate({
              target: roundJobs.roundId,
              set: { ...newJobValues, updatedAt: sql`now()` },
            })
            .returning()
        : await tx
            .insert(roundJobs)
            .values(newJobValues)
            .onConflictDoNothing({ target: roundJobs.roundId })
            .returning();
      if (rows.length === 0) return rows;

      // Reset every requested agent; a cadence-gate rejection (`not_due`) is
      // recorded here too, so the round knows the stream carried its book.
      for (const agent of body.agents) {
        const status = agentStatusByKey.get(agent.agentKey) ?? "pending";
        await tx
          .insert(roundAgentProgress)
          .values({
            roundId,
            agentKey: agent.agentKey,
            personaKey: agent.personaKey,
            status,
            runId: null,
            picks: null,
            attempts: null,
            error: null,
            startedAt: null,
            completedAt: null,
          })
          .onConflictDoUpdate({
            target: [roundAgentProgress.roundId, roundAgentProgress.agentKey],
            set: {
              personaKey: agent.personaKey,
              status,
              runId: null,
              picks: null,
              attempts: null,
              error: null,
              startedAt: null,
              completedAt: null,
              updatedAt: sql`now()`,
            },
          });
      }
      return rows;
    });

    if (launched.length === 0) {
      const [existing] = await db
        .select()
        .from(roundJobs)
        .where(eq(roundJobs.roundId, roundId))
        .limit(1);
      return c.json(
        {
          error: `round "${roundId}" was already launched (status=${existing?.status ?? "unknown"}, startedAt=${existing?.startedAt.toISOString() ?? "unknown"})`,
          hint: "Poll GET /api/portfolio/rounds/:roundId/job for progress, or re-launch with takeover=true to reset it.",
          job: existing === undefined ? null : toRoundJobWire(existing),
        },
        409,
      );
    }

    const [job] = await db.select().from(roundJobs).where(eq(roundJobs.roundId, roundId)).limit(1);
    const agents = await db
      .select()
      .from(roundAgentProgress)
      .where(eq(roundAgentProgress.roundId, roundId))
      .orderBy(asc(roundAgentProgress.agentKey));
    return c.json(
      { ok: true, job: toRoundJobWire(job), agents: agents.map(toRoundAgentProgressWire) },
      201,
    );
  })

  .get("/rounds/:roundId/job", async (c) => {
    let roundId: string;
    try {
      roundId = parseRoundId(c.req.param("roundId"));
    } catch (err) {
      return c.json({ error: messageOf(err) }, 400);
    }
    const [job] = await db.select().from(roundJobs).where(eq(roundJobs.roundId, roundId)).limit(1);
    if (job === undefined) {
      return c.json({ roundId, job: null, agents: [] });
    }
    const agents = await db
      .select()
      .from(roundAgentProgress)
      .where(eq(roundAgentProgress.roundId, roundId))
      .orderBy(asc(roundAgentProgress.agentKey));
    return c.json({
      roundId,
      job: toRoundJobWire(job),
      agents: agents.map(toRoundAgentProgressWire),
    });
  })

  .patch("/rounds/:roundId/job", async (c) => {
    let roundId: string;
    try {
      roundId = parseRoundId(c.req.param("roundId"));
    } catch (err) {
      return c.json({ error: messageOf(err) }, 400);
    }
    let rawBody: unknown;
    try {
      rawBody = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: "request body must be valid JSON" }, 400);
    }
    let body: PatchRoundJobBody;
    try {
      body = parsePatchRoundJobBody(rawBody);
    } catch (err) {
      return c.json({ error: messageOf(err) }, 400);
    }

    const terminal = isTerminalRoundJobStatus(body.status);
    const [job] = await db
      .update(roundJobs)
      .set({
        status: body.status,
        error: body.error ?? null,
        completedAt: terminal ? new Date() : null,
        updatedAt: sql`now()`,
      })
      .where(eq(roundJobs.roundId, roundId))
      .returning();
    if (job === undefined) {
      return c.json(
        {
          error: `round "${roundId}" has no job — POST /api/portfolio/rounds/${roundId}/job first`,
        },
        404,
      );
    }
    return c.json({ ok: true, job: toRoundJobWire(job) });
  })

  .put("/rounds/:roundId/job/agents/:agentKey", async (c) => {
    let roundId: string;
    try {
      roundId = parseRoundId(c.req.param("roundId"));
    } catch (err) {
      return c.json({ error: messageOf(err) }, 400);
    }
    const agentKey = c.req.param("agentKey")?.trim();
    if (agentKey === undefined || agentKey.length === 0) {
      return c.json({ error: "agentKey path param is required" }, 400);
    }
    let rawBody: unknown;
    try {
      rawBody = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: "request body must be valid JSON" }, 400);
    }
    let body: PutAgentProgressBody;
    try {
      body = parsePutAgentProgressBody(rawBody);
    } catch (err) {
      return c.json({ error: messageOf(err) }, 400);
    }

    // round_agent_progress.round_id is an FK to round_jobs, so a progress row
    // cannot be written before the round is launched.
    const [job] = await db
      .select({ roundId: roundJobs.roundId })
      .from(roundJobs)
      .where(eq(roundJobs.roundId, roundId))
      .limit(1);
    if (job === undefined) {
      return c.json(
        {
          error: `round "${roundId}" has no job — POST /api/portfolio/rounds/${roundId}/job first`,
        },
        404,
      );
    }

    // Update-only: the launch payload pre-creates one row per agent, and it is
    // the sole source of the real `personaKey`. Upserting here would fabricate a
    // row whose `personaKey` is just the `agentKey` and would let a typo'd
    // agentKey invent an agent that was never launched.
    const [updated] = await db
      .update(roundAgentProgress)
      .set({
        status: body.status,
        ...(body.runId !== undefined ? { runId: body.runId } : {}),
        ...(body.picks !== undefined ? { picks: body.picks } : {}),
        ...(body.attempts !== undefined ? { attempts: body.attempts } : {}),
        ...(body.error !== undefined ? { error: body.error } : {}),
        ...(body.startedAt !== undefined ? { startedAt: toDate(body.startedAt) } : {}),
        ...(body.completedAt !== undefined ? { completedAt: toDate(body.completedAt) } : {}),
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(roundAgentProgress.roundId, roundId), eq(roundAgentProgress.agentKey, agentKey)),
      )
      .returning();

    if (updated === undefined) {
      return c.json(
        {
          error: `round "${roundId}" has no agent "${agentKey}" — it must be listed in the POST /job launch payload`,
        },
        404,
      );
    }

    return c.json({ ok: true, agent: toRoundAgentProgressWire(updated) });
  });

export default roundJobsApp;
