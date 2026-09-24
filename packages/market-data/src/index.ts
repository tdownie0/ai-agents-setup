/**
 * @model_md/market-data — free-data foundation of the daily stock-price
 * ingestion pipeline.
 *
 * Public surface: the `PriceSource` provider seam, the Yahoo Finance adapter
 * (with its typed `PriceSourceError`), the code-owned universe config, and
 * the shared domain types. The ingest engine (beads task `.3`) consumes
 * exactly these exports.
 */

export * from "./types.js";
export * from "./sources/priceSource.js";
export * from "./sources/yahooSource.js";
export * from "./universe.js";
export * from "./ingest/index.js";
