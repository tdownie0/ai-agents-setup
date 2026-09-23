/**
 * `market-data:update` — incremental update run (default 5 years).
 *
 * Entrypoint: loads `.env` (DATABASE_URL) before importing the engine.
 */

import "dotenv/config";
import { runCli } from "./runCli.js";

void runCli({ runType: "update", defaultYears: 5 });