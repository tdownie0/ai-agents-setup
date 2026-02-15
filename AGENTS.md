# Project Manual for AI Agents

## 🏗️ Architecture & Context

- **Monorepo**: `/server` (Hono/Drizzle) | `/client` (React/Vite).
- **Env**: Node 24.5.0
- **Runtime Strategy**: 
    - **Execution**: All commands (npm, npx, psql) MUST run inside Docker containers.
- **Editor**: Neovim (vtsls). Follow standard TS patterns for LSP health.

## 🛠️ Specialized Instructions
*Always check these files before modifying code:*
- **DB/Drizzle**: See `.agents/db-tasks.md`
- **Hono/RPC**: See `.agents/api-tasks.md`

## 📋 Rules of Engagement
1. **Plan**: State which files you will touch.
2. **CORS**: Always enable `cors()` on the `*` path in Hono.
3. **RPC**: Use `hc<AppType>` for all frontend-backend communication.

## 🚀 Common Commands
- **Database Migrations**: `docker compose exec -w /app/server app npx drizzle-kit push`
- **Database Seeding**: `docker compose exec -w /app/server app npm run seed`
- **Internal DB URL**: `postgres://user:pass@db:5432/model_md`

## 🌳 Git & Orchestration Strategy
- **Branching**: For every sub-task, create a new branch named `feat/task-description`.
- **Commits**: Use Atomic commits. One commit per logic change.
- **PRs**: Once a sub-task is complete, push the branch and open a PR via `gh pr create`.
- **Worktrees**: If operating in a separate worktree, ensure you run `npm install` if new dependencies were added in the main branch.

## 💾 State & Memory
- **Redis**: The orchestrator uses Redis for shared memory. If you are a "Worker" agent, check the `TODO.md` in the project root to see what the "Planning" agent has assigned to you.
