# Database Skills (Drizzle & Migrations)

## 📜 Rules
- **Schema**: Define tables in `server/src/db/schema.ts`.
- **Initialization**: DB connection is in `server/src/db/index.ts`.
- **Types**: Export Drizzle models (Inferred types) for client use.

```typescript
import { InferSelectModel } from 'drizzle-orm';
import { users } from './schema';

export type User = InferSelectModel<typeof users>;
```

## 🔄 Commands (Docker-First)
- **Push Schema**: `docker compose exec -w /app/server app npx drizzle-kit push`
- **Seed DB**: `docker compose exec -w /app/server app npm run seed`
- **Inspect DB**: `docker compose exec -T db psql -U user -d model_md`

## ⚠️ Guardrails
- **Environment**: Do NOT run `npx drizzle-kit` locally on the host; always use `docker compose exec`.
- **Database Access**: Always use `-U user -d model_md` when calling `psql`.
- **Naming**: Use `snake_case` for DB columns and `camelCase` for TypeScript.
- **Exports**: Ensure all new tables are exported from `schema.ts`.
