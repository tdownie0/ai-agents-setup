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

import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db, isTerminalRoundJobStatus, roundAgentProgress, roundJobs } from "@model_md/database";
import type {
  RoundAgentProgress,
  RoundAgentStatus,
  RoundJob,
  RoundJobStatus,
} from "@model_md/database";
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
];

export interface StartRoundBody {
  agents: { agentKey: string; personaKey: string }[];
  maxParallel: number;
  capital: number;
  asOfTradeDate?: string;
  datasetPath?: string;
  takeover: boolean;
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

  return {
    agents,
    maxParallel,
    capital,
    asOfTradeDate: value.asOfTradeDate as string | undefined,
    datasetPath: value.datasetPath as string | undefined,
    takeover: value.takeover === true,
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

    const newJobValues = {
      roundId,
      status: "launching" as const,
      asOfTradeDate: body.asOfTradeDate ?? null,
      datasetPath: body.datasetPath ?? null,
      maxParallel: body.maxParallel,
      capital: String(body.capital),
      error: null,
      startedAt: new Date(),
      completedAt: null,
    };

    // Atomic launch guard: `onConflictDoNothing` + `returning()` collapses the
    // check-then-write race. A concurrent second launch loses the PK conflict,
    // gets zero rows back, and falls into the 409 below — so a round can never
    // be launched twice by two overlapping tool calls.
    const launched = body.takeover
      ? await db
          .insert(roundJobs)
          .values(newJobValues)
          .onConflictDoUpdate({
            target: roundJobs.roundId,
            set: { ...newJobValues, updatedAt: sql`now()` },
          })
          .returning()
      : await db
          .insert(roundJobs)
          .values(newJobValues)
          .onConflictDoNothing({ target: roundJobs.roundId })
          .returning();

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

    // Reset every requested agent to `pending`; this is what makes `takeover`
    // a genuine re-launch instead of a resume of half-written progress.
    for (const agent of body.agents) {
      await db
        .insert(roundAgentProgress)
        .values({
          roundId,
          agentKey: agent.agentKey,
          personaKey: agent.personaKey,
          status: "pending",
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
            status: "pending",
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

    const [job] = await db.select().from(roundJobs).where(eq(roundJobs.roundId, roundId)).limit(1);
    const agents = await db
      .select()
      .from(roundAgentProgress)
      .where(eq(roundAgentProgress.roundId, roundId))
      .orderBy(asc(roundAgentProgress.agentKey));
    return c.json({ ok: true, job: toRoundJobWire(job), agents: agents.map(toRoundAgentProgressWire) }, 201);
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
    return c.json({ roundId, job: toRoundJobWire(job), agents: agents.map(toRoundAgentProgressWire) });
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
      return c.json({ error: `round "${roundId}" has no job — POST /api/portfolio/rounds/${roundId}/job first` }, 404);
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
      return c.json({ error: `round "${roundId}" has no job — POST /api/portfolio/rounds/${roundId}/job first` }, 404);
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
        { error: `round "${roundId}" has no agent "${agentKey}" — it must be listed in the POST /job launch payload` },
        404,
      );
    }

    return c.json({ ok: true, agent: toRoundAgentProgressWire(updated) });
  });

export default roundJobsApp;
