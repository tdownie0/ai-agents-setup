# Project Manual for AI Agents

## 🏗️ Architecture & Context
- **Monorepo**: `/server` (Hono/Drizzle) | `/client` (React/Vite).
- **Execution**: All commands (npm, npx, psql) MUST run inside Docker containers.
- **Editor/LSP**: Neovim (vtsls). Maintain strict TypeScript patterns.

## 🔍 Code Navigation (AST-First)
1. **Index Before Entry**: ALWAYS run `ast-explorer:get_repo_map` on a directory before reading files.
2. **Surgical Analysis**: Do NOT `cat` or `read_file` unless you are actively modifying logic.
3. **Trust the Map**: Signatures and line numbers from the AST map are the "Source of Truth" for file structure. 
4. **Token Efficiency**: Every unneeded file read is a failure in optimization. Use the map to identify the *exact* file and line range needed.

## 📋 Rules of Engagement
1. **Plan**: State which files you will touch based on the AST map discovery.
2. **CORS**: Always enable `cors()` on the `*` path in Hono.
3. **RPC**: Use `hc<AppType>` for all frontend-backend communication.
4. **Git**: Branch per sub-task (`feat/task-desc`), atomic commits, and `gh pr create`.

## 🛠️ Specialized Instructions
*Check these before modification:*
- **DB/Drizzle**: See `.agents/db-tasks.md`
- **Hono/RPC**: See `.agents/api-tasks.md`

## 🌀 Concurrency & Isolation
- **Protocol**: Use the `worktree_orchestration` skill for all feature work.
- **Strict Rule**: Never modify the `main` directory directly for parallel tasks.
- **Workflow**: Initialize worktree -> Symlink node_modules -> Re-anchor AST -> Cleanup on merge.

## 🚀 Common Commands
- **Migrations**: `docker compose exec -w /app/server app npx drizzle-kit push`
- **Seeding**: `docker compose exec -w /app/server app npm run seed`
- **DB URL**: `postgres://user:pass@db:5432/model_md`

## 💾 State & Memory
- **Redis**: Shared memory orchestrator. Check `TODO.md` in root for tasks assigned by the Planning agent.
- **AST Cache**: The `ast-explorer` uses Redis; re-indexing is near-instant.
