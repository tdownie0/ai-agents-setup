/**
 * Bounded-concurrency pool shared by the round runner.
 *
 * Round *state* deliberately does NOT live here — the docker MCP gateway runs
 * this server as a throwaway container per tool call, so in-process state was
 * unreachable from the next call. Durable progress lives in `RoundStore`.
 */

export type RoundAgentStatus = "pending" | "running" | "inserted" | "failed";

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
