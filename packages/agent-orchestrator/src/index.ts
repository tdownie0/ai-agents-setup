/**
 * @model_md/agent-orchestrator — the analyst ingest side of the portfolio
 * simulation.
 *
 * Public surface: the persona catalog, the dataset builder, the decision
 * envelope contract (validation + types), the analyst spawner, and the DB
 * insert with entry fills. The CLI entrypoint (`src/cli.ts`) is run via the
 * `agents:run` script and is intentionally NOT exported here.
 */

export * from "./personas.js";
export { PROMPT_SET_VERSION } from "./promptVersion.js";
export {
  buildDataset,
  DATASET_SCHEMA_VERSION,
  extractEntryContext,
  type AnalystDataset,
  type AnalystSymbolMetrics,
  type BuildDatasetOptions,
  type BuildDatasetResult,
  type DatasetCacheFile,
  type EntryContext,
} from "./dataset.js";
export {
  DECISION_SCHEMA_VERSION,
  DECISION_WINDOWS,
  MIN_PICKS,
  MAX_PICKS,
  TARGET_WEIGHT_MAX,
  WEIGHT_SUM_MIN,
  WEIGHT_SUM_MAX,
  DecisionValidationError,
  validateEnvelope,
  type DecisionAgent,
  type DecisionEnvelope,
  type DecisionHolding,
  type DecisionPosition,
  type DecisionWindow,
  type ValidateEnvelopeOptions,
} from "./contract.js";
export {
  DEFAULT_AGENT_TIMEOUT_MS,
  ENVELOPE_SCHEMA_JSON,
  SpawnAnalystError,
  buildAnalystPrompt,
  buildEnvelopeExample,
  buildSpawnArgs,
  extractJsonFromText,
  formatFailureHint,
  getPromptSetDefinition,
  parseAnalystOutput,
  spawnAnalyst,
  type BuildAnalystPromptOptions,
  type BuildAnalystPromptResult,
  type PromptSetComponent,
  type PromptSetDefinition,
  type SpawnAnalystOptions,
  type SpawnAnalystResult,
} from "./spawn.js";
export {
  DuplicateRunError,
  MissingEntryPriceError,
  insertRun,
  loadRoundBooking,
  type InsertRunOptions,
  type InsertRunResult,
  type RoundBooking,
} from "./insert.js";
