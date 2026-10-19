CREATE TABLE "run_eval_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_run_id" integer NOT NULL,
	"judge_key" varchar(64) NOT NULL,
	"judge_version" varchar(20) NOT NULL,
	"scores" jsonb NOT NULL,
	"verdict" text NOT NULL,
	"judge_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_eval_scores" ADD CONSTRAINT "run_eval_scores_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_eval_scores_agent_run_id_judge_key_judge_version_unique_idx" ON "run_eval_scores" USING btree ("agent_run_id","judge_key","judge_version");