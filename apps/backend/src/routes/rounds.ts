/**
 * Round orchestration RPC routes.
 *
 * The orchestration surface for the forward paper-trading simulation:
 *   GET  /portfolio/dataset-status           - is there enough price data for a round?
 *   POST /portfolio/rounds/:roundId/dataset  - build + persist rounds/<roundId>/dataset.json
 *   GET  /portfolio/rounds/:roundId/dataset  - read a persisted dataset back
 *   GET  /portfolio/rounds/:roundId          - status of all agent runs in the round
 *   POST /portfolio/runs                     - insert one validated envelope at dataset entry fills
 *
 * The persisted dataset.json is the single source of truth for entry fills
 * (asOfTradeDate, symbol closes) and validation context. Callers (the
 * portfolio-orchestrator MCP server) NEVER supply prices — only the envelope.
 * Naming/boundaries mirror the existing marketData/portfolio routes:
 * numeric strings stay strings, aggregate floats become JSON numbers.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { countDistinct, desc, eq, max } from "drizzle-orm";
import { Hono } from "hono";
import { agentRuns, dailyPrices, db } from "@model_md/database";
import type { AgentRun } from "@model_md/database";
import { DEFAULT_UNIVERSE } from "@model_md/market-data";
import type { DbClient } from "@model_md/market-data";
import {
  buildDataset,
  DecisionValidationError,
  DuplicateRunError,
  extractEntryContext,
  insertRun,
  MissingEntryPriceError,
  validateEnvelope,
} from "@model_md/agent-orchestrator";
import type { AnalystDataset, DecisionEnvelope } from "@model_md/agent-orchestrator";

/** Dataset dir names must never escape the rounds root. */
export const ROUND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export class RoundIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoundIdError";
  }
}

export function parseRoundId(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new RoundIdError("roundId must be a non-empty string");
  }
  const roundId = raw.trim();
  if (!ROUND_ID_PATTERN.test(roundId)) {
    throw new RoundIdError(
      `roundId "${roundId}" must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/ (letters, digits, dots, dashes, underscores; no slashes or leading dots)`,
    );
  }
  return roundId;
}

export function resolveRoundsDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.ROUNDS_DIR?.trim();
  return dir && dir.length > 0 ? dir : "/app/rounds";
}

export interface DatasetStatusWire {
  dataReady: boolean;
  symbols: number;
  symbolsWithData: number;
  coveragePct: number;
  asOfTradeDate: string | null;
  generatedAt: string;
}

