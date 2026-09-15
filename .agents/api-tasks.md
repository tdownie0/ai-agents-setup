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

### 2. Frontend Consumption (MANDATORY PATTERN)

All frontend API calls MUST use the centralized Hono RPC client exported from
`apps/frontend/src/lib/api.ts` (`client` = `hc<AppType>("/")`, plus the `getAuthHeaders()` helper
that resolves the Supabase session Bearer token). **Raw `fetch()` calls to internal `/api/*` routes
are forbidden**, as are new inline `hc<AppType>` instances in components or modules.

In dev, the Vite proxy (`apps/frontend/vite.config.ts`) forwards `/api` → `http://localhost:3000`.

```typescript
// apps/frontend/src/lib/api.ts — the singleton all modules must import from
import { hc } from "hono/client";
import type { AppType } from "@model_md/backend";
import { supabase } from "./supabase";

export const client = hc<AppType>("/");

export const getAuthHeaders = async (): Promise<Record<string, string>> => {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
};
```

```typescript
// Usage in any module/component
import { client, getAuthHeaders } from "@/lib/api";
const res = await client.api.notifications.$get({}, { headers: await getAuthHeaders() });
```

Note: Hono's `hc()` accepts a static `HeadersInit` object (no async callback) — auth is
injected per-request via `getAuthHeaders()`.

## ⚠️ Implementation Guardrails

- **CORS**: Ensure `app.use('*', cors())` is called within the `basePath`.
- **Response Format**: Always return `c.json()` for correct type inference.
- **Pathing**: Routes live under the `/api` base path; frontend calls them via `client.api...` (RPC).
- **Auth**: Protected routes use `src/middleware/authMiddleware.ts` (validates the Bearer token via `supabase.auth.getUser`, sets `userId` on the context).
- **AST-First**: Use the AST explorer MCP (`scan_specific_file`, `find_symbol`, `get_dependents`) to identify affected route handlers before modifying code.
- **RPC Integrity**: Ensure the Hono `AppType` is strictly typed against the database schema types. If you make a breaking change to a route, coordinate with the Frontend Specialist (RPC callers in `apps/frontend` must be updated).
