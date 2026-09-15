# Frontend Specialist (React/Vite)

- **Framework**: Vite + React + Tailwind CSS. App entry: `src/main.tsx`, root component `src/App.tsx` (session-gated: `Auth` vs logged-in views).
- **UI Components**: Use the primitives in `src/components/ui/` (button, card, input, label, table). Do not hand-roll Tailwind-only replacements when a primitive exists.
- **Auth**: Supabase client in `src/lib/supabase.ts` (`supabase.auth.getSession()`, `onAuthStateChange`). Populate `.env` with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — **never** hardcode keys.
- **Backend Integration — ACTUAL PATTERN**: The app talks to the Hono backend with `fetch("/api/...")` plus a Supabase Bearer token, e.g. the helpers in `src/lib/notifications.ts` (`getAuthHeaders()` → `Authorization: Bearer <session.access_token>`). In dev the Vite proxy (`vite.config.ts`) forwards `/api` → `http://localhost:3000`. Follow this pattern for new API calls.
  - **Typed RPC (optional)**: The backend exports `AppType` (`@model_md/backend`) and `hc<AppType>` is the future typed-client path, but `@hono/client` is **not installed** — do not introduce `hc()` without adding the dependency.
- **Data Types**: Import types from `@model_md/database` only (e.g. `Notification`). **Do not touch `packages/database`** — schema is the Database Specialist's domain.
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