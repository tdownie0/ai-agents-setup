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

### 2. Frontend Consumption (apps/frontend/src/App.tsx)

Initialize the RPC client using the imported `AppType`.

```typescript
import { hc } from "hono/client";
import type { AppType } from "@model_md/backend";

const client = hc<AppType>("http://localhost:3000/");
```

## ⚠️ Implementation Guardrails

- **CORS**: Ensure `app.use('*', cors())` is called within the `basePath`.
- **Response Format**: Always return `c.json()` for correct type inference.
- **Pathing**: Use `client.api...` to access routes defined under the `/api` base path.
- **AST-First**: Use the AST explorer MCP (`scan_specific_file`, `find_symbol`, `get_dependents`) to identify affected route handlers before modifying code.
- **RPC Integrity**: Ensure the Hono `AppType` is strictly typed against the database schema types. If you make a breaking change, the Frontend Specialist must update the `hc<AppType>` consumption in `apps/frontend/src/`.
