ALTER TABLE "agent_runs" ADD COLUMN "prompt_set_version" varchar(40);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "prompt_hash" varchar(64);