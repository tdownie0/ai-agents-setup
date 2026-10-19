/**
 * Analyst subagent spawner.
 *
 * Runs ONE analyst persona headlessly via `opencode run --format json
 * "<prompt>"` (spawned through node child_process, cwd = worktree root),
 * parses the NDJSON stdout stream, extracts the final text part, parses the
 * JSON decision envelope, validates it against the contract, and retries
 * ONCE with a correction hint on any failure.
 *
 * The `--format json` probe is proven in this environment: it prints one
 * JSON event per line and exits 0. No pty, no `-i`.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  DecisionValidationError,
  validateEnvelope,
  type DecisionEnvelope,
  type DecisionHolding,
  type ValidateEnvelopeOptions,
} from "./contract.js";
import { renderHoldingsDigest, renderHoldingsSection } from "./holdings.js";
import { WINDOW_CADENCE } from "./personas.js";
import type { AnalystPersona, AnalystWindow } from "./personas.js";
import { PROMPT_SET_VERSION } from "./promptVersion.js";

export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000;

export interface SpawnAnalystOptions extends ValidateEnvelopeOptions {
  persona: AnalystPersona;
  /** The rebalance window this run is assigned; injected into the prompt. */
  window: AnalystWindow;
  agentKey: string;
  roundId: string;
  datasetPath: string;
  asOfTradeDate: string;
  portfolioValue: number;
  /**
   * The stream's carried book. Optional so the stateless round-1 path stays
   * callable; a stream with a real book MUST pass it, because the HOLDINGS
   * section and the `{{holdings}}` token both read from here.
   */
  holdings?: readonly DecisionHolding[];
  replicateOf?: string;
  /** Working directory for the opencode process (worktree root). */
  cwd: string;
  /** opencode binary name/path. Default "opencode". */
  opencodeBin?: string;
  /** Per-attempt timeout. Default 10 minutes. */
  timeoutMs?: number;
}

export interface SpawnAnalystResult {
  envelope: DecisionEnvelope;
  rawOutput: string;
  attempts: number;
  /** sha256 hex (64 chars) of the static prompt template this run was produced from. */
  promptHash: string;
  /** `PROMPT_SET_VERSION` of the prompt set this run was produced from. */
  promptSetVersion: string;
}

export class SpawnAnalystError extends Error {
  readonly attempts: number;
  readonly stderr: string;

  constructor(message: string, attempts: number, stderr: string) {
    super(message);
    this.name = "SpawnAnalystError";
    this.attempts = attempts;
    this.stderr = stderr;
  }
}

/** The exact envelope schema embedded in every analyst prompt. */
export const ENVELOPE_SCHEMA_JSON: string = JSON.stringify(
  {
    schemaVersion: 2,
    roundId: "string — the simulation round id",
    simulationId: "string — the simulation this round belongs to",
    roundSeq:
      "number — this round's 1-based position in the chain; copy the number you are given, never parse it out of roundId",
    agent: {
      agentKey: "string — lowercase letters/digits/hyphens, 3-120 chars",
      persona: "string — your persona display name",
      strategy: "string — your strategy label",
      window: '"daily" | "weekly" | "monthly"',
      portfolioValue:
        "number — total value your target weights apply to (cash + holdings), > 0. Echo this exactly.",
      cash: "number — your cash on hand right now, >= 0. Echo this exactly.",
      holdingsValue:
        "number — market value of your open positions right now, >= 0. Echo this exactly.",
      priorRoundId:
        "string | null — the previous round you acted in; null on your first round. Echo this exactly.",
      roundSeq: "number — same roundSeq as the top level. Echo this exactly.",
      replicateOf: "string (optional) — base agentKey when this is a consistency replica",
    },
    rationale: "string — your overall market read and portfolio logic",
    positions: [
      {
        symbol: "string — uppercase ticker",
        targetWeight:
          "number — 0 <= targetWeight <= 1, a share of agent.portfolioValue. > 0 keeps or buys the name; exactly 0 liquidates it entirely. The lines with targetWeight > 0 number 5 to 10 and their weights sum to 1.0 (±0.01); zero-weight exit lines are unlimited and count toward neither bound.",
        thesis: "string — your evidence-based thesis citing dataset metrics",
      },
    ],
  },
  null,
  2,
);

