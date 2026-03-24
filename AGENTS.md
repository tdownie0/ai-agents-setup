# 📖 Project Manual: Global Orchestration & AI Governance

## 🚨 CRITICAL: ARCHITECTURAL & OPERATIONAL GUARDRAILS

**STRICT PROHIBITION**: Direct file access to `/app/model_md` is blocked for all development.
All operations MUST be executed within an isolated Git worktree. Never work on features in the
`/app/model_md` directory.

## 🔍 CODE EXPLORATION & ANALYSIS PROTOCOL (Tool-First Policy)

You are an "Architectural Analyst." To maintain system stability, you must follow this exploration hierarchy. **NEVER use glob/read as your first step.**

1. **Perform Initialization**: Make sure to follow the initialization sequence below before using these exploration tools, but do not resort to glob or read until the following MCP tools are used.
2. **Hierarchy Discovery**: Always start by calling `MCP_DOCKER_get_repo_map(path="model_md-worktree-<slug>")`.
3. **Symbol Navigation**: Use `MCP_DOCKER_find_symbol` to locate definitions and `MCP_DOCKER_get_dependents` to analyze impact.

### 🛠️ MANDATORY INITIALIZATION SEQUENCE

Failure to follow this sequence will result in environment drift and mission failure.

1. **Provision**: `MCP_DOCKER_initialize_worktree(feature_slug="feat-<name>")`. Always use this
   process for a new feature implementation, unless otherwise specified to work on an existing
   feature. Additionally, always perform work in this feature directory.
2. **Bootstrap**: `MCP_DOCKER_execute_lifecycle(feature_slug="feat-<name>", action="initialize")`.
3. **Verify**: `MCP_DOCKER_execute_lifecycle(feature_slug="feat-<name>", action="verify")`.
4. **Context Loading**: `MCP_DOCKER_get_repo_map(path="model_md-worktree-<slug>")`.

## 🏗️ Isolated Environment Lifecycle

### 1. Action Library (via `MCP_DOCKER_execute_lifecycle`)

Use the `MCP_DOCKER_execute_lifecycle(feature_slug, action)` tool with the following actions:

- `initialize`: Performs a full DB reset, migration, and seed.
- `generate`: Triggers Prisma/DB code generation.
- `migrate`: Runs database migrations.
- `seed`: Seeds the database with mock data.
- `verify`: Runs database tests and frontend builds.
- `build`: Compiles both frontend and backend assets.

### 2. Validation (The "Smoke Test")

- After any database schema change, execute `MCP_DOCKER_execute_lifecycle(..., action="generate")` and `MCP_DOCKER_execute_lifecycle(..., action="migrate")` to ensure the application layer matches the database state.

---

## 🛡️ Rules of Engagement

- **Secret Blindness**: You are intentionally restricted from reading `.env` files to prevent secret leakage.
- **Config Changes**: If a feature requires a new environment variable, document the requirement in `FEATURE_README.md` and add a placeholder to `.env.example`.
- **Dependency Management**: Use `MCP_DOCKER_execute_lifecycle(..., action="build")` to verify that your new code and dependencies compile successfully.

---

## 📂 Git Governance (via git_ops)

You must use the git_ops tool for all version control.

- **Allowed Commands**: add, commit, status, diff, log, branch.
- **Prohibition**: Never attempt to run raw git commands via a shell; use the provided toolset to ensure pathing and permissions remain intact.
- **Atomic Commits**: Commit logical units frequently. Do not wait until the end of a mission to commit..

---

## 🔍 Navigation & Intelligence

- **AST-First**: Refresh repo maps using `MCP_DOCKER_get_repo_map` after structural changes or package additions.
- **Cross-Boundary Awareness**: Use `MCP_DOCKER_find_symbol` and `MCP_DOCKER_get_dependents` to verify impacts on sibling packages (e.g., checking `packages/database` while in `apps/frontend`).

---

## 📝 DEFINITION OF DONE (DoD)

A mission is complete only when:

1. **Verification**: `MCP_DOCKER_execute_lifecycle(..., action="verify")` returns a zero exit code.
2. **Documentation**: All new architectural decisions are documented in the worktree's `FEATURE_README.md`.
3. **State**: The root `TODO.md` is updated.
4. **Clean-up**: Call `MCP_DOCKER_stop_environment(feature_slug="<slug>")` to free host resources.
