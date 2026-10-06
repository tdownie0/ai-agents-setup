import { hc, type InferResponseType } from "hono/client";
import type { AppType } from "@model_md/backend";
import { supabase } from "./supabase";

// Centralized Hono RPC client. Type-safe against the backend AppType.
// Note: hc() requires a static headers object (no async callback), so auth
// headers are injected per-request via getAuthHeaders() below — components
// and lib modules must NOT re-implement session retrieval manually.
export const client = hc<AppType>("/");

// Wire-format response types derived from AppType. Hono's c.json() serializes
// Date to an ISO string, so createdAt arrives as `string` on the wire — the
// raw `@model_md/database` row types (createdAt: Date) describe the server-
// side in-memory rows and must not be used for API responses.
export type ApiUser = InferResponseType<typeof client.api.users.$get>[number];
export type ApiNotification = InferResponseType<typeof client.api.notifications.$get>[number];

export type ApiLeaderboardRow = InferResponseType<
  typeof client.api.portfolio.leaderboard.$get
>[number];
// GET /agents/:id unions the agent record with `{ error, hint }` for 400/404.
// `Extract` picks the success branch while staying derived from AppType, so a
// backend shape change breaks the build here instead of drifting silently.
type ApiAgentDetailResponse = InferResponseType<
  (typeof client.api.portfolio.agents)[":id"]["$get"]
>;
export type ApiAgentDetail = Extract<ApiAgentDetailResponse, { runId: number }>;

// Carryover surface. Every route below is keyed by simulation, not by run, and
// each one unions its success body with `{ error, hint }` for a 400 simId. The
// `Extract` selectors pick the success branch by a field only that branch has.
export type ApiSimulation = InferResponseType<typeof client.api.portfolio.simulations.$get>[number];

export type ApiStreamSummary = Extract<
  InferResponseType<(typeof client.api.portfolio.simulations)[":simId"]["streams"]["$get"]>,
  readonly { personaKey: string }[]
>[number];

export type ApiStreamDetail = Extract<
  InferResponseType<
    (typeof client.api.portfolio.simulations)[":simId"]["streams"][":personaKey"][":window"]["$get"]
  >,
  { stream: unknown }
>;

export type ApiSimulationRound = Extract<
  InferResponseType<(typeof client.api.portfolio.simulations)[":simId"]["rounds"]["$get"]>,
  readonly { roundSeq: number }[]
>[number];

export type ApiRoundSnapshot = Extract<
  InferResponseType<
    (typeof client.api.portfolio.simulations)[":simId"]["rounds"][":roundSeq"]["$get"]
  >,
  { streams: unknown }
>;

export type ApiLot = ApiStreamDetail["lots"][number];
export type ApiChainEquityPoint = ApiStreamDetail["equitySeries"][number];

export type ApiStreamTransactions = Extract<
  InferResponseType<
    (typeof client.api.portfolio.simulations)[":simId"]["streams"][":personaKey"][":window"]["transactions"]["$get"]
  >,
  { transactions: unknown }
>;
export type ApiTransaction = ApiStreamTransactions["transactions"][number];

// Resolves the current Supabase session token into an Authorization header.
// Returns an empty object when no session is present so public calls work.
export const getAuthHeaders = async (): Promise<Record<string, string>> => {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
};