/** Symbols used for the example's keep/buy lines. */
const EXAMPLE_BUY_SYMBOLS = ["KO", "PG", "JNJ", "XOM", "CAT"] as const;

/**
 * Example envelope built from the caller's real identity, never a static one.
 *
 * The exit line is real rather than illustrative: it names a symbol the stream
 * actually holds. An example showing `targetWeight: 0` for a name the model does
 * not hold would teach a violation on round 1, so on a stream's first round (no
 * holdings) the example simply has no exit line.
 */
export function buildEnvelopeExample(opts: {
  agentKey: string;
  persona: string;
  strategy: string;
  window: AnalystWindow;
  roundId: string;
  simulationId?: string;
  roundSeq?: number;
  portfolioValue: number;
  cash?: number;
  holdingsValue?: number;
  priorRoundId?: string | null;
  holdings?: readonly DecisionHolding[];
}): string {
  const exit = (opts.holdings ?? []).find(
    (h) =>
      !EXAMPLE_BUY_SYMBOLS.includes(h.symbol.toUpperCase() as (typeof EXAMPLE_BUY_SYMBOLS)[number]),
  );

  return JSON.stringify(
    {
      schemaVersion: 2,
      roundId: opts.roundId,
      simulationId: opts.simulationId ?? "sim-baseline",
      roundSeq: opts.roundSeq ?? 1,
      agent: {
        agentKey: opts.agentKey,
        persona: opts.persona,
        strategy: opts.strategy,
        window: opts.window,
        portfolioValue: opts.portfolioValue,
        cash: opts.cash ?? 0,
        holdingsValue:
          opts.holdingsValue ??
          (opts.holdings ?? []).reduce((total, h) => total + h.marketValue, 0),
        priorRoundId: opts.priorRoundId ?? null,
        roundSeq: opts.roundSeq ?? 1,
      },
      rationale:
        "Market breadth is stretched; I am buying high-quality franchises trading at deep discounts to their 52-week highs with stabilising momentum.",
      positions: [
        {
          symbol: "KO",
          targetWeight: 0.2,
          thesis:
            "Trades 28% below its 52-week high with RSI-14 at 31; 252d return negative but 63d improving — classic oversold quality franchise.",
        },
        {
          symbol: "PG",
          targetWeight: 0.2,
          thesis:
            "Defensive staple 22% off its high; volatility21d in the bottom quartile; mean-reversion candidate with a durable moat.",
        },
        {
          symbol: "JNJ",
          targetWeight: 0.2,
          thesis:
            "Health Care leader 18% off high, sma50AboveSma200 false but 21d return turning positive — early stabilisation.",
        },
        {
          symbol: "XOM",
          targetWeight: 0.2,
          thesis:
            "Energy major 15% off high with positive 63d momentum; hard-asset value with a dividend backstop.",
        },
        {
          symbol: "CAT",
          targetWeight: 0.2,
          thesis:
            "Industrials bellwether 25% off high; RSI-14 at 28 signals seller exhaustion after a sharp 5d drawdown.",
        },
        ...(exit === undefined
          ? []
          : [
              {
                symbol: exit.symbol,
                targetWeight: 0,
                thesis: `Exiting entirely: ${exit.holdingDays}d held at a ${Math.abs(exit.unrealizedPnlPct).toFixed(1)}% unrealized P&L, and the thesis that justified the entry is no longer supported by the dataset.`,
              },
            ]),
      ],
    },
    null,
    2,
  );
}

