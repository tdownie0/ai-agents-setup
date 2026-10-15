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
import type { AgentRun, PortfolioWindow } from "@model_md/database";
import { DEFAULT_UNIVERSE } from "@model_md/market-data";
import type { DbClient } from "@model_md/market-data";
import {
  buildDataset,
  DecisionValidationError,
  DuplicateRunError,
  extractEntryContext,
  getPersona,
  insertRun,
  loadRoundBooking,
  MissingEntryPriceError,
  personaKeyFromAgentKey,
  validateEnvelope,
  windowFromAgentKey,
} from "@model_md/agent-orchestrator";
import type { AnalystDataset, DecisionEnvelope, RoundBooking } from "@model_md/agent-orchestrator";
import {
  DuplicateStreamRunError,
  insertRunAndFold,
  loadAgentProgressStatus,
  loadHeldSymbols,
  loadSimulation,
  parseEnvelopeTargets,
  parseEnvelopeTheses,
} from "../portfolio/carryoverStore.js";
import { BackdatedRoundError, type StreamKey } from "../portfolio/carryoverPlan.js";

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

export class AsOfTradeDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsOfTradeDateError";
  }
}

const TRADE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse the optional `asOfTradeDate` body field of a dataset build. Absent (or
 * null) means "use the global latest trade_date". A present value must be a
 * strict `YYYY-MM-DD` calendar date; anything else is a 400.
 */
export function parseAsOfTradeDate(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new AsOfTradeDateError("body.asOfTradeDate must be a YYYY-MM-DD string");
  }
  const value = raw.trim();
  if (!TRADE_DATE_PATTERN.test(value)) {
    throw new AsOfTradeDateError(`body.asOfTradeDate "${raw}" must be a YYYY-MM-DD date`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new AsOfTradeDateError(`body.asOfTradeDate "${raw}" is not a valid calendar date`);
  }
  return value;
}

/**
 * How a round was booked, and therefore which insert path its runs must take.
 *
 * `null` means the round is rejected: a run cannot be attributed to a chain
 * position the `round_jobs` row does not vouch for.
 */
export type BookingClass =
  | { kind: "chained"; simulationId: string; roundSeq: number; asOfTradeDate: string }
  | { kind: "legacy"; roundSeq: number }
  | { kind: "unbooked" }
  | { kind: "undated"; simulationId: string; roundSeq: number };

/**
 * Classify a round from its booking row.
 *
 * A booking with no `simulationId` is a pre-carryover round: it sits outside
 * every chain, so its run is recorded by `insertRun` and advances no state. A
 * chained round must be folded in the same transaction as its insert — the run
 * and the state advance cannot be split, or the chain silently skips a round
 * while the duplicate-run guard blocks every retry.
 *
 * Both rejections are cases where the schema cannot supply an authoritative
 * value: `agent_runs.round_id` has no FK to `round_jobs`, so defaulting the
 * chain position would let two rounds share one, and folding without a decide
 * date has no mark to value the portfolio against.
 */
