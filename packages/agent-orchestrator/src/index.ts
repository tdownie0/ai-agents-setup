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
export {
  buildDataset,
  DATASET_SCHEMA_VERSION,
  extractEntryContext,
  type AnalystDataset,
  type AnalystSymbolMetrics,
  type BuildDatasetOptions,
  type BuildDatasetResult,
  type EntryContext,
} from "./dataset.js";
export {
  DECISION_SCHEMA_VERSION,
  DECISION_WINDOWS,
  MIN_PICKS,
  MAX_PICKS,
  WEIGHT_SUM_MIN,
  WEIGHT_SUM_MAX,
  DecisionValidationError,
  validateEnvelope,
  type DecisionAgent,
  type DecisionEnvelope,
  type DecisionPick,
  type DecisionWindow,
  type ValidateEnvelopeOptions,
} from "./contract.js";
export {
  DEFAULT_AGENT_TIMEOUT_MS,
  ENVELOPE_EXAMPLE_JSON,
  ENVELOPE_SCHEMA_JSON,
  SpawnAnalystError,
  buildAnalystPrompt,
  buildSpawnArgs,
  extractJsonFromText,
  parseAnalystOutput,
  spawnAnalyst,
  type BuildAnalystPromptOptions,
  type SpawnAnalystOptions,
  type SpawnAnalystResult,
} from "./spawn.js";
export {
  DuplicateRunError,
  MissingEntryPriceError,
  insertRun,
  type InsertRunOptions,
  type InsertRunResult,
} from "./insert.js";
