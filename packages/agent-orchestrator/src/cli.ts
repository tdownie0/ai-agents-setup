/**
 * Analyst orchestrator CLI entrypoint.
 *
 * Usage:
 *   pnpm agents:run -- --round <roundId> [--capital 100000] [--agents all]
 *     [--window all] [--out ./rounds] [--max-parallel 6]
 *     [--replicate-of <agentKey> --window <window> --replicates 3]
 *
 * This is the ONLY module that reads `process.env` (DATABASE_URL via
 * `dotenv/config`, mirroring the market-data CLI pattern) and `process.argv`.
 * All library modules receive config as parameters.
 */

import "dotenv/config";
import { resolve } from "node:path";
import { buildDataset, extractEntryContext } from "./dataset.js";
import { insertRun } from "./insert.js";
import { agentKeyFor, ANALYST_WINDOWS, getPersona, PERSONAS } from "./personas.js";
import type { AnalystWindow } from "./personas.js";
import { spawnAnalyst } from "./spawn.js";
import { CliArgError, parseCliArgs, type CliOptions } from "./args.js";

const USAGE = `analyst-orchestrator — spawn varied-persona analyst subagents, collect their
JSON portfolio decisions, and insert them into the DB with entry fills.

Usage:
  pnpm agents:run -- --round <roundId> [options]

Options:
  --round <roundId>        Required. Simulation round id (dataset dir name).
  --capital <n>            Starting capital per analyst. Default 100000.
  --agents <keys|all>      Comma-separated persona keys, or "all". Default all.
                           Available: ${PERSONAS.map((p) => p.key).join(", ")}
  --window <keys|all>      Comma-separated rebalance windows, or "all". Default all.
                           Available: ${ANALYST_WINDOWS.join(", ")}
                           Every selected persona runs on every selected window
                           (agentKey "<persona>--<window>"), so the default roster
                           is ${PERSONAS.length} personas x ${ANALYST_WINDOWS.length} windows = ${PERSONAS.length * ANALYST_WINDOWS.length} runs.
  --out <dir>              Dataset output dir. Default ./rounds.
  --max-parallel <n>       Max simultaneous analyst subagents. Default 6.
  --replicate-of <key>     Run <replicates> consistency copies of this persona on a
                           single --window (agentKey "<key>--<window>#rep<i>").
                           Requires an explicit --window.
  --replicates <n>         Copies when --replicate-of is set. Default 3.
  --help                   Show this help and exit.

Flow: build dataset -> spawn agents (parallel, capped) -> validate -> insert
each -> print summary table.`;

interface AgentJob {
  personaKey: string;
  agentKey: string;
  window: AnalystWindow;
  replicateOf?: string;
}

interface JobResult {
  job: AgentJob;
  ok: boolean;
  picks?: number;
  insertedId?: number;
  error?: string;
}

function resolveWindows(opts: CliOptions): AnalystWindow[] {
  if (opts.window === "all") return [...ANALYST_WINDOWS];
  return opts.window.map((raw) => {
    const match = ANALYST_WINDOWS.find((w) => w === raw);
    if (match === undefined) {
      throw new CliArgError(
        `invalid value for --window: "${raw}" (expected one of ${ANALYST_WINDOWS.join(", ")})`,
      );
    }
    return match;
  });
}

/** Resolve the agent job list from CLI options. */
function resolveJobs(opts: CliOptions): AgentJob[] {
  if (opts.replicateOf !== undefined && opts.window === "all") {
    throw new CliArgError(
      "--replicate-of requires an explicit --window: consistency copies spanning several windows are not comparable",
    );
  }

  const windows = resolveWindows(opts);
  const personaKeys = opts.agents === "all" ? PERSONAS.map((p) => p.key) : [...opts.agents];
  for (const key of personaKeys) {
    getPersona(key); // throws on unknown key
  }

  if (opts.replicateOf !== undefined) {
    const base = getPersona(opts.replicateOf);
    const jobs: AgentJob[] = [];
    for (const window of windows) {
      const baseKey = agentKeyFor(base.key, window);
      for (let i = 1; i <= opts.replicates; i += 1) {
        jobs.push({
          personaKey: base.key,
          agentKey: `${baseKey}#rep${i}`,
          window,
          replicateOf: baseKey,
        });
      }
    }
    return jobs;
  }

  return personaKeys.flatMap((personaKey) =>
    windows.map((window) => ({
      personaKey,
      agentKey: agentKeyFor(personaKey, window),
      window,
    })),
  );
}

