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

// Resolves the current Supabase session token into an Authorization header.
// Returns an empty object when no session is present so public calls work.
export const getAuthHeaders = async (): Promise<Record<string, string>> => {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
};
