/**
 * The NON-BLIND "prompt-critic" judge: its SUBJECT is the analyst prompt set.
 * Where `scoreRun.buildBlindContext` deliberately withholds the prompt, this
 * judge receives the full static template, its named components, and the
 * prompt-set stamps from `getPromptSetDefinition`.
 *
 * The one boundary it still must respect: it is shown NO run outcomes — no
 * positions, holdings, prices, performance, or dataset paths. Only prompt
 * text and failure error strings go to the model.
 */

import type { PromptSetDefinition } from "@model_md/agent-orchestrator";
import { chatComplete } from "./llmClient.js";

/** Judge key persisted to `prompt_suggestions.judge_key` for this judge. */
export const PROMPT_CRITIC_KEY = "prompt-critic";

/** Critic version persisted to `prompt_suggestions.judge_version`. */
export const CRITIC_VERSION = "1";

/** Prompt component a proposal targets; `scaffolding` covers the shared headers/separators/instructions. */
export type ProposalComponent =
  | "persona_mandate"
  | "complete_book_rule"
  | "envelope_schema"
  | "example_envelope"
  | "scaffolding";

export type ProposalKind = "correct" | "clarify" | "strengthen" | "simplify" | "add";

export type ProposalSeverity = "high" | "medium" | "low";

const PROPOSAL_COMPONENTS: readonly ProposalComponent[] = [
  "persona_mandate",
  "complete_book_rule",
  "envelope_schema",
  "example_envelope",
  "scaffolding",
];

const PROPOSAL_KINDS: readonly ProposalKind[] = [
  "correct",
  "clarify",
  "strengthen",
  "simplify",
  "add",
];

const PROPOSAL_SEVERITIES: readonly ProposalSeverity[] = ["high", "medium", "low"];

/** Hard cap accepted by the parser; the prompt asks for at most this many. */
const MAX_PROPOSALS = 15;

/** One structured edit the critic proposes against the prompt set. */
export interface PromptProposal {
  component: ProposalComponent;
  kind: ProposalKind;
  severity: ProposalSeverity;
  problem: string;
  currentText: string;
  proposedText: string;
  rationale: string;
}

export interface CriticResult {
  critiques: string;
  proposals: PromptProposal[];
}

/** Malformed or off-contract critic output — nothing is persisted when thrown. */
export class CriticOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CriticOutputError";
  }
}

/**
 * One entry of the failure digest the critic may see: a distinct, truncated
 * (`<= 300` chars) `agent_runs.error` sample from failed runs of the same
 * prompt set. `totalFailures` — carried on every entry by
 * `runSuggestionBatch` — is the aggregate failed-run count behind the digest;
 * when absent the digest falls back to the number of samples.
 */
export interface FailureNote {
  error: string;
  totalFailures?: number;
}

/**
 * Serialize exactly what the critic is allowed to see: prompt-set metadata,
 * the labeled components, the full template text, and an optional digest of
 * failure error strings. Never any run outcome — no positions, holdings,
 * prices, or dataset paths (the template carries only its canonical,
 * per-run-independent example state).
 */
export function buildCriticContext(
  def: PromptSetDefinition,
  failures: readonly FailureNote[],
): string {
  const context = {
    personaKey: def.personaKey,
    window: def.window,
    agentKey: def.agentKey,
    promptSetVersion: def.promptSetVersion,
    promptHash: def.promptHash,
    components: def.components.map((component) => ({
      id: component.id,
      label: component.label,
      text: component.text,
    })),
    template: def.template,
    ...(failures.length > 0
      ? {
          failureDigest: {
            totalFailures: failures[0]?.totalFailures ?? failures.length,
            errors: failures.map((failure) => failure.error),
          },
        }
      : {}),
  };
  return JSON.stringify(context, null, 2);
}

export interface CriticPrompt {
  system: string;
  user: string;
}