export interface BuildAnalystPromptOptions {
  persona: AnalystPersona;
  window: AnalystWindow;
  agentKey: string;
  roundId: string;
  datasetPath: string;
  asOfTradeDate: string;
  /** Total value the target weights apply to (cash + holdings at asOf). */
  portfolioValue: number;
  /** The stream's carried book. Empty on a stream's first round. */
  holdings?: readonly DecisionHolding[];
  simulationId?: string;
  roundSeq?: number;
  priorRoundId?: string | null;
  cash?: number;
  holdingsValue?: number;
  replicateOf?: string;
  /** Appended as a correction hint on the retry attempt. */
  correctionHint?: string;
}

const CADENCE_TOKEN = "{{cadence}}";
const HOLDINGS_TOKEN = "{{holdings}}";

/**
 * The complete-book rule, stated before the schema. This is the one part of the
 * contract an LLM gets wrong by default: told to "pick symbols" it emits a
 * shortlist and treats everything else as unchanged, which under a carried book
 * silently liquidates the names it forgot.
 */
const COMPLETE_BOOK_RULE = [
  'Your "positions" array is your COMPLETE target book for the next mark — it is NOT a list of new buys:',
  "- one line per name you want to KEEP or BUY, with targetWeight > 0;",
  "- one line per name you want to EXIT ENTIRELY, with targetWeight exactly 0;",
  "- there is no side, quantity, delta, or trimFraction field. To trim a position, lower its targetWeight. To exit it, set targetWeight to 0.",
  "- every symbol listed in HOLDINGS MUST have a line in positions. Omitting a holding is a validation error naming that symbol — it is never a silent hold and never an implicit liquidation.",
  "- between 5 and 10 lines must have targetWeight > 0, and those weights must sum to 1.0 (±0.01). Zero-weight exit lines are unlimited and count toward neither bound.",
].join("\n");

/**
 * Literal scaffolding shared by the hashed template and the full prompt
 * assembly below. Both assemblies read these constants — editing a value here
 * changes the prompt AND its hash together.
 */
const SECTION_SEPARATOR = "---";
const DATASET_HEADING = "DATASET";
const HOLDINGS_HEADING = "HOLDINGS";
const OUTPUT_HEADING = "OUTPUT FORMAT (STRICT)";
const EXAMPLE_HEADING = "Example of a valid envelope:";

const DATASET_GUIDANCE_LINES = [
  "Read it with your file-read tool. The earliest row in dataset.json is the decision-date context.",
  "Do not fetch anything from the network or the database — dataset.json is the only truth.",
  "Only consider symbols where hasData is true. Pick 5–10 symbols. Equal-weight or your own weighting allowed; weights MUST sum to 1.0 (±0.01).",
];

const OUTPUT_SCHEMA_INSTRUCTION =
  "Output ONLY a single JSON object matching this exact schema (schemaVersion 2). No prose, no markdown fences, no commentary before or after — the entire response must be parseable as one JSON object:";

/** The window-pinning sentence; only the window varies (a per-window template input). */
function windowPinLine(window: AnalystWindow): string {
  return `Your assigned rebalance window is "${window}". This is the only window you are running — the cadence described in your mandate above applies. You MUST set agent.window to exactly "${window}" in your envelope; any other value is rejected.`;
}

/**
 * Canonical run-state pinned into the template's example envelope so the hash
 * never sees per-run values (see `hashPromptTemplate`). Everything else the
 * example carries — agentKey, persona, strategy, window — is template input.
 */
const TEMPLATE_EXAMPLE_ROUND_ID = "prompt-template";
const TEMPLATE_EXAMPLE_PORTFOLIO_VALUE = 100000;

