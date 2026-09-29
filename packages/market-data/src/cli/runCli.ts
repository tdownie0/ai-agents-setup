/**
 * Shared CLI runner for the market-data ingestion scripts.
 *
 * This is an ENTRYPOINT: it reads `process.env` (DATABASE_URL via
 * `dotenv/config` in the calling script) and `process.argv`, then passes
 * config into `runIngest` params. Modules under `packages/market-data/src`
 * never read `process.env` themselves.
 */

import { db } from "@model_md/database";
import type { RunType } from "@model_md/database";
import { IngestEngine } from "../ingest/engine.js";
import { YahooSource } from "../sources/yahooSource.js";
import { DEFAULT_UNIVERSE } from "../universe.js";
import { resolveWindow } from "./window.js";

export interface RunCliOptions {
  runType: RunType;
  defaultYears: number;
}

export async function runCli(opts: RunCliOptions): Promise<void> {
  try {
    const { from, to } = resolveWindow(process.argv.slice(2), opts.defaultYears);
    const source = new YahooSource();
    const engine = new IngestEngine();

    const result = await engine.runIngest({
      source,
      universe: DEFAULT_UNIVERSE,
      from,
      to,
      runType: opts.runType,
      db,
    });

    const failed =
      result.failedSymbols.length > 0
        ? `; failed: ${result.failedSymbols.map((f) => f.symbol).join(", ")}`
        : "";
    console.log(
      `[market-data:${opts.runType}] run #${result.runId} finished: ` +
        `${result.symbolsSucceeded}/${result.symbolsRequested} symbols, ` +
        `${result.recordsUpserted} bars upserted${failed}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[market-data:${opts.runType}] failed: ${message}`);
    process.exit(1);
  }
}