/** System/user prompt pair for the critic — same shape as `buildJudgePrompt`. */
export function buildCriticPrompt(context: string): CriticPrompt {
  const system = [
    "You are the prompt-critic judge for portfolio-analyst prompt sets.",
    "",
    "You are shown one static prompt set: its metadata (persona, window,",
    "prompt-set version, prompt hash), its named components, the full template",
    "text, and optionally a digest of failure error strings from runs produced",
    "by this prompt. The prompt text is your subject — unlike the process judge,",
    "you are NOT blind to it. You are shown NO run outcomes: no positions, no",
    "holdings, no prices, no performance, no risk metrics, and no dataset paths.",
    "Never speculate about how runs performed; ground every observation in the",
    "prompt text itself or in the failure strings you are given.",
    "",
    "Critique the prompt for ambiguity, internal contradictions, missing",
    "instructions, and places a competent analyst could reasonably misread it.",
    "For each issue propose one concrete edit. Output 1 to 15 proposals:",
    ' component: "persona_mandate" | "complete_book_rule" | "envelope_schema" | "example_envelope" | "scaffolding"',
    ' kind: "correct" (fixes a factual/contract error) | "clarify" (removes ambiguity) | "strengthen" (sharpens a rule) | "simplify" (shortens/clarifies) | "add" (new instruction)',
    ' severity: "high" | "medium" | "low"',
    " problem, proposedText, and rationale must each be a non-empty string;",
    ' currentText is the verbatim excerpt being replaced ("" when kind is "add").',
    "",
    "Output format: respond with ONLY one JSON object, with no prose and no markdown fences:",
    '{"critiques":"<a prose critique of the prompt set>","proposals":[{"component":"<component>","kind":"<kind>","severity":"<severity>","problem":"<what is wrong>","currentText":"<verbatim excerpt or empty>","proposedText":"<replacement or addition>","rationale":"<why this improves the prompt>"}]}',
  ].join("\n");
  const user = `Prompt set to critique:\n\n${context}`;
  return { system, user };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMember<T>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly unknown[]).includes(value);
}

/**
 * Pull the first JSON object out of a fenced/prose-wrapped completion — the
 * same unfence-then-bracket-slice approach the process judge uses.
 */
function extractJsonObject(raw: string): unknown {
  const unfenced = raw
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new CriticOutputError(`critic output contained no JSON object: ${raw.slice(0, 200)}`);
  }
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CriticOutputError(`critic output was not parseable JSON: ${detail}`);
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CriticOutputError(`critic output needs a non-empty "${field}" string`);
  }
  return value;
}

function parseProposal(raw: unknown, index: number): PromptProposal {
  const field = (name: string): string => `proposals[${index}].${name}`;
  if (!isRecord(raw)) {
    throw new CriticOutputError(`proposals[${index}] must be a JSON object`);
  }
  if (!isMember(PROPOSAL_COMPONENTS, raw.component)) {
    throw new CriticOutputError(
      `${field("component")} value ${JSON.stringify(raw.component)} is not a known component`,
    );
  }
  if (!isMember(PROPOSAL_KINDS, raw.kind)) {
    throw new CriticOutputError(
      `${field("kind")} value ${JSON.stringify(raw.kind)} is not a known kind`,
    );
  }
  if (!isMember(PROPOSAL_SEVERITIES, raw.severity)) {
    throw new CriticOutputError(
      `${field("severity")} value ${JSON.stringify(raw.severity)} is not a known severity`,
    );
  }
  if (typeof raw.currentText !== "string") {
    throw new CriticOutputError(`${field("currentText")} must be a string`);
  }
  return {
    component: raw.component,
    kind: raw.kind,
    severity: raw.severity,
    problem: nonEmptyString(raw.problem, field("problem")),
    currentText: raw.currentText,
    proposedText: nonEmptyString(raw.proposedText, field("proposedText")),
    rationale: nonEmptyString(raw.rationale, field("rationale")),
  };
}

/**
 * STRICT all-or-nothing validation of a critic completion: every check must
 * pass before anything is returned — a throw means nothing is persisted.
 * Accepts fenced or prose-wrapped JSON; rejects no JSON, empty/missing
 * `critiques`, non-array/empty `proposals`, more than 15 proposals, unknown
 * enum values, and empty problem/proposedText/rationale.
 */
export function parseCriticOutput(raw: string): CriticResult {
  const parsed = extractJsonObject(raw);
  if (!isRecord(parsed)) {
    throw new CriticOutputError("critic output must be a JSON object");
  }
  const critiques = nonEmptyString(parsed.critiques, "critiques");
  if (!Array.isArray(parsed.proposals)) {
    throw new CriticOutputError('critic output must carry a "proposals" array');
  }
  if (parsed.proposals.length === 0) {
    throw new CriticOutputError('critic output "proposals" must not be empty');
  }
  if (parsed.proposals.length > MAX_PROPOSALS) {
    throw new CriticOutputError(
      `critic output carries ${parsed.proposals.length} proposals — at most ${MAX_PROPOSALS} are accepted`,
    );
  }
  return {
    critiques,
    proposals: parsed.proposals.map((entry, index) => parseProposal(entry, index)),
  };
}

export interface CritiquePromptSetInput {
  definition: PromptSetDefinition;
  failures: readonly FailureNote[];
  model?: string;
}

/**
 * Critique one prompt set: build the (outcome-free) context and prompt, call
 * the shared chat-completions client, and strictly validate the output. A
 * throw here means nothing is persisted.
 */
export async function critiquePromptSet(input: CritiquePromptSetInput): Promise<CriticResult> {
  const context = buildCriticContext(input.definition, input.failures);
  const { system, user } = buildCriticPrompt(context);
  const completion = await chatComplete({
    system,
    user,
    ...(input.model !== undefined ? { model: input.model } : {}),
  });
  return parseCriticOutput(completion);
}
