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
import {
  DecisionValidationError,
  validateEnvelope,
  type DecisionEnvelope,
  type ValidateEnvelopeOptions,
} from "./contract.js";
import { WINDOW_CADENCE } from "./personas.js";
import type { AnalystPersona, AnalystWindow } from "./personas.js";

export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000;

export interface SpawnAnalystOptions extends ValidateEnvelopeOptions {
  persona: AnalystPersona;
  /** The rebalance window this run is assigned; injected into the prompt. */
  window: AnalystWindow;
  agentKey: string;
  roundId: string;
  datasetPath: string;
  asOfTradeDate: string;
  initialCapital: number;
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
    schemaVersion: 1,
    roundId: "string — the simulation round id",
    agent: {
      agentKey: "string — lowercase letters/digits/hyphens, 3-120 chars",
      persona: "string — your persona display name",
      strategy: "string — your strategy label",
      window: '"daily" | "weekly" | "monthly"',
      initialCapital: "number — the starting capital for this round",
      replicateOf: "string (optional) — base agentKey when this is a consistency replica",
    },
    rationale: "string — your overall market read and portfolio logic",
    picks: [
      {
        symbol: "string — uppercase ticker from the dataset",
        weight: "number — 0 < weight <= 1, all weights sum to 1.0 (±0.01)",
        thesis: "string — your evidence-based thesis citing dataset metrics",
      },
    ],
  },
  null,
  2,
);

/** Example envelope built from the caller's real identity, never a static one. */
export function buildEnvelopeExample(opts: {
  agentKey: string;
  persona: string;
  strategy: string;
  window: AnalystWindow;
  roundId: string;
  initialCapital: number;
}): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      roundId: opts.roundId,
      agent: {
        agentKey: opts.agentKey,
        persona: opts.persona,
        strategy: opts.strategy,
        window: opts.window,
        initialCapital: opts.initialCapital,
      },
      rationale:
        "Market breadth is stretched; I am buying high-quality franchises trading at deep discounts to their 52-week highs with stabilising momentum.",
      picks: [
        {
          symbol: "KO",
          weight: 0.2,
          thesis:
            "Trades 28% below its 52-week high with RSI-14 at 31; 252d return negative but 63d improving — classic oversold quality franchise.",
        },
        {
          symbol: "PG",
          weight: 0.2,
          thesis:
            "Defensive staple 22% off its high; volatility21d in the bottom quartile; mean-reversion candidate with a durable moat.",
        },
        {
          symbol: "JNJ",
          weight: 0.2,
          thesis:
            "Health Care leader 18% off high, sma50AboveSma200 false but 21d return turning positive — early stabilisation.",
        },
        {
          symbol: "XOM",
          weight: 0.2,
          thesis:
            "Energy major 15% off high with positive 63d momentum; hard-asset value with a dividend backstop.",
        },
        {
          symbol: "CAT",
          weight: 0.2,
          thesis:
            "Industrials bellwether 25% off high; RSI-14 at 28 signals seller exhaustion after a sharp 5d drawdown.",
        },
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
  initialCapital: number;
  replicateOf?: string;
  /** Appended as a correction hint on the retry attempt. */
  correctionHint?: string;
}

const CADENCE_TOKEN = "{{cadence}}";

/** Build the full prompt handed to the headless analyst subagent. */
export function buildAnalystPrompt(opts: BuildAnalystPromptOptions): string {
  const replicateLine =
    opts.replicateOf !== undefined
      ? `\nYou are a consistency replica of "${opts.replicateOf}": apply the SAME methodology and reach your own independent conclusion — do not copy, but stay methodologically faithful.`
      : "";

  const correction =
    opts.correctionHint !== undefined
      ? `\n\nCORRECTION FROM THE PREVIOUS ATTEMPT:\n${opts.correctionHint}\nFix the output accordingly and output ONLY the corrected JSON object.`
      : "";

  const mandate = opts.persona.phdSystemPrompt
    .split(CADENCE_TOKEN)
    .join(WINDOW_CADENCE[opts.window]);

  return [
    mandate,
    "",
    "---",
    "DATASET",
    `You are analyzing data as of ${opts.asOfTradeDate}. The dataset file is at:`,
    opts.datasetPath,
    "Read it with your file-read tool. The earliest row in dataset.json is the decision-date context.",
    "Do not fetch anything from the network or the database — dataset.json is the only truth.",
    "Only consider symbols where hasData is true. Pick 5–10 symbols. Equal-weight or your own weighting allowed; weights MUST sum to 1.0 (±0.01).",
    "",
    `Your identity for this run: agentKey="${opts.agentKey}", roundId="${opts.roundId}", initialCapital=${opts.initialCapital}.${replicateLine}`,
    `Your assigned rebalance window is "${opts.window}". This is the only window you are running — the cadence described in your mandate above applies. You MUST set agent.window to exactly "${opts.window}" in your envelope; any other value is rejected.`,
    "",
    "---",
    "OUTPUT FORMAT (STRICT)",
    "Output ONLY a single JSON object matching this exact schema (schemaVersion 1). No prose, no markdown fences, no commentary before or after — the entire response must be parseable as one JSON object:",
    ENVELOPE_SCHEMA_JSON,
    "",
    "Example of a valid envelope:",
    buildEnvelopeExample({
      agentKey: opts.agentKey,
      persona: opts.persona.displayName,
      strategy: opts.persona.strategy,
      window: opts.window,
      roundId: opts.roundId,
      initialCapital: opts.initialCapital,
    }),
    correction,
  ].join("\n");
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
    const prompt = buildAnalystPrompt({
      persona: opts.persona,
      window: opts.window,
      agentKey: opts.agentKey,
      roundId: opts.roundId,
      datasetPath: opts.datasetPath,
      asOfTradeDate: opts.asOfTradeDate,
      initialCapital: opts.initialCapital,
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
        expectedWindow: opts.window,
      });
      return { envelope, rawOutput: stdout, attempts: attempt };
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
