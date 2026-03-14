# Project Manual: Global Configuration

# 🚨 CRITICAL: OPERATIONAL GUARDRAILS (READ FIRST)

## 🛑 STOP! YOU ARE PROHIBITED FROM CODING IN ROOT
You are strictly forbidden from performing any file writes, edits, or service start-ups (task feature-up) in the root `/app/model_md` directory.

### 🛠️ MANDATORY INITIALIZATION SEQUENCE
Before any work begins, you MUST execute these steps:
1. **Tool Call**: `initialize_worktree(feature_slug="feat-registration")`.
2. **Context Switch**: Change your working directory to the path returned by the tool.
3. **Re-Map**: Call `ast-explorer:get_repo_map` ONLY within the new worktree.

**Failure to follow this sequence will result in environment corruption and mission failure.**

## 🏗️ Monorepo Orchestration
- **Isolation Protocol**: Use `Worktree-Orchestrator`.
    - **Step 1**: `initialize_worktree(feature_slug)` (No slashes; use hyphens).
    - **Step 2**: Re-anchor via `ast-explorer:get_repo_map(path="model_md-worktree-<slug>")`.
- **Standard Tooling**: Always prefer the `task` CLI for environment operations.
- **Environment Management**:
  - Make sure you are in the new worktree.

  - **Spin-up Protocol**:
    - Run `task feature-up BRANCH=<slug>`. This will also print out the ports to be used with the feature's development.
    - **CRITICAL**: Use `task feature-status BRANCH=<slug>` to verify all containers are `running` and `healthy` before proceeding. 
    - Once healthy, run `task feature-initialize BRANCH=<slug>`.

  - To initialize a new feature environment: 
    Run `task feature-initialize BRANCH=<feature-name>`. This will reset, migrate, and seed the database once the docker-compose is complete.

  - To tear down an environment: 
    Add a `down` command to your `Taskfile` (e.g., `task feature-down BRANCH=<feature-name>`) and use it when finished.
    
- **Rules of Engagement**:
  - Do not call `docker-compose` directly.
  - If a feature requires specific environment variables, define them in a `.env.<branch>` file and instruct the user to verify them before running `task feature-up`.
  - When switching features, verify the active containers using `docker ps` before starting new ones to avoid port collisions.
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
