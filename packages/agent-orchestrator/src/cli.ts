/**
 * Analyst orchestrator CLI entrypoint.
 *
 * Usage:
 *   pnpm agents:run -- --round <roundId> [--capital 100000] [--agents all]
 *     [--out ./rounds] [--max-parallel 3]
 *     [--replicate-of <agentKey> --replicates 3]
 *
 * This is the ONLY module that reads `process.env` (DATABASE_URL via
 * `dotenv/config`, mirroring the market-data CLI pattern) and `process.argv`.
 * All library modules receive config as parameters.
 */

import "dotenv/config";
import { resolve } from "node:path";
import { buildDataset } from "./dataset.js";
import { insertRun } from "./insert.js";
import { getPersona, PERSONAS } from "./personas.js";
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
  --out <dir>              Dataset output dir. Default ./rounds.
  --max-parallel <n>       Max simultaneous analyst subagents. Default 3.
  --replicate-of <key>     Run <replicates> consistency copies of this persona
                           (agentKey "<key>#rep<i>", replicateOf=<key>).
  --replicates <n>         Copies when --replicate-of is set. Default 3.
  --help                   Show this help and exit.

Flow: build dataset -> spawn agents (parallel, capped) -> validate -> insert
each -> print summary table.`;

interface AgentJob {
  personaKey: string;
  agentKey: string;
  replicateOf?: string;
}

interface JobResult {
  job: AgentJob;
  ok: boolean;
  picks?: number;
  insertedId?: number;
  error?: string;
}

/** Resolve the agent job list from CLI options. */
function resolveJobs(opts: CliOptions): AgentJob[] {
  if (opts.replicateOf !== undefined) {
    const base = getPersona(opts.replicateOf);
    const jobs: AgentJob[] = [];
    for (let i = 1; i <= opts.replicates; i += 1) {
      jobs.push({
        personaKey: base.key,
        agentKey: `${base.key}#rep${i}`,
        replicateOf: base.key,
      });
    }
    return jobs;
  }

  if (opts.agents === "all") {
    return PERSONAS.map((p) => ({ personaKey: p.key, agentKey: p.key }));
  }
  return opts.agents.map((key) => {
    getPersona(key); // throws on unknown key
    return { personaKey: key, agentKey: key };
  });
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
  const entryPrices: Record<string, number> = {};
  const symbolsWithPrice = new Set<string>();
  for (const entry of dataset.universe) {
    if (entry.hasData && entry.latestClose !== null) {
      entryPrices[entry.symbol] = entry.latestClose;
      symbolsWithPrice.add(entry.symbol);
    }
  }

  const jobs = resolveJobs(opts);
  console.log(`[orchestrator] spawning ${jobs.length} analyst(s)...`);

  const results: JobResult[] = [];

  await runPool(jobs, opts.maxParallel, async (job) => {
    const persona = getPersona(job.personaKey);
    const startedAt = new Date();
    try {
      const spawned = await spawnAnalyst({
        persona,
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
    `${"agentKey".padEnd(22)} ${"persona".padEnd(16)} ${"window".padEnd(9)} ` +
      `${"picks".padEnd(6)} ${"insertedId".padEnd(11)} status`,
  );
  for (const r of results) {
    const persona = getPersona(r.job.personaKey);
    console.log(
      `${r.job.agentKey.padEnd(22)} ${persona.displayName.padEnd(16)} ` +
        `${persona.window.padEnd(9)} ${String(r.picks ?? "-").padEnd(6)} ` +
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