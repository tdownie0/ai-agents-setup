CREATE TABLE "round_agent_progress" (
	"id" serial PRIMARY KEY NOT NULL,
	"round_id" varchar(64) NOT NULL,
	"agent_key" varchar(120) NOT NULL,
	"persona_key" varchar(120) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_id" integer,
	"picks" integer,
	"attempts" integer,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "round_jobs" (
	"round_id" varchar(64) PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'launching' NOT NULL,
	"as_of_trade_date" date,
	"dataset_path" text,
	"max_parallel" integer NOT NULL,
	"capital" numeric(14, 2) NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "round_agent_progress" ADD CONSTRAINT "round_agent_progress_round_id_round_jobs_round_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."round_jobs"("round_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_agent_progress" ADD CONSTRAINT "round_agent_progress_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "round_agent_progress_round_id_agent_key_unique_idx" ON "round_agent_progress" USING btree ("round_id","agent_key");--> statement-breakpoint
CREATE INDEX "round_agent_progress_round_id_idx" ON "round_agent_progress" USING btree ("round_id");