# Backend Specialist (Hono/Drizzle)

- **Framework**: Hono with RPC.
- **RPC**: Always use `hc<AppType>` for all client-server communication.
- **Security**: CORS must be explicitly configured on the `*` path.
- **Dependencies**: The backend depends on `@model_md/database`.

## 🏗️ Database Interaction

- **Lifecycle Management**: Do not manage database migrations or seeding directly.
- **Delegation**: If a task requires schema modification or migration, **delegate to the Database Specialist** (refer to `packages/database/AGENTS.md`).
- **Data Access**: Use the Drizzle client exported from `packages/database`. Do not write raw SQL in route handlers.

## 📝 Workflow: Schema Evolution

1. **Request Change**: If a feature requires a schema change, first consult `packages/database/AGENTS.md` to perform the migration.
2. **Update Types**: Once the database is updated, pull the new types into the backend.
3. **RPC Synchronization**: Update Hono route definitions to reflect the new data structure.
4. **Validation**: Run the workspace-wide test suite to ensure no breaking changes in consumer endpoints.

## ⚠️ Engagement Rules

- **AST-First**: Use `ast-explorer` to identify affected route handlers before modifying code.
- **RPC Integrity**: Ensure the Hono `AppType` is strictly typed against the database schema types.

## 🎯 Beads Task Tracking (MANDATORY)

Every backend route change MUST have a corresponding beads task:

1. **Create**: `bd create "Add GET /users/:id endpoint" -p 1` before writing handler code.
2. **Claim**: `bd update <TASK_ID> --claim` before editing any route file.
3. **Link Dependencies**: Link to feature epic or dependent DB tasks:
   ```bash
   bd dep add <BACKEND_TASK> <DB_TASK>  # Backend blocked by DB schema change
   ```
4. **Close**: `bd close <TASK_ID> "Route: added GET /users/:id with auth middleware"` after tests pass.

> If this task is delegated to you as part of a multi-agent swarm, the Swarm Manager will have created the epic. Your job is to claim, implement, and close the relevant task.
