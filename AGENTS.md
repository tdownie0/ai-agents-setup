# Project Manual: Global Configuration

## 🏗️ Monorepo Orchestration
- **Workflows**: Use `Taskfile.yml` for all cross-package operations.
- **Isolation**: Always use `worktree_orchestration` for concurrent feature development.

## 🔍 Navigation Rules
- **AST-First**: Always use `ast-explorer:get_repo_map` before touching any logic.
- **Caching**: Ensure the Redis-backed AST cache is utilized; do not re-read files if the map is sufficient.

- **Source of Truth**: `TODO.md` in root for global task assignment.
- **Redis**: Shared state orchestrator.
