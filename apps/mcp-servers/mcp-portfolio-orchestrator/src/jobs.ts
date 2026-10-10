/**
 * Bounded-concurrency pool shared by the round runner.
 *
 * Round *state* deliberately does NOT live here — the docker MCP gateway runs
 * this server as a throwaway container per tool call, so in-process state was
 * unreachable from the next call. Durable progress lives in `RoundStore`.
 */

export type RoundAgentStatus = "pending" | "running" | "inserted" | "failed" | "not_due";

/**
 * The jobs whose streams the launch gate left `pending` (due this round).
 *
 * The gate stamps streams whose cadence window has not elapsed `not_due`; those
 * must not be spawned — they carry their book forward and are reported settled
 * without an agent call. A job with no matching progress row is launched, since
 * a standalone (non-carryover) round has no gate and no cadence to honour.
 */
export function selectDueJobs<T extends { agentKey: string }>(
  jobs: readonly T[],
  agents: readonly { agentKey: string; status: string }[],
): T[] {
  const dueKeys = new Set(
    agents.filter((agent) => agent.status === "pending").map((agent) => agent.agentKey),
  );
  if (dueKeys.size === 0) return [];
  return jobs.filter((job) => dueKeys.has(job.agentKey));
}

/** Run `fn` over `items` with at most `limit` concurrent executions. */
export async function runPool<T>(
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