/**
 * The STATIC rendered template — the hash input for `promptHash`.
 *
 * Assembles exactly the prompt-set content named in `hashPromptTemplate`'s
 * locked recipe: the persona mandate with ONLY `{{cadence}}` substituted (the
 * `{{holdings}}` token stays literal), the shared scaffolding, the
 * complete-book rule, the envelope schema, and the example envelope with its
 * run-state pinned to canonical values. `buildAnalystPrompt` renders the full
 * prompt from the same constants, interleaving the volatile per-run sections —
 * edit BOTH assemblies together.
 */
function buildPromptTemplate(opts: BuildAnalystPromptOptions): string {
  const mandate = opts.persona.phdSystemPrompt
    .split(CADENCE_TOKEN)
    .join(WINDOW_CADENCE[opts.window]);

  return [
    mandate,
    "",
    SECTION_SEPARATOR,
    DATASET_HEADING,
    ...DATASET_GUIDANCE_LINES,
    "",
    windowPinLine(opts.window),
    "",
    SECTION_SEPARATOR,
    HOLDINGS_HEADING,
    "",
    COMPLETE_BOOK_RULE,
    "",
    SECTION_SEPARATOR,
    OUTPUT_HEADING,
    OUTPUT_SCHEMA_INSTRUCTION,
    ENVELOPE_SCHEMA_JSON,
    "",
    EXAMPLE_HEADING,
    buildEnvelopeExample({
      agentKey: opts.agentKey,
      persona: opts.persona.displayName,
      strategy: opts.persona.strategy,
      window: opts.window,
      roundId: TEMPLATE_EXAMPLE_ROUND_ID,
      portfolioValue: TEMPLATE_EXAMPLE_PORTFOLIO_VALUE,
    }),
  ].join("\n");
}

/**
 * sha256 hex (64 chars, utf8) of the STATIC rendered template — the
 * `promptHash` stamped on every agent run.
 *
 * LOCKED RECIPE — the hashed payload is the template from
 * `buildPromptTemplate`:
 *
 * IN (hashed):
 * - the persona mandate with ONLY `{{cadence}}` substituted (cadence is the
 *   per-window template input; `{{holdings}}` stays literal),
 * - `COMPLETE_BOOK_RULE`,
 * - `ENVELOPE_SCHEMA_JSON`,
 * - the example envelope, with its run-state pinned to canonical values
 *   (roundId, simulationId, roundSeq, priorRoundId, portfolioValue, cash,
 *   holdingsValue, holdings → no exit line) and its persona/window identity
 *   taken from the caller — persona and window are template inputs, not run
 *   state,
 * - the literal scaffolding strings used by `buildAnalystPrompt` (section
 *   headers, separators, fixed instruction sentences).
 *
 * OUT (volatile per-run inputs, never hashed): the holdings digest,
 * portfolioValue, roundId, simulationId, correctionHint, asOfTradeDate —
 * anything that varies run-to-run for the same prompt set. The full prompt is
 * rendered from the template by interleaving those sections.
 *
 * Only this digest and `PROMPT_SET_VERSION` are persisted — never the built
 * prompt text itself.
 */
function hashPromptTemplate(template: string): string {
  return createHash("sha256").update(template, "utf8").digest("hex");
}

export interface BuildAnalystPromptResult {
  /** The full prompt text handed to the analyst subagent. */
  prompt: string;
  /** sha256 hex (64 chars) of the static rendered template — see `hashPromptTemplate`. */
  promptHash: string;
  /** `PROMPT_SET_VERSION` of the prompt set this prompt was assembled from. */
  promptSetVersion: string;
}

/**
 * Build the full prompt handed to the headless analyst subagent, plus the
 * prompt-set stamp (`promptHash`, `promptSetVersion`) recorded with the run.
 */
