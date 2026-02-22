---
name: worktree_orchestration

description: Automated lifecycle management for isolated feature development using portable git worktrees within a Docker-mapped parent volume.
---

### Goal
Prevent context contamination by housing parallel features in sibling directories within the `/app` volume, ensuring portability between the Container and Host.

### Protocol

#### 1. Pre-flight Check
* **CWD Check:** Confirm current directory is `/app/model_md` (or the primary repo).
* **Environment:** Verify `git` is installed and `..` (the volume root `/app`) is writable.

#### 2. Execution (The "Portable" Setup)
* **Command:** `git worktree add --relative-paths ../model_md-worktree-<feature-slug> -b <branch-name>`
    * *Note:* The `--relative-paths` flag is mandatory to ensure the `.git` file resolves correctly on both the host machine and inside the container.
* **Environment Injection:**

    * Copy `.env`: `cp .env ../model_md-worktree-<feature-slug>/.env`
    * Symlink `node_modules`: `ln -s /app/model_md/node_modules /app/model_md-worktree-<feature-slug>/node_modules`
    * *Note:* Use the absolute container path `/app/model_md/node_modules` as the symlink target to ensure stability across subdirectories.

#### 3. Delegation & Re-Anchoring
* **Sub-Agent Spawn:** Set the sub-agent's `CWD` to `/app/model_md-worktree-<feature-slug>`.
* **AST Indexing:** * Call `get_repo_map(path="model_md-worktree-<feature-slug>")`.
    * *Note:* The path is relative to the `/app` root, not the current repo.

#### 4. Context Boundary
* The sub-agent must strictly operate within its assigned worktree. 
* Any reference to the "parent" or "original" code should be done via read-only AST lookups, never direct file edits in the main directory.

#### 5. Cleanup (Lifecycle End)
* Return to the main repository directory (`/app/model_md`).

* **Command:** `git worktree remove ../model_md-worktree-<feature-slug>`
* **Hygiene:** `git branch -d <branch-name>`
