CREATE TABLE "agent_portfolio_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"simulation_id" varchar(64) NOT NULL,
	"persona_key" varchar(120) NOT NULL,
	"window" text NOT NULL,
	"seq" integer NOT NULL,
	"last_trade_date" date NOT NULL,
	"last_round_id" varchar(64),
	"initial_capital" numeric(14, 2) NOT NULL,
	"cash" numeric(16, 4) DEFAULT '0' NOT NULL,
	"holdings_value" numeric(18, 4) DEFAULT '0' NOT NULL,
	"total_value" numeric(18, 4) DEFAULT '0' NOT NULL,
	"target_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_equity_daily" (
	"id" serial PRIMARY KEY NOT NULL,
	"state_id" integer NOT NULL,
	"trade_date" date NOT NULL,
	"cash" numeric(18, 4) NOT NULL,
	"holdings_value" numeric(18, 4) NOT NULL,
	"total_value" numeric(18, 4) NOT NULL,
	"round_seq" integer
);
--> statement-breakpoint
CREATE TABLE "portfolio_position_lots" (
	"id" serial PRIMARY KEY NOT NULL,
	"state_id" integer NOT NULL,
	"symbol" varchar(16) NOT NULL,
	"shares" numeric(18, 6) DEFAULT '0' NOT NULL,
	"cost_basis" numeric(16, 6) DEFAULT '0' NOT NULL,
	"target_weight" numeric(7, 6) DEFAULT '0' NOT NULL,
	"opened_from_round_id" varchar(64) NOT NULL,
	"opened_trade_date" date NOT NULL,
	"last_trade_date" date,
	"last_price" numeric(12, 4),
	"realized_pnl" numeric(16, 4) DEFAULT '0' NOT NULL,
	"thesis" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "simulations" (
	"id" serial PRIMARY KEY NOT NULL,
	"sim_id" varchar(64) NOT NULL,
	"label" text,
	"initial_capital" numeric(14, 2) DEFAULT '100000' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "simulations_sim_id_unique" UNIQUE("sim_id")
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "simulation_id" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "round_seq" integer;--> statement-breakpoint
ALTER TABLE "round_jobs" ADD COLUMN "simulation_id" varchar(64);--> statement-breakpoint
ALTER TABLE "round_jobs" ADD COLUMN "round_seq" integer;--> statement-breakpoint
ALTER TABLE "round_jobs" ADD COLUMN "advance_mode" text DEFAULT 'carry' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_portfolio_state" ADD CONSTRAINT "agent_portfolio_state_simulation_id_simulations_sim_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "public"."simulations"("sim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_equity_daily" ADD CONSTRAINT "portfolio_equity_daily_state_id_agent_portfolio_state_id_fk" FOREIGN KEY ("state_id") REFERENCES "public"."agent_portfolio_state"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_position_lots" ADD CONSTRAINT "portfolio_position_lots_state_id_agent_portfolio_state_id_fk" FOREIGN KEY ("state_id") REFERENCES "public"."agent_portfolio_state"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_portfolio_state_stream_unique_idx" ON "agent_portfolio_state" USING btree ("simulation_id","persona_key","window");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_equity_daily_state_date_unique_idx" ON "portfolio_equity_daily" USING btree ("state_id","trade_date");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_position_lots_state_symbol_unique_idx" ON "portfolio_position_lots" USING btree ("state_id","symbol");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_simulation_id_simulations_sim_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "public"."simulations"("sim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_jobs" ADD CONSTRAINT "round_jobs_simulation_id_simulations_sim_id_fk" FOREIGN KEY ("simulation_id") REFERENCES "public"."simulations"("sim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_stream_seq_idx" ON "agent_runs" USING btree ("simulation_id","agent_key","round_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "round_jobs_simulation_round_seq_unique_idx" ON "round_jobs" USING btree ("simulation_id","round_seq");--> statement-breakpoint
ALTER TABLE "round_jobs" ADD CONSTRAINT "round_jobs_advance_mode_chk" CHECK ("round_jobs"."advance_mode" IN ('fresh','carry'));