export function toDatasetStatusWire(input: {
  symbols: number;
  symbolsWithData: number;
  asOfTradeDate: string | null;
}): DatasetStatusWire {
  const coveragePct =
    input.symbols === 0 ? 0 : Math.round((input.symbolsWithData / input.symbols) * 1000) / 10;
  return { ...input, dataReady: input.symbolsWithData > 0, coveragePct, generatedAt: new Date().toISOString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function queryDatasetCounts(
  dbClient: DbClient,
): Promise<{ symbolsWithData: number; asOfTradeDate: string | null }> {
  const [maxRow] = await dbClient
    .select({ asOfTradeDate: max(dailyPrices.tradeDate) })
    .from(dailyPrices);
  const [countRow] = await dbClient
    .select({ symbolsWithData: countDistinct(dailyPrices.instrumentId) })
    .from(dailyPrices);
  return {
    symbolsWithData: countRow?.symbolsWithData ?? 0,
    asOfTradeDate: maxRow?.asOfTradeDate != null ? String(maxRow.asOfTradeDate) : null,
  };
}

const DATASET_SCHEMA_VERSION = 1 as const;

export async function loadDatasetForRound(roundsDir: string, roundId: string): Promise<AnalystDataset> {
  let raw: string;
  try {
    raw = await readFile(join(roundsDir, roundId, "dataset.json"), "utf8");
  } catch {
    throw new Error(`dataset for round "${roundId}" not found — POST /api/portfolio/rounds/${roundId}/dataset first`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`dataset.json for round "${roundId}" is not valid JSON`);
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== DATASET_SCHEMA_VERSION ||
    typeof parsed.roundId !== "string" ||
    typeof parsed.asOfTradeDate !== "string" ||
    parsed.asOfTradeDate.length === 0 ||
    !Array.isArray(parsed.universe)
  ) {
    throw new Error(
      `dataset.json for round "${roundId}" has an unexpected shape (need schemaVersion=${DATASET_SCHEMA_VERSION}, roundId, asOfTradeDate, universe[])`,
    );
  }
  return parsed as unknown as AnalystDataset;
}

export function parseRunInsertBody(value: unknown): { envelope: unknown } {
  if (!isRecord(value)) {
    throw new Error("request body must be a JSON object");
  }
  if (!("envelope" in value)) {
    throw new Error("body.envelope is required — the decision envelope from one analyst subagent");
  }
  return { envelope: value.envelope };
}

export interface RunStatusWire {
  runId: number;
  agentKey: string;
  persona: string;
  strategy: string;
  window: string;
  status: string;
  initialCapital: string;
  replicateOf: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export function toRunStatusWire(run: AgentRun): RunStatusWire {
  const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());
  return {
    runId: run.id,
    agentKey: run.agentKey,
    persona: run.persona,
    strategy: run.strategy,
    window: run.window,
    status: run.status,
    initialCapital: run.initialCapital,
    replicateOf: run.replicateOf,
    startedAt: iso(run.startedAt),
    completedAt: iso(run.completedAt),
    createdAt: run.createdAt.toISOString(),
  };
}

export async function loadRunsByRound(dbClient: DbClient, roundId: string): Promise<AgentRun[]> {
  return dbClient
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.roundId, roundId))
    .orderBy(desc(agentRuns.createdAt));
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const roundsApp = new Hono()
  .get("/dataset-status", async (c) => {
    const { symbolsWithData, asOfTradeDate } = await queryDatasetCounts(db);
    return c.json(toDatasetStatusWire({ symbols: DEFAULT_UNIVERSE.length, symbolsWithData, asOfTradeDate }));
  })

  .post("/rounds/:roundId/dataset", async (c) => {
    let roundId: string;
    try {
      roundId = parseRoundId(c.req.param("roundId"));
    } catch (err) {
      return c.json({ error: messageOf(err) }, 400);
    }
    try {
      const { summary } = await buildDataset({ roundId, outDir: resolveRoundsDir() });
      return c.json({ ok: true, summary }, 201);
    } catch (err) {
      const message = messageOf(err);
      if (message.startsWith("No daily price data found")) {
        return c.json(
          { error: message, hint: "Run market-data ingestion before building a round dataset" },
          409,
        );
      }
      return c.json({ error: message }, 500);
    }
  })

  .get("/rounds/:roundId/dataset", async (c) => {
    let roundId: string;
    try {
      roundId = parseRoundId(c.req.param("roundId"));
    } catch (err) {
      return c.json({ error: messageOf(err) }, 400);
    }
    try {
      const dataset = await loadDatasetForRound(resolveRoundsDir(), roundId);
      return c.json(dataset);
    } catch (err) {
      return c.json(
        { error: messageOf(err), hint: `POST /api/portfolio/rounds/${roundId}/dataset to build it` },
        404,
      );
    }
  })

  .get("/rounds/:roundId", async (c) => {
    let roundId: string;
    try {
      roundId = parseRoundId(c.req.param("roundId"));
    } catch (err) {
      return c.json({ error: messageOf(err) }, 400);
    }
    const runs = await loadRunsByRound(db, roundId);
    return c.json({
      roundId,
      totalRuns: runs.length,
      completedRuns: runs.filter((r) => r.status === "completed").length,
      runs: runs.map(toRunStatusWire),
    });
  })

  .post("/runs", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: "request body must be valid JSON" }, 400);
    }
    let body: { envelope: unknown };
    try {
      body = parseRunInsertBody(rawBody);
    } catch (err) {
      return c.json({ error: messageOf(err) }, 400);
    }

    const rawEnvelope = isRecord(body.envelope) ? body.envelope : null;
    let roundId: string;
    try {
      roundId = parseRoundId(rawEnvelope?.roundId);
    } catch {
      return c.json(
        {
          error:
            "envelope.roundId is missing or invalid — must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/",
          detail: rawEnvelope?.roundId ?? null,
        },
        400,
      );
    }

    let dataset: AnalystDataset;
    try {
      dataset = await loadDatasetForRound(resolveRoundsDir(), roundId);
    } catch (err) {
      return c.json(
        { error: messageOf(err), hint: `POST /api/portfolio/rounds/${roundId}/dataset to build it` },
        409,
      );
    }

    const ctx = extractEntryContext(dataset);
    let envelope: DecisionEnvelope;
    try {
      envelope = validateEnvelope(body.envelope, {
        universe: ctx.universe,
        symbolsWithPrice: ctx.symbolsWithPrice,
      });
    } catch (err) {
      if (err instanceof DecisionValidationError) {
        return c.json({ error: err.message, issues: err.issues }, 400);
      }
      return c.json({ error: messageOf(err) }, 400);
    }

    try {
      const inserted = await insertRun({
        envelope,
        entryPrices: ctx.entryPrices,
        asOfTradeDate: ctx.asOfTradeDate,
      });
      return c.json({ ok: true, ...inserted }, 201);
    } catch (err) {
      if (err instanceof DuplicateRunError) {
        return c.json({ error: err.message, roundId, agentKey: envelope.agent.agentKey }, 409);
      }
      if (err instanceof MissingEntryPriceError) {
        return c.json({ error: err.message }, 422);
      }
      return c.json({ error: messageOf(err) }, 500);
    }
  });

export default roundsApp;