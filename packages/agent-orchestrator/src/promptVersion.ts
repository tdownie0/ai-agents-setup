/**
 * The WHOLE prompt-set version for the analyst pipeline.
 *
 * One label covers every piece of prompt text an analyst run can be built
 * from: the six persona mandates in `personas.ts` (their prose, not the
 * per-window/per-book substitutions), the complete-book rule, the envelope
 * schema text, the example envelope, and the assembly scaffolding in
 * `buildAnalystPrompt` (section headers, separators, fixed instruction
 * sentences).
 *
 * Bump this label on ANY change to that prompt set. The per-run `promptHash`
 * (sha256 of the rendered static template) pins the exact bytes a given run
 * was produced from; this version is the human-facing label of the family
 * those bytes belong to. Persisted to `agent_runs.prompt_set_version`.
 */
export const PROMPT_SET_VERSION = "v1";
