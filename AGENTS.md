# Project Manual for AI Agents

## 🏗️ Architecture & Context

- **Monorepo**: `/server` (Hono/Drizzle) | `/client` (React/Vite).
- **Env**: Node 24.5.0 on WSL (Ubuntu). DB on Port 5432.
- **Editor**: Neovim (vtsls). Follow standard TS patterns for LSP health.

## 🛠️ Specialized Instructions
*Always check these files before modifying code:*
- **DB/Drizzle**: See `.agents/db-tasks.md`
- **Hono/RPC**: See `.agents/api-tasks.md`

## 📋 Rules of Engagement
1. **Plan**: State which files you will touch.
2. **CORS**: Always enable `cors()` on the `*` path in Hono.
3. **RPC**: Use `hc<AppType>` for all frontend-backend communication.
