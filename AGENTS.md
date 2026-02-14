# Project Guidelines for AI Agents

## Hono RPC
- **Backend**: Always export the type of your Hono app instance as `AppType` from the main entry point (e.g., `server/src/index.ts`).
  ```typescript
  const app = new Hono().basePath('/api')
  // ... routes
  export type AppType = typeof app
  ```
- **Frontend**: Import `AppType` in the client and initialize the RPC client using `hc`.
  ```typescript
  import { hc } from 'hono/client'
  import type { AppType } from 'server/src/index.ts'
  const client = hc<AppType>('http://localhost:3000/')
  ```

## Drizzle & Migrations
- **Schema**: Define tables in `server/src/db/schema.ts`.
- **Initialization**: Database connection should be initialized in `server/src/db/index.ts`.
- **Migrations**: Use `drizzle-kit` for managing migrations.
  - `npx drizzle-kit generate`: Create new migration files.
  - `npx drizzle-kit push`: Push schema changes directly to the database (recommended for rapid dev).
  - `npx drizzle-kit migrate`: Apply generated migrations to the database.

## Shared TypeScript Types
- **RPC**: Leverage Hono's RPC for end-to-end type safety between the Hono backend and React frontend.
- **Database Types**: Export Drizzle models (Inferred types) from `server/src/db/schema.ts` if they need to be used explicitly in the client.
  ```typescript
  import { InferSelectModel } from 'drizzle-orm';
  export type User = InferSelectModel<typeof users>;
  ```

## Monorepo Structure
- `/server`: Hono backend with Drizzle ORM.
- `/client`: Vite + React frontend.
- Use workspace references to share code if necessary, though Hono RPC handles most cross-boundary typing.