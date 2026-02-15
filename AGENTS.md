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