export function buildAnalystPrompt(opts: BuildAnalystPromptOptions): BuildAnalystPromptResult {
  const promptHash = hashPromptTemplate(buildPromptTemplate(opts));

  const replicateLine =
    opts.replicateOf !== undefined
      ? `\nYou are a consistency replica of "${opts.replicateOf}": apply the SAME methodology and reach your own independent conclusion — do not copy, but stay methodologically faithful.`
      : "";

  const correction =
    opts.correctionHint !== undefined
      ? `\n\nCORRECTION FROM THE PREVIOUS ATTEMPT:\n${opts.correctionHint}\nFix the output accordingly and output ONLY the corrected JSON object.`
      : "";

  const holdings = opts.holdings ?? [];
  const streamState = [
    `simulationId="${opts.simulationId ?? "sim-baseline"}"`,
    `roundSeq=${opts.roundSeq ?? 1}`,
    `priorRoundId=${JSON.stringify(opts.priorRoundId ?? null)}`,
    `cash=${(opts.cash ?? Math.max(0, opts.portfolioValue - holdingsValue(holdings))).toFixed(2)}`,
    `holdingsValue=${(opts.holdingsValue ?? holdingsValue(holdings)).toFixed(2)}`,
  ].join(", ");

  const mandate = opts.persona.phdSystemPrompt
    .split(CADENCE_TOKEN)
    .join(WINDOW_CADENCE[opts.window])
    .split(HOLDINGS_TOKEN)
    .join(renderHoldingsDigest(holdings, opts.portfolioValue));

  const prompt = [
    mandate,
    "",
    SECTION_SEPARATOR,
    DATASET_HEADING,
    `You are analyzing data as of ${opts.asOfTradeDate}. The dataset file is at:`,
    opts.datasetPath,
    ...DATASET_GUIDANCE_LINES,
    "",
    `Your identity for this run: agentKey="${opts.agentKey}", roundId="${opts.roundId}", portfolioValue=${opts.portfolioValue}.${replicateLine}`,
    windowPinLine(opts.window),
    `Your stream state, which you must echo verbatim into the envelope: ${streamState}.`,
    "",
    SECTION_SEPARATOR,
    HOLDINGS_HEADING,
    renderHoldingsSection(holdings, opts.portfolioValue),
    "",
    COMPLETE_BOOK_RULE,
    "",
    SECTION_SEPARATOR,
    OUTPUT_HEADING,
    OUTPUT_SCHEMA_INSTRUCTION,
    ENVELOPE_SCHEMA_JSON,
    "",
    EXAMPLE_HEADING,
    buildEnvelopeExample({
      agentKey: opts.agentKey,
      persona: opts.persona.displayName,
      strategy: opts.persona.strategy,
      window: opts.window,
      roundId: opts.roundId,
      portfolioValue: opts.portfolioValue,
      ...(opts.simulationId === undefined ? {} : { simulationId: opts.simulationId }),
      ...(opts.roundSeq === undefined ? {} : { roundSeq: opts.roundSeq }),
      ...(opts.priorRoundId === undefined ? {} : { priorRoundId: opts.priorRoundId }),
      ...(opts.cash === undefined ? {} : { cash: opts.cash }),
      ...(opts.holdingsValue === undefined ? {} : { holdingsValue: opts.holdingsValue }),
      holdings,
    }),
    correction,
  ].join("\n");

  return { prompt, promptHash, promptSetVersion: PROMPT_SET_VERSION };
}

function holdingsValue(holdings: readonly DecisionHolding[]): number {
  return holdings.reduce((total, h) => total + h.marketValue, 0);
}

/**
 * Build the exact argv for the proven headless invocation:
 * `opencode run --format json "<prompt>"`.
 */
export function buildSpawnArgs(prompt: string): string[] {
  return ["run", "--format", "json", prompt];
}

/**
 * Parse the NDJSON stdout stream from `opencode run --format json`.
 * Returns the text of the LAST event with `type: "text"`.
 */
