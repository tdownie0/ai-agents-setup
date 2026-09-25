/**
 * In-memory round job state + a bounded concurrency pool.
 *
 * Jobs live only for the server's lifetime (the DB row read via the backend
 * is the durable record of inserted runs). Agent failures are recorded per
 * agent so a round can finish as done / partial / error.
 */

export type AgentProgressStatus = "pending" | "running" | "inserted" | "failed";

export interface AgentProgress {
  personaKey: string;
  agentKey: string;
  status: AgentProgressStatus;
  runId?: number;
  picks?: number;
  attempts?: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export type RoundJobStatus = "launching" | "running" | "done" | "partial" | "error";

export interface RoundJob {
  roundId: string;
  status: RoundJobStatus;
  asOfTradeDate?: string;
  datasetPath?: string;
  agents: AgentProgress[];
  startedAt: string;
  completedAt?: string;
  error?: string;
}

const TERMINAL_STATUSES: readonly RoundJobStatus[] = ["done", "partial", "error"];

export class JobRegistry {
  private readonly jobs = new Map<string, RoundJob>();

  has(roundId: string): boolean {
    return this.jobs.has(roundId);
  }

  start(roundId: string): RoundJob {
    const job: RoundJob = {
      roundId,
      status: "launching",
      agents: [],
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(roundId, job);
    return job;
  }

  get(roundId: string): RoundJob | undefined {
    return this.jobs.get(roundId);
  }

  setStatus(roundId: string, status: RoundJobStatus, error?: string): void {
    const job = this.jobs.get(roundId);
    if (job === undefined) return;
    job.status = status;
    if (error !== undefined) job.error = error;
    if (TERMINAL_STATUSES.includes(status)) {
      job.completedAt = new Date().toISOString();
    }
  }

  setJobInfo(roundId: string, info: { asOfTradeDate: string; datasetPath: string }): void {
    const job = this.jobs.get(roundId);
    if (job === undefined) return;
    job.asOfTradeDate = info.asOfTradeDate;
    job.datasetPath = info.datasetPath;
  }

  setAgents(
    roundId: string,
    agents: readonly { personaKey: string; agentKey: string }[],
  ): void {
    const job = this.jobs.get(roundId);
    if (job === undefined) return;
    job.agents = agents.map((agent) => ({
      personaKey: agent.personaKey,
      agentKey: agent.agentKey,
      status: "pending",
    }));
  }

  updateAgent(roundId: string, agentKey: string, patch: Partial<AgentProgress>): void {
    const job = this.jobs.get(roundId);
    const progress = job?.agents.find((agent) => agent.agentKey === agentKey);
    if (progress === undefined) return;
    Object.assign(progress, patch);
  }

  finalize(roundId: string): void {
    const job = this.jobs.get(roundId);
    if (job === undefined) return;
    const total = job.agents.length;
    const inserted = job.agents.filter((agent) => agent.status === "inserted").length;
    const failed = job.agents.filter((agent) => agent.status === "failed").length;
    if (total === 0) {
      this.setStatus(roundId, "error", "no agents were launched");
      return;
    }
    this.setStatus(roundId, inserted === total ? "done" : failed === total ? "error" : "partial");
  }
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