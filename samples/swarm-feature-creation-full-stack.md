# Swarm Feature Creation: Full-Stack User Preferences System

## Overview

This sample walks through the **Swarm Feature Creator** pipeline for a multi-layer feature touching database, backend, and frontend. It demonstrates the full lifecycle from raw feature request to integrated delivery using beads tasks, gates, and wave-based execution.

**Feature:** Add a User Preferences system where users can set theme (light/dark), language, and notification preferences. Store in DB. Provide API. Show in UI.

**Feature Slug:** `feat-user-preferences`

**Applied Protocol:** `.agents/beads-enforcement.md`
**Reference Sample:** `samples/multi-agent-swarm-frontend.md` (frontend-only variation)

---

## Phase 0: Request Analysis (Swarm Feature Creator)

The Swarm Feature Creator classifies the incoming request before work begins.

| Dimension | Value |
|-----------|-------|
| Type | `multi-layer` (DB + Backend + Frontend) |
| Complexity | Medium - 3 layers, no external APIs, no auth changes |
| Technologies | `packages/database`, `apps/backend`, `apps/frontend` |
| Risk | Low - additive, no existing tables modified |
| Parallelism | High - DB and UI research can run in parallel |

### Dependency Chain

```
DB Schema → API Endpoints → UI Components → Integration
(no deps)    (blocked by DB) (blocked by API) (blocked by all)
```

---

## Phase 1: Research (Researcher Agent)

The Researcher explores the codebase to find existing patterns, producing a gate note consumed by all downstream agents.

### Research Gate Note

```
Gate: research-user-preferences
Status: OPEN

Found patterns:
  Schema (packages/database/src/schema/users.ts):
    Lines 12-45: Table users with id, email, name, timestamps
    Uses drizzle-orm/pg-core with uuid PKs
    Timestamps use timestamp().defaultNow()

  Schema (packages/database/src/schema/notifications.ts):
    Lines 8-30: Separate table with FK to users.id, onDelete cascade
    Pattern: foreignKey(() => usersTable.id), pgTable with snake_case

  Routes (apps/backend/src/routes/users.ts):
    Lines 15-60: GET/PUT /users/:id with auth middleware
    Pattern: hono RPC with zValidator for input validation
    Error: { success: false, error: string }

  UI (apps/frontend/src/components/Auth.tsx):
    Lines 30-80: hc<AppType> for typed RPC calls
    Pattern: @tanstack/react-query with useQuery/useMutation

Decision: Separate preferences table with FK to users (not JSON column)
  Rationale: Queryable, type-safe, follows notifications.ts pattern
  Columns: user_id (FK), theme, language, notification_enabled, created_at, updated_at
```

### Tool Call Limit Recovery

If the Researcher hits its tool call limit:

```
Researcher: 35/50 calls used, 3 of 4 areas complete
└── Missing: UI exploration
    → Subdivide: spawn new Researcher for UI patterns
    → Re-merge findings into same gate note
```

---

## Phase 2: Beads DAG Creation (Swarm Feature Creator)

### Create Epic and Tasks

```bash
bd create "Epic: User Preferences System" --mol-type=swarm -p 0
# ✓ model_md-...bd-epic-preferences-a7d2

bd create "Add user_preferences table to schema" -p 0 --parent bd-epic-preferences-a7d2
# bd-pref-db → model_md-...bd-pref-db
bd create "Build preferences API endpoints" -p 1 --parent bd-epic-preferences-a7d2
# bd-pref-api → model_md-...bd-pref-api
bd create "Build preferences UI components" -p 1 --parent bd-epic-preferences-a7d2
# bd-pref-ui → model_md-...bd-pref-ui
bd create "Integration and verification" -p 2 --parent bd-epic-preferences-a7d2
# bd-pref-integrate → model_md-...bd-pref-integrate
```

### Link Dependencies

```bash
bd dep add bd-pref-api bd-pref-db         # API blocked by DB
bd dep add bd-pref-ui bd-pref-api         # UI blocked by API
bd dep add bd-pref-integrate bd-pref-ui   # Integration blocked by UI
bd dep add bd-pref-integrate bd-pref-db   # Integration also blocked by DB
```

### Create Gates and Validate

```bash
bd gate create "contract-preferences-api" \
  --description "API response shapes for preferences endpoints"
bd gate create "contract-preferences-schema" \
  --description "Table name, columns, types for user_preferences"

bd swarm validate bd-epic-preferences-a7d2
# ✓ Ready fronts: 1 (Wave 1: DB)
# ✓ Maximum parallelism: 1 (sequential waves)
# ✓ No cycles detected

bd swarm create bd-epic-preferences-a7d2 --coordinator=manager/
```

---

## Phase 3: Wave Execution

### Wave 1: Database Specialist

```bash
bd ready  # → bd-pref-db
bd update model_md-...bd-pref-db --claim
bd gate wait "research-user-preferences"  # Read existing patterns
```

Work performed:
1. Create `packages/database/src/schema/preferences.ts` (follows `notifications.ts` FK pattern)
2. Export from `packages/database/src/index.ts`
3. Run `pnpm db:generate --name=add_user_preferences`
4. Inspect SQL in `drizzle/`, run `pnpm db:migrate`, verify with `pnpm test:db`

```bash
bd gate open "contract-preferences-schema" "
Table: user_preferences
Columns: id (uuid PK), user_id (uuid FK→users, unique), theme (text),
         language (text), notification_enabled (boolean), created_at, updated_at
File: packages/database/src/schema/preferences.ts
"

bd close model_md-...bd-pref-db \
  "Schema: created user_preferences table with FK, migration applied, tests passing"
```

