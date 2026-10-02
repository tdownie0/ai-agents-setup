/**
 * Portfolio carryover — the carried book, as a MATERIALIZED CACHE.
 *
 * These three tables are NOT an authoritative ledger. They are a rebuildable
 * projection of a deterministic fold computed by the backend from `agent_runs`
 * + `portfolio_positions` + `daily_prices` (see the design spec §4). That is
 * deliberate: `replace` a round, delete a stream, or replay from round 1 are
 * all the *same* code path (`rebuildStream`), so the cache and the fold cannot
 * drift, and rollback needs no snapshot table.
 *
 * A "stream" is one (persona, window) pair inside a simulation. One row of
 * `agent_portfolio_state` per stream holds the opening book of the next round;
 * `portfolio_position_lots` holds the open lots with cost basis that survives
 * across runs; `portfolio_equity_daily` is the chain equity curve, so the
 * 18-stream board is one cheap read.
 */

import type { InferSelectModel } from "drizzle-orm";
import {
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import type { PortfolioWindow } from "./portfolio.js";
import { simulations } from "./simulations.js";

/**
 * The carried opening book for one (simulation, persona, window) stream.
 *
 * `seq` is the last applied `round_seq` — the fold is forward-only, and the
 * rerun policy rejects a back-dated round whose `asOfTradeDate` is not strictly
 * after `lastTradeDate`. `targetJson` is the complete target book currently in
 * force (`[{ symbol, targetWeight }]`, `targetWeight: 0` = liquidated).
 */
export const agentPortfolioState = pgTable(
  "agent_portfolio_state",
  {
    id: serial("id").primaryKey(),
    simulationId: varchar("simulation_id", { length: 64 })
      .notNull()
      .references(() => simulations.simId, { onDelete: "cascade" }),
    personaKey: varchar("persona_key", { length: 120 }).notNull(),
    window: text("window").notNull().$type<PortfolioWindow>(),
    /** Last applied `round_seq`; the chain position of this book. */
    seq: integer("seq").notNull(),
    /**
     * US equity session calendar date (America/New_York close date) the book
     * was last marked at; never derived from UTC. Gates the next round's
     * sequence check.
     */
    lastTradeDate: date("last_trade_date").notNull(),
    lastRoundId: varchar("last_round_id", { length: 64 }),
    /**
     * CHAIN BASIS — the simulation's starting capital. Copied once from
     * `simulations.initial_capital` and NEVER changed by a fold step, unlike
     * `agent_runs.initial_capital`, which holds the per-decision portfolio
     * value the weights were applied to. Every `returnPct` in the chain is
     * measured against this number.
     */
    initialCapital: numeric("initial_capital", { precision: 14, scale: 2 }).notNull(),
    cash: numeric("cash", { precision: 16, scale: 4 }).notNull().default("0"),
    holdingsValue: numeric("holdings_value", { precision: 18, scale: 4 }).notNull().default("0"),
    totalValue: numeric("total_value", { precision: 18, scale: 4 }).notNull().default("0"),
    /** Complete target book in force: `[{ symbol, targetWeight }]`. */
    targetJson: jsonb("target_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One carried book per stream.
    uniqueIndex("agent_portfolio_state_stream_unique_idx").on(
      table.simulationId,
      table.personaKey,
      table.window,
    ),
  ],
);

export type AgentPortfolioState = InferSelectModel<typeof agentPortfolioState>;

/**
 * Open lots with cost basis surviving across runs.
 *
 * `costBasis` is the per-share, shares-weighted average (a partial trim blends
 * the new fill into the remaining basis; a full liquidation zeroes the lot).
 * `targetWeight` mirrors the in-force target so the drilldown can show intent
 * next to position, and `realizedPnl` accumulates trims on this line.
 */
export const portfolioPositionLots = pgTable(
  "portfolio_position_lots",
  {
    id: serial("id").primaryKey(),
    stateId: integer("state_id")
      .notNull()
      .references(() => agentPortfolioState.id, { onDelete: "cascade" }),
    symbol: varchar("symbol", { length: 16 }).notNull(),
    shares: numeric("shares", { precision: 18, scale: 6 }).notNull().default("0"),
    costBasis: numeric("cost_basis", { precision: 16, scale: 6 }).notNull().default("0"),
    targetWeight: numeric("target_weight", { precision: 7, scale: 6 }).notNull().default("0"),
    openedFromRoundId: varchar("opened_from_round_id", { length: 64 }).notNull(),
    openedTradeDate: date("opened_trade_date").notNull(),
    lastTradeDate: date("last_trade_date"),
    lastPrice: numeric("last_price", { precision: 12, scale: 4 }),
    realizedPnl: numeric("realized_pnl", { precision: 16, scale: 4 }).notNull().default("0"),
    thesis: text("thesis"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One open lot per symbol per stream.
    uniqueIndex("portfolio_position_lots_state_symbol_unique_idx").on(table.stateId, table.symbol),
  ],
);

export type PortfolioPositionLot = InferSelectModel<typeof portfolioPositionLots>;

/**
 * Chain equity curve, one row per stream per marked trade date.
 *
 * Materialized so the 18-stream board never folds over all bars on read.
 * `roundSeq` is the chain position in force on that date (null for dates
 * before the first decision); the curve is contiguous and date-deduplicated
 * because segment k opens the trading day after segment k-1's decide date.
 */
export const portfolioEquityDaily = pgTable(
  "portfolio_equity_daily",
  {
    id: serial("id").primaryKey(),
    stateId: integer("state_id")
      .notNull()
      .references(() => agentPortfolioState.id, { onDelete: "cascade" }),
    tradeDate: date("trade_date").notNull(),
    cash: numeric("cash", { precision: 18, scale: 4 }).notNull(),
    holdingsValue: numeric("holdings_value", { precision: 18, scale: 4 }).notNull(),
    totalValue: numeric("total_value", { precision: 18, scale: 4 }).notNull(),
    roundSeq: integer("round_seq"),
  },
  (table) => [
    // One equity point per stream per trade date; the fold re-folds in place.
    uniqueIndex("portfolio_equity_daily_state_date_unique_idx").on(table.stateId, table.tradeDate),
  ],
);

export type PortfolioEquityDaily = InferSelectModel<typeof portfolioEquityDaily>;
