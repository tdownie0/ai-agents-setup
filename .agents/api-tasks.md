# API & RPC Skills (Hono)

## 🛠️ Hono RPC Pattern

### 1. Backend Definition (apps/backend/src/index.ts)

Always chain your routes and export the type of that chain as `AppType`.

```typescript
const app = new Hono().basePath("/api");

const routes = app
  .get("/users", async (c) => {
    return c.json(data);
  })

  .post("/users", async (c) => {
    /* ... */
  });

export type AppType = typeof routes;
```

### 2. Frontend Consumption (ACTUAL PATTERN)

The frontend does **not** use `hc()` today (`@hono/client` is not installed). It calls the
backend with `fetch("/api/...")` plus a Supabase Bearer token — see `apps/frontend/src/lib/notifications.ts`
(`getAuthHeaders()` → `Authorization: Bearer <session.access_token>`). In dev, the Vite proxy
(`apps/frontend/vite.config.ts`) forwards `/api` → `http://localhost:3000`. New API calls MUST
follow this fetch+Bearer pattern.

```typescript
// apps/frontend/src/lib/notifications.ts — the pattern to copy
const getAuthHeaders = async () => {
  const { data: { session } } = await supabase.auth.getSession();
  return { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` };
};
// fetch(`${API_BASE}/...`, { method, headers: await getAuthHeaders(), body: JSON.stringify(...) })
```

**Typed RPC (optional, opt-in)**: The backend exports `AppType` and `hc<AppType>` is the future
typed path — but only introduce `hc()` after adding `@hono/client` to the frontend. Do not mix
patterns in one feature: pick fetch+Bearer (current) or hc (after the dependency lands).

## ⚠️ Implementation Guardrails

- **CORS**: Ensure `app.use('*', cors())` is called within the `basePath`.
- **Response Format**: Always return `c.json()` for correct type inference.
- **Pathing**: Routes live under the `/api` base path; frontend calls them via the `/api/...` URL (fetch) or `client.api...` (hc, once added).
- **Auth**: Protected routes use `src/middleware/authMiddleware.ts` (validates the Bearer token via `supabase.auth.getUser`, sets `userId` on the context).
- **AST-First**: Use the AST explorer MCP (`scan_specific_file`, `find_symbol`, `get_dependents`) to identify affected route handlers before modifying code.
- **RPC Integrity**: Ensure the Hono `AppType` is strictly typed against the database schema types. If you make a breaking change to a route, coordinate with the Frontend Specialist (fetch callers must be updated even without `hc`).
