CREATE TABLE "agent_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"round_id" varchar(64) NOT NULL,
	"agent_key" varchar(120) NOT NULL,
	"persona" varchar(200) NOT NULL,
	"strategy" varchar(60) NOT NULL,
	"window" text NOT NULL,
	"initial_capital" numeric(14, 2) DEFAULT '100000' NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"rationale" text,
	"decision_json" jsonb,
	"error" text,
	"replicate_of" varchar(120),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_run_id" integer NOT NULL,
	"symbol" varchar(16) NOT NULL,
	"target_weight" numeric(7, 6) NOT NULL,
	"shares" numeric(18, 6),
	"entry_trade_date" date,
	"entry_price" numeric(12, 4),
	"thesis" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portfolio_positions" ADD CONSTRAINT "portfolio_positions_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_round_id_agent_key_unique_idx" ON "agent_runs" USING btree ("round_id","agent_key");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_positions_agent_run_id_symbol_unique_idx" ON "portfolio_positions" USING btree ("agent_run_id","symbol");