export function parseAnalystOutput(stdout: string): string {
  let lastText: string | null = null;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // non-JSON line (e.g. stray log) — ignore
    }
    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;
    if (record.type !== "text") continue;
    const part = record.part as Record<string, unknown> | undefined;
    const text =
      typeof part?.text === "string"
        ? part.text
        : typeof record.text === "string"
          ? record.text
          : null;
    if (text !== null && text.trim().length > 0) {
      lastText = text;
    }
  }
  if (lastText === null) {
    throw new Error(
      "No text event found in opencode output — the analyst produced no parseable response",
    );
  }
  return lastText;
}

/**
 * Strip markdown code fences (```json ... ```) if present — even when
 * surrounded by prose — then JSON.parse.
 */
export function extractJsonFromText(text: string): unknown {
  let cleaned = text.trim();
  const fenceStart = cleaned.indexOf("```");
  if (fenceStart !== -1) {
    const afterStart = cleaned.slice(fenceStart + 3);
    const firstLineEnd = afterStart.indexOf("\n");
    const bodyStart = firstLineEnd === -1 ? 0 : firstLineEnd + 1;
    const fenceEnd = afterStart.lastIndexOf("```");
    if (fenceEnd > bodyStart) {
      cleaned = afterStart.slice(bodyStart, fenceEnd).trim();
    }
  }
  return JSON.parse(cleaned);
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

/** Spawn a process, collect stdout/stderr, enforce a timeout. */
function runProcess(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`opencode run timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(`Failed to spawn "${bin}": ${err.message}. Is opencode installed and on PATH?`),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `opencode run exited with code ${code}${stderr ? `: ${stderr.trim().slice(0, 500)}` : ""}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Run ONE analyst: spawn opencode, parse + validate the envelope, retry once
 * with a correction hint on failure.
 */
export async function spawnAnalyst(opts: SpawnAnalystOptions): Promise<SpawnAnalystResult> {
  const bin = opts.opencodeBin ?? "opencode";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const maxAttempts = 2;

  let lastFailure: unknown = null;
  let lastStderr = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { prompt, promptHash, promptSetVersion } = buildAnalystPrompt({
      persona: opts.persona,
      window: opts.window,
      agentKey: opts.agentKey,
      roundId: opts.roundId,
      datasetPath: opts.datasetPath,
      asOfTradeDate: opts.asOfTradeDate,
      portfolioValue: opts.portfolioValue,
      holdings: opts.holdings,
      replicateOf: opts.replicateOf,
      correctionHint:
        attempt > 1 && lastFailure !== null ? formatFailureHint(lastFailure) : undefined,
    });

    const { stdout, stderr } = await runProcess(bin, buildSpawnArgs(prompt), opts.cwd, timeoutMs);
    lastStderr = stderr;

    try {
      const text = parseAnalystOutput(stdout);
      const parsed = extractJsonFromText(text);
      const envelope = validateEnvelope(parsed, {
        universe: opts.universe,
        symbolsWithPrice: opts.symbolsWithPrice,
        heldSymbols: opts.heldSymbols,
        expectedWindow: opts.window,
      });
      return { envelope, rawOutput: stdout, attempts: attempt, promptHash, promptSetVersion };
    } catch (err) {
      lastFailure = err;
      if (attempt === maxAttempts) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new SpawnAnalystError(
          `Analyst "${opts.agentKey}" failed after ${maxAttempts} attempts: ${detail}`,
          maxAttempts,
          lastStderr,
        );
      }
    }
  }

  throw new SpawnAnalystError(
    `Analyst "${opts.agentKey}" failed unexpectedly`,
    maxAttempts,
    lastStderr,
  );
}

/** Human-readable correction hint fed back to the analyst on retry. */
export function formatFailureHint(err: unknown): string {
  if (err instanceof DecisionValidationError) {
    return `Your previous output failed validation:\n${err.issues.map((i) => `- ${i}`).join("\n")}\nRe-read the schema and re-emit a fully valid envelope.`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Your previous output could not be parsed as a valid decision envelope: ${message}. Re-read the schema and re-emit ONLY the JSON object.`;
}