export function classifyBooking(booking: RoundBooking | null): BookingClass {
  if (booking === null) return { kind: "unbooked" };
  if (booking.simulationId === null) return { kind: "legacy", roundSeq: booking.roundSeq };
  if (booking.asOfTradeDate === null) {
    return { kind: "undated", simulationId: booking.simulationId, roundSeq: booking.roundSeq };
  }
  return {
    kind: "chained",
    simulationId: booking.simulationId,
    roundSeq: booking.roundSeq,
    asOfTradeDate: booking.asOfTradeDate,
  };
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
  return {
    ...input,
    dataReady: input.symbolsWithData > 0,
    coveragePct,
    generatedAt: new Date().toISOString(),
  };
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

export async function loadDatasetForRound(
  roundsDir: string,
  roundId: string,
): Promise<AnalystDataset> {
  let raw: string;
  try {
    raw = await readFile(join(roundsDir, roundId, "dataset.json"), "utf8");
  } catch {
    throw new Error(
      `dataset for round "${roundId}" not found — POST /api/portfolio/rounds/${roundId}/dataset first`,
    );
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

/**
 * The stream a raw envelope addresses, or `null` when it names none (a legacy
 * v1 envelope with no simulation). Used only to load that stream's held symbols
 * for validation.
 */
export function readStreamHint(raw: unknown): StreamKey | null {
  if (!isRecord(raw)) return null;
  const simulationId = raw["simulationId"];
  const agent = isRecord(raw["agent"]) ? raw["agent"] : null;
  const agentKey = agent?.["agentKey"];
  const window = agent?.["window"];
  if (
    typeof simulationId !== "string" ||
    simulationId.length === 0 ||
    typeof agentKey !== "string" ||
    typeof window !== "string"
  ) {
    return null;
  }
  const marker = agentKey.lastIndexOf("--");
  if (marker <= 0) return null;
  return { simulationId, personaKey: agentKey.slice(0, marker), window: window as PortfolioWindow };
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
    return c.json(
      toDatasetStatusWire({ symbols: DEFAULT_UNIVERSE.length, symbolsWithData, asOfTradeDate }),
    );
  })

  .post("/rounds/:roundId/dataset", async (c) => {
    let roundId: string;
    try {
      roundId = parseRoundId(c.req.param("roundId"));
    } catch (err) {
      return c.json({ error: messageOf(err) }, 400);
    }

    let asOfTradeDate: string | undefined;
    const rawBody = await c.req.text();
    if (rawBody.trim().length > 0) {
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return c.json({ error: "request body must be valid JSON" }, 400);
      }
      if (!isRecord(body)) {
        return c.json({ error: "request body must be a JSON object" }, 400);
      }
      try {
        asOfTradeDate = parseAsOfTradeDate(body.asOfTradeDate);
      } catch (err) {
        return c.json({ error: messageOf(err) }, 400);
      }
    }

    try {
      const { summary } = await buildDataset({
        roundId,
        outDir: resolveRoundsDir(),
        ...(asOfTradeDate !== undefined ? { asOfTradeDate } : {}),
      });
      return c.json({ ok: true, summary }, 201);
    } catch (err) {
      const message = messageOf(err);
      if (message.startsWith("No daily price data found")) {
        const hint =
          asOfTradeDate !== undefined
            ? `No price bars exist on or before ${asOfTradeDate}; choose a later asOfTradeDate or ingest earlier data`
            : "Run market-data ingestion before building a round dataset";
        return c.json({ error: message, hint }, 409);
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
        {
          error: messageOf(err),
          hint: `POST /api/portfolio/rounds/${roundId}/dataset to build it`,
        },
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

    // The booking row is the only authority on which chain position a run may be
    // written under, so it is read before validation — the expectations below are
    // derived from it, never from the envelope the caller supplied.
    const booking = classifyBooking(await loadRoundBooking(roundId));
    if (booking.kind === "unbooked") {
      return c.json(
        {
          error: `round "${roundId}" has no round_jobs booking, so no run can be attributed to a chain position`,
          hint: `POST /api/portfolio/rounds/${roundId}/job to launch the round before inserting runs`,
        },
        409,
      );
    }
    if (booking.kind === "undated") {
      return c.json(
        {
          error: `round "${roundId}" is chained to simulation "${booking.simulationId}" but has no round_jobs.as_of_trade_date, so the fold has no mark to value the portfolio against`,
          hint: "Re-launch the round with an asOfTradeDate, or recreate it with takeover=true.",
        },
        409,
      );
    }

    let dataset: AnalystDataset;
    try {
      dataset = await loadDatasetForRound(resolveRoundsDir(), roundId);
    } catch (err) {
      return c.json(
        {
          error: messageOf(err),
          hint: `POST /api/portfolio/rounds/${roundId}/dataset to build it`,
        },
        409,
      );
    }

    const ctx = extractEntryContext(dataset);
    // Envelope v2 treats the payload as a COMPLETE target book, so validation
    // needs the symbols this stream already holds. The stream identity is read
    // off the raw body purely to load that set; the values themselves are still
    // checked by validateEnvelope (simulationId/roundSeq anti-drift, window
    // pinning), so trusting them for a filtered read grants nothing.
    const streamHint = readStreamHint(rawEnvelope);
    // A chained round's simulation comes from the booking, not the body: the
    // held set must be the one the fold will actually advance, and the envelope's
    // copy is unvalidated until validateEnvelope runs below.
    const heldKey =
      streamHint !== null && booking.kind === "chained"
        ? { ...streamHint, simulationId: booking.simulationId }
        : streamHint;
    const heldSymbols = heldKey === null ? new Set<string>() : await loadHeldSymbols(db, heldKey);
    let envelope: DecisionEnvelope;
    try {
      envelope = validateEnvelope(body.envelope, {
        universe: ctx.universe,
        symbolsWithPrice: ctx.symbolsWithPrice,
        heldSymbols,
        ...(booking.kind === "chained" ? { expectedSimulationId: booking.simulationId } : {}),
        expectedRoundSeq: booking.roundSeq,
      });
    } catch (err) {
      if (err instanceof DecisionValidationError) {
        return c.json({ error: err.message, issues: err.issues }, 400);
      }
      return c.json({ error: messageOf(err) }, 400);
    }

    const encodedWindow = windowFromAgentKey(envelope.agent.agentKey);
    if (encodedWindow !== undefined && encodedWindow !== envelope.agent.window) {
      return c.json(
        {
          error: `envelope.agent.window "${envelope.agent.window}" contradicts the window encoded in agentKey "${envelope.agent.agentKey}" ("${encodedWindow}")`,
          issues: [
            `agent.window must match the window encoded in agentKey: expected "${encodedWindow}", got ${JSON.stringify(envelope.agent.window)}`,
          ],
        },
        400,
      );
    }

    const personaKey = personaKeyFromAgentKey(envelope.agent.agentKey);
    if (personaKey === undefined) {
      return c.json(
        {
          error: `agentKey "${envelope.agent.agentKey}" does not name a known analyst persona`,
          hint: 'agentKey must be "<personaKey>--<window>" using a personaKey from the catalog and one of daily|weekly|monthly',
          issues: ["agentKey must begin with a catalog persona key"],
        },
        400,
      );
    }
    const persona = getPersona(personaKey);

    if (booking.kind === "legacy") {
      try {
        const inserted = await insertRun({
          envelope,
          entryPrices: ctx.entryPrices,
          asOfTradeDate: ctx.asOfTradeDate,
          expectedPersona: persona.displayName,
          expectedStrategy: persona.strategy,
          roundSeq: booking.roundSeq,
          simulationId: null,
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
    }

    // Cadence backstop: the launch gate stamps streams whose window has not
    // elapsed as `not_due`, and the orchestrator must not have spawned them. If
    // one posts anyway, refuse before any fold, so a stream can never advance its
    // book ahead of its own review cadence.
    const agentStatus = await loadAgentProgressStatus(db, roundId, envelope.agent.agentKey);
    if (agentStatus === "not_due") {
      return c.json(
        {
          error: `agent "${envelope.agent.agentKey}" is not due to rebalance for its ${envelope.agent.window} window at ${booking.asOfTradeDate}`,
          code: "NOT_DUE",
          hint: "This stream carries its book forward until its cadence window elapses; it decides on a later round.",
        },
        409,
      );
    }

    // A chained round: the run row and the state advance commit together, or the
    // chain silently skips a round while the duplicate guard blocks every retry.
    try {
      // The fold stamps entry fills with the booking's decide date but prices them
      // from the dataset, so the two must agree or every fill is silently mispriced.
      if (ctx.asOfTradeDate !== booking.asOfTradeDate) {
        return c.json(
          {
            error: `round "${roundId}" is booked to decide on ${booking.asOfTradeDate}, but its dataset is priced as of ${ctx.asOfTradeDate}`,
            hint: `Rebuild the dataset for ${booking.asOfTradeDate} (POST /api/portfolio/rounds/${roundId}/dataset) before inserting runs.`,
          },
          409,
        );
      }

      const simulation = await loadSimulation(db, booking.simulationId);
      if (simulation === undefined) {
        return c.json(
          {
            error: `round "${roundId}" is booked to simulation "${booking.simulationId}", which no longer exists`,
            hint: "Re-launch the round with takeover=true against a live simulation.",
          },
          409,
        );
      }

      // insertRunAndFold defaults a missing entry price to zero, which would book
      // a fill at no cost; the legacy path rejects that, so guard it here too.
      const positions = envelope.positions
        .filter((position) => position.targetWeight > 0)
        .map((position) => {
          const entryPrice = ctx.entryPrices[position.symbol];
          if (entryPrice === undefined || !Number.isFinite(entryPrice) || entryPrice <= 0) {
            throw new MissingEntryPriceError(position.symbol, booking.asOfTradeDate);
          }
          return {
            symbol: position.symbol,
            targetWeight: position.targetWeight,
            shares: (envelope.agent.portfolioValue * position.targetWeight) / entryPrice,
            thesis: position.thesis,
          };
        });

      const inserted = await insertRunAndFold(db, {
        simulationId: booking.simulationId,
        roundSeq: booking.roundSeq,
        basisCapital: Number(simulation.initialCapital),
        targets: parseEnvelopeTargets(envelope),
        theses: parseEnvelopeTheses(envelope),
        entryPrices: ctx.entryPrices,
        positions,
        run: {
          roundId,
          agentKey: envelope.agent.agentKey,
          persona: persona.displayName,
          strategy: persona.strategy,
          window: envelope.agent.window,
          portfolioValue: envelope.agent.portfolioValue,
          rationale: envelope.rationale,
          decisionJson: envelope,
          replicateOf: envelope.agent.replicateOf ?? null,
          startedAt: new Date(),
        },
      });
      return c.json(
        {
          ok: true,
          agentRunId: inserted.agentRunId,
          positionsInserted: inserted.positionsInserted,
          state: inserted.state,
        },
        201,
      );
    } catch (err) {
      if (err instanceof DuplicateStreamRunError) {
        return c.json({ error: err.message, roundId, agentKey: envelope.agent.agentKey }, 409);
      }
      if (err instanceof BackdatedRoundError) {
        return c.json(
          {
            error: err.message,
            roundSeq: err.roundSeq,
            streamSeq: err.streamSeq,
            issues: [
              "the carryover fold is forward-only — a round cannot be applied at or before the stream's last applied round_seq",
            ],
          },
          409,
        );
      }
      if (err instanceof MissingEntryPriceError) {
        return c.json({ error: err.message }, 422);
      }
      return c.json({ error: messageOf(err) }, 500);
    }
  });

export default roundsApp;
