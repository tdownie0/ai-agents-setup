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

## 🔄 Commands
- `npx drizzle-kit push`: Push changes directly (Rapid dev).
- `npx drizzle-kit generate`: Create migration files.
- `npx drizzle-kit migrate`: Apply migrations.

## ⚠️ Guardrails
- Use `snake_case` for DB columns and `camelCase` for TypeScript.
- Ensure all new tables are exported from `schema.ts`.
