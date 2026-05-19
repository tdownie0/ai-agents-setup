# Pi Agent Instructions

## Project Context

This is **AI-Agents-Setup** - a containerized development environment with AI agent orchestration.

## Critical Rules

1. **NEVER work directly in /app/model_md**. Always use isolated Git worktrees.
2. **Beads (bd CLI) MUST be used for ALL feature development**. Create tasks with `bd create` before writing code.
3. **Follow beads enforcement policy** for every task: create → claim → work → close.
4. **All MCP tools are accessed through the mcp-gateway** at http://mcp-gateway:8811/sse.
5. **Lifecycle actions** must use `MCP_DOCKER_execute_lifecycle` for DB and build operations.
6. **Git operations** must use `MCP_DOCKER_git_ops`.
7. **Code exploration** must use `MCP_DOCKER_get_repo_map` first, then targeted tools.

## Workflow

1. Research/explore first via MCP tools
2. Plan with beads tasks
3. Implement in isolated worktrees
4. Commit and verify
