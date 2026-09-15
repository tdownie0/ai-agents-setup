# Frontend Specialist (React/Vite)

- **Framework**: Vite + React + Tailwind CSS. App entry: `src/main.tsx`, root component `src/App.tsx` (session-gated: `Auth` vs logged-in views).
- **UI Components**: Use the primitives in `src/components/ui/` (button, card, input, label, table). Do not hand-roll Tailwind-only replacements when a primitive exists.
- **Auth**: Supabase client in `src/lib/supabase.ts` (`supabase.auth.getSession()`, `onAuthStateChange`). Populate `.env` with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — **never** hardcode keys.
- **Backend Integration — MANDATORY PATTERN**: All frontend API calls MUST use the centralized Hono RPC client exported from `src/lib/api.ts` (`client` = `hc<AppType>("/")`, plus the `getAuthHeaders()` helper that auto-injects the Supabase session Bearer token). **Raw `fetch()` calls to internal `/api/*` routes are forbidden.** Type-safety comes from `@model_md/backend`'s exported `AppType`. In dev the Vite proxy (`vite.config.ts`) forwards `/api` → `http://localhost:3000`. Example:
  ```typescript
  import { client, getAuthHeaders } from "@/lib/api";
  const res = await client.api.notifications.$get({}, { headers: await getAuthHeaders() });
  ```
- **Creating a centralized Hono client**: Do not create new `hc<AppType>` instances in components or modules — always import the singleton from `src/lib/api.ts`. Hono's `hc()` accepts a static headers object (no async callback); inject auth per-request via `getAuthHeaders()`.
- **Data Types**: Use the wire-format types exported from `src/lib/api.ts` (`ApiUser`, `ApiNotification`, etc.) for API responses — these account for serialization (e.g. `Date` → ISO string). Import raw row types from `@model_md/database` only for non-API contexts. **Do not touch `packages/database`** — schema is the Database Specialist's domain.
- **Verification**: `pnpm -w lint` (oxlint), `pnpm -w fmt:check` (oxfmt), and `pnpm --filter @model_md/frontend build` must pass before closing a task.

## 🎯 Beads Task Tracking (MANDATORY)

Every frontend component change MUST have a corresponding beads task:

1. **Create**: `bd create "Build UserProfile card component" -p 2` before writing component code.
2. **Claim**: `bd update <TASK_ID> --claim` before editing any component file.
3. **Link Dependencies**: Link to feature epic or dependent backend tasks:
   ```bash
   bd dep add <FE_TASK> <BE_TASK>  # Frontend blocked by Backend API
   ```
4. **Close**: `bd close <TASK_ID> --reason "Component: UserProfile card with avatar, name, bio"` after rendering verified.

> If this task is delegated to you as part of a multi-agent swarm, the Swarm Manager will have created the epic. Your job is to claim, implement, and close the relevant task.

### Multi-Agent Frontend Swarm

When building complex UIs, frontend work can be split into parallel specialist roles. See [Multi-Agent Swarm Orchestration](../../AGENTS.md#-multi-agent-swarm-orchestration) in the root AGENTS.md for the full protocol.

| Role               | Responsibility                                       | Depends On     |
| ------------------ | ---------------------------------------------------- | -------------- |
| **Designer**       | Wireframes, mockups, design tokens, API contract     | Nothing        |
| **CSS Stylist**    | Tailwind classes, animations, responsive breakpoints | Designer       |
| **HTML Architect** | Component tree, layout structure, data attributes    | Designer       |
| **JS/TS Engineer** | State management, event handlers, API calls, tests   | HTML Architect |

Each role creates a beads task, claims it, checkpoints via gates, and closes when done.
