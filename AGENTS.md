# Project Manual: Global Configuration

## 🏗️ Monorepo Orchestration
- **Standard Tooling**: Always prefer the `task` CLI for environment operations.
- **Environment Management**:
  - To spin up a new feature environment: 
    Run `task up BRANCH=<feature-name> BACKEND_PORT=<port> FRONTEND_PORT=<port>`.
  - To tear down an environment: 
    Add a `down` command to your `Taskfile` (e.g., `task down BRANCH=<feature-name>`) and use it when finished.
- **Rules of Engagement**:
  - Do not call `docker-compose` directly.
  - If a feature requires specific environment variables, define them in a `.env.<branch>` file and instruct the user to verify them before running `task up`.
  - When switching features, verify the active containers using `docker ps` before starting new ones to avoid port collisions.
- **Isolation Protocol**: Use `Worktree-Orchestrator`.
    - **Step 1**: `initialize_worktree(feature_slug)` (No slashes; use hyphens).
    - **Step 2**: Re-anchor via `ast-explorer:get_repo_map(path="model_md-worktree-<slug>")`.
- **Environment**: Inherits shared `.env` and hard-linked `node_modules` from the global `~/.pnpm-store`.

## 🛡️ Git Governance & Guardrails
- **Branching Strategy**: Use flat naming conventions (e.g., `feat-registration-supabase-auth-setup`). Never use `/` in branch names or worktree slugs.
- **Git Operations**: All Git commands (add, commit, status, diff, log, branch) must be executed exclusively via `git_ops`. Do not attempt to run system-level `git` commands.
- **Commit Frequency**: Use `git_ops` to commit logical units of work frequently within the worktree.
- **Merge Logic**: 
    - For feature composition: Call `prepare_merge` to verify the worktree is clean, then call `execute_merge` to integrate progress.
    - **Safety Override**: Any merge attempt targeting `main`, `master`, or `prod` is hard-blocked at the tool level; these require a manual pull request or human-assisted merge.

## 🔍 Navigation Rules
- **AST-First**: Always use `ast-explorer:get_repo_map` before touching logic. 
- **Cross-Boundary Awareness**: Use `ast-explorer` to read sibling worktrees if a feature has cross-package dependencies (e.g., checking the `backend` worktree's types while working in the `frontend` worktree).

## 📝 State Management
- **Source of Truth**: `TODO.md` in root for global task assignment.
- **Worktree Tracking**: Keep a record of active worktree slugs in the Redis-backed shared state to avoid collisions.
