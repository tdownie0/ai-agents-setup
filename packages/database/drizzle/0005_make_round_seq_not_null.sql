ALTER TABLE "agent_runs" ALTER COLUMN "round_seq" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "round_jobs" ALTER COLUMN "round_seq" SET NOT NULL;