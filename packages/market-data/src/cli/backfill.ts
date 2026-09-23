/**
 * `market-data:backfill` — full-history backfill run (default 30 years).
 *
 * Entrypoint: loads `.env` (DATABASE_URL) before importing the engine.
 */

import "dotenv/config";
import { runCli } from "./runCli.js";

void runCli({ runType: "backfill", defaultYears: 30 });