### Wave 2: Backend Specialist

```bash
bd gate wait "contract-preferences-schema"  # Read schema contract
bd ready  # → bd-pref-api
bd update model_md-...bd-pref-api --claim
```

Work performed:
1. Create `apps/backend/src/routes/preferences.ts` (follows `users.ts` CRUD pattern)
2. Implement: `GET /api/preferences`, `PUT /api/preferences`, `GET /api/preferences/:userId`
3. Add `zValidator` schemas for input validation
4. Wire up auth middleware

```bash
bd gate open "contract-preferences-api" "
GET  /api/preferences          → { success: true, data: UserPreferences }
PUT  /api/preferences          → { success: true, data: UserPreferences }
GET  /api/preferences/:userId  → { success: true, data: UserPreferences }

UserPreferences: { id, userId, theme, language, notificationEnabled, createdAt, updatedAt }
PUT body: { theme?, language?, notificationEnabled? }
Errors: { success: false, error: string }
"

bd close model_md-...bd-pref-api \
  "Routes: GET/PUT /api/preferences with auth, validation, typed responses"
```

### Wave 3: Frontend Specialist

```bash
bd gate wait "contract-preferences-api"  # Read API contract
bd ready  # → bd-pref-ui
bd update model_md-...bd-pref-ui --claim
```

Work performed:
1. Create components in `apps/frontend/src/components/Preferences/` (`SettingsPanel`, `ThemeSelector`, `LanguageSelect`, `NotificationToggle`)
2. Wire up `hc<AppType>` typed RPC calls with `@tanstack/react-query`

```bash
bd close model_md-...bd-pref-ui \
  "UI: Preferences panel with theme, language, notification controls via RPC typed calls"
```

---

## Phase 4: Integration

### Create Integration Worktree

```bash
MCP_DOCKER_initialize_worktree(feature_slug="feat-integration-preferences")
MCP_DOCKER_git_ops(feature_slug="feat-integration-preferences",
  command="merge", git_args=["feat-user-preferences"])
```

### Run Quality Gates

```bash
MCP_DOCKER_execute_lifecycle(feature_slug="feat-integration-preferences", action="generate")
MCP_DOCKER_execute_lifecycle(feature_slug="feat-integration-preferences", action="migrate")
MCP_DOCKER_execute_lifecycle(feature_slug="feat-integration-preferences", action="verify")
MCP_DOCKER_execute_lifecycle(feature_slug="feat-integration-preferences", action="build")
MCP_DOCKER_execute_lifecycle(feature_slug="feat-integration-preferences", action="format")
```

### Epic Closure

```bash
bd epic status bd-epic-preferences-a7d2
# bd-pref-db       [closed] Schema created, migration applied
# bd-pref-api      [closed] API endpoints with auth and validation
# bd-pref-ui       [closed] UI components with RPC integration
# bd-pref-integrate [closed] Integration verified, build passes

bd epic close-eligible bd-epic-preferences-a7d2
bd close bd-epic-preferences-a7d2 \
  "Epic complete: User Preferences system with DB schema, API, and UI"
```

---

## Full Delegation Template

```typescript
task(subagent_type="oracle", run_in_background=true,
  prompt="
GOAL: Create user_preferences table with user_id FK, theme, language, notif columns
SUCCESS: Schema file created, migration generated and applied, test passes
FILE: packages/database/src/schema/preferences.ts
EXISTING PATTERNS: packages/database/src/schema/notifications.ts (FK, timestamp)
SCOPE IN: Only schema, no API, no UI
TOOL CALL BUDGET: 20
CHECKPOINT GATE: checkpoint-db-preferences
RESEARCH GATE: research-user-preferences
CONTRACT GATE: contract-preferences-schema
DEPENDENCY TASK: bd-pref-db
BEADS EPIC: bd-epic-preferences-a7d2
")
```

---

## Summary

### DAG Structure

```
bd-epic-preferences-a7d2
├── bd-pref-db (P0) [Schema]          ← no deps
├── bd-pref-api (P1) [API Routes]     ← blocked by bd-pref-db
├── bd-pref-ui (P1) [UI Components]   ← blocked by bd-pref-api
└── bd-pref-integrate (P2) [Verify]   ← blocked by bd-pref-db, bd-pref-ui
```

### Gates

| Gate | Creator | Consumer | Content |
|------|---------|----------|---------|
| `research-user-preferences` | Researcher | All | Codebase patterns, decisions |
| `contract-preferences-schema` | DB Specialist | Backend | Table columns, types, FK |
| `contract-preferences-api` | Backend Specialist | Frontend | Endpoints, shapes, errors |
| `checkpoint-db-preferences` | Swarm Feature Creator | DB | Tool call limit recovery |

### Comparison: Frontend-Only vs Full-Stack

| Dimension | Frontend Swarm (sample) | Full-Stack Swarm (this) |
|-----------|------------------------|-------------------------|
| Layers | 1 (UI only) | 3 (DB + API + UI) |
| Parallelism | 2 (CSS + HTML) | Sequential waves |
| Gates | Design + component API | Schema + API contract |
| Researcher | Optional | Mandatory (cross-stack) |
| Integration | Component verification | Full-stack verification |

### References

- `.agents/beads-enforcement.md` - Full protocol for beads and swarm management
- `samples/multi-agent-swarm-frontend.md` - Frontend-only swarm with designer pattern
- `packages/database/AGENTS.md` - Database specialist instructions
- `apps/backend/AGENTS.md` - Backend specialist instructions
- `apps/frontend/AGENTS.md` - Frontend specialist instructions