/** Run `fn` over `items` with at most `limit` concurrent executions. */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    const parsed = parseCliArgs(process.argv.slice(2));
    if ("help" in parsed) {
      console.log(USAGE);
      return;
    }
    opts = parsed;
  } catch (err) {
    if (err instanceof CliArgError) {
      console.error(`error: ${err.message}`);
      console.error(USAGE);
      process.exit(1);
    }
    throw err;
  }

  const worktreeRoot = process.cwd();
  const outDir = resolve(opts.out);

  console.log(
    `[orchestrator] round=${opts.round} capital=${opts.capital} ` +
      `agents=${opts.agents === "all" ? "all" : opts.agents.join(",")} ` +
      `windows=${opts.window === "all" ? "all" : opts.window.join(",")} ` +
      `max-parallel=${opts.maxParallel} out=${outDir}`,
  );

  // 1. Build the self-contained analyst dataset.
  const { dataset, summary } = await buildDataset({
    roundId: opts.round,
    outDir,
  });
  console.log(
    `[orchestrator] dataset ready: ${summary.symbolsWithData}/${summary.symbols} symbols ` +
      `as of ${summary.asOfTradeDate} -> ${summary.datasetPath}`,
  );

  // Entry fills: each symbol's close on the decision date.
  const { entryPrices, symbolsWithPrice } = extractEntryContext(dataset);

  const jobs = resolveJobs(opts);
  console.log(`[orchestrator] spawning ${jobs.length} analyst(s)...`);

  const results: JobResult[] = [];

  await runPool(jobs, opts.maxParallel, async (job) => {
    const persona = getPersona(job.personaKey);
    const startedAt = new Date();
    try {
      const spawned = await spawnAnalyst({
        persona,
        window: job.window,
        agentKey: job.agentKey,
        roundId: opts.round,
        datasetPath: summary.datasetPath,
        asOfTradeDate: summary.asOfTradeDate,
        initialCapital: opts.capital,
        replicateOf: job.replicateOf,
        cwd: worktreeRoot,
        universe: dataset.universe.map((u) => u.symbol),
        symbolsWithPrice,
      });

      const inserted = await insertRun({
        envelope: spawned.envelope,
        entryPrices,
        asOfTradeDate: summary.asOfTradeDate,
        expectedPersona: persona.displayName,
        expectedStrategy: persona.strategy,
        startedAt,
      });

      results.push({
        job,
        ok: true,
        picks: spawned.envelope.picks.length,
        insertedId: inserted.agentRunId,
      });
      console.log(
        `[orchestrator] ${job.agentKey}: ${spawned.envelope.picks.length} picks ` +
          `-> agent_run #${inserted.agentRunId} (attempts=${spawned.attempts})`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ job, ok: false, error: message });
      console.error(`[orchestrator] ${job.agentKey}: FAILED — ${message}`);
    }
  });

  // 3. Summary table.
  console.log("\n=== Analyst Round Summary ===");
  console.log(
    `${"agentKey".padEnd(24)} ${"persona".padEnd(16)} ${"window".padEnd(9)} ` +
      `${"picks".padEnd(6)} ${"insertedId".padEnd(11)} status`,
  );
  for (const r of results) {
    const persona = getPersona(r.job.personaKey);
    console.log(
      `${r.job.agentKey.padEnd(24)} ${persona.displayName.padEnd(16)} ` +
        `${r.job.window.padEnd(9)} ${String(r.picks ?? "-").padEnd(6)} ` +
        `${String(r.insertedId ?? "-").padEnd(11)} ${r.ok ? "ok" : "ERROR"}`,
    );
    if (!r.ok) {
      console.log(`    ${r.error}`);
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n${okCount}/${results.length} analyst runs inserted.`);

  if (okCount < results.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[orchestrator] fatal: ${message}`);
  process.exit(1);
});
