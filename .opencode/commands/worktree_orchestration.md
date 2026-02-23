---
name: worktree_orchestration

description: Automated lifecycle management for isolated feature development using portable git worktrees within a Docker-mapped parent volume.
---

### Goal
Prevent context contamination by housing parallel features in sibling directories within the `/app` volume, ensuring portability between the Container and Host.

### Protocol

#### 1. Pre-flight Check & Branching
* **CWD Check:** Confirm current directory is `/app/model_md`.
* **Integration Branch:** Before creating worktrees, create/checkout a parent feature branch (e.g., `feat/notification-system`). **All worktrees must branch from this, not main.**
* **Environment:** Verify `git` is installed and `..` (the volume root `/app`) is writable.

#### 2. Execution (The "Portable" Setup)
* **Strict Command:** `git worktree add --relative-paths ../model_md-worktree-<feature-slug> -b <feature-slug>`
    * *Mandatory:* Use `--relative-paths`. Failure to do so breaks the repo on the Host machine.
* **Environment Injection:**

    * Copy `.env`: `cp .env ../model_md-worktree-<feature-slug>/.env`
    * Symlink `node_modules`: `ln -s /app/model_md/node_modules /app/model_md-worktree-<feature-slug>/node_modules`
    * *Note:* Use the absolute container path `/app/model_md/node_modules` as the symlink target to ensure stability across subdirectories.

#### 3. Delegation & Re-Anchoring
* **Sub-Agent Spawn:** Set the sub-agent's `CWD` to `/app/model_md-worktree-<feature-slug>`.
* **AST Indexing:** * Call `get_repo_map(path="model_md-worktree-<feature-slug>")`.

#### 4. Context Boundary & Conflict Resolution
* Sub-agents operate **only** within their worktree.
* **Cross-Feature Awareness:** Use the AST MCP to read the other worktree's directory. If a sub-agent detects a type mismatch with a sibling worktree, it must pause and report to the Orchestrator.

#### 5. Lifecycle End (The "Safe" Merge)
1.  **Commit:** Sub-agents commit changes within their worktrees.
2.  **Return:** Move to the main repo directory (`/app/model_md`) on the **Integration Branch**.
3.  **Merge:** Merge each worktree branch into the Integration Branch.
4.  **Verify:** Run the final AST verification on the merged state.
5.  **Cleanup:** * `git worktree remove ../model_md-worktree-<feature-slug>`
    * `git branch -d <feature-slug>`
