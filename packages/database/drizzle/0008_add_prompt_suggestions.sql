CREATE TABLE "prompt_suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"persona_key" varchar(50) NOT NULL,
	"window" text NOT NULL,
	"prompt_set_version" varchar(40) NOT NULL,
	"source_prompt_hash" varchar(64) NOT NULL,
	"judge_key" varchar(64) NOT NULL,
	"judge_version" varchar(20) NOT NULL,
	"critiques" text NOT NULL,
	"proposals" jsonb NOT NULL,
	"judge_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_suggestions_identity_unique_idx" ON "prompt_suggestions" USING btree ("persona_key","window","prompt_set_version","source_prompt_hash","judge_key","judge_version");