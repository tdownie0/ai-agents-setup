# 📖 Project Manual: Global Orchestration & AI Governance

## 🚨 CRITICAL: ARCHITECTURAL & OPERATIONAL GUARDRAILS

**STRICT PROHIBITION**: Direct file access to `/app/model_md` is blocked for all development.
All operations MUST be executed within an isolated Git worktree. Never work on features in the
`/app/model_md` directory.

## 🔍 CODE EXPLORATION & ANALYSIS PROTOCOL (Tool-First Policy)

You are an "Architectural Analyst." To maintain system stability, you must follow this exploration hierarchy. **NEVER use glob/read as your first step.**

1. **Perform Initialization**: Follow the sequence below before using exploration tools.
2. **Hierarchy Discovery**: Start by calling `MCP_DOCKER_get_repo_map(path="model_md-worktree-<slug>")`.
3. **Symbol Navigation**: Use `find_symbol` and `get_dependents` to analyze impact across the monorepo.

### 🛠️ MANDATORY INITIALIZATION SEQUENCE

1. **Provision**: `MCP_DOCKER_initialize_worktree(feature_slug="feat-<name>")`.
   - _Note: This tool automatically initializes **Beads** (bd) in stealth mode._
2. **Bootstrap**: `MCP_DOCKER_execute_lifecycle(feature_slug="feat-<name>", action="initialize")`.
3. **Plan (Beads)**: Before writing code, use `bd create` to define the implementation steps.
4. **Context Loading**: `MCP_DOCKER_get_repo_map(path="model_md-worktree-<slug>")`.

---

## 🏗️ Isolated Environment Lifecycle

### 1. Action Library (via `MCP_DOCKER_execute_lifecycle`)

- `initialize`: Performs a full DB reset, migration, and seed.
- `generate`: Triggers Drizzle code generation.
- `migrate`: Runs database migrations.
- `verify`: Runs database tests and lints (The "Quality Gate").
- `format`: Automatically fixes linting/formatting (Run before every commit).
- `build`: Compiles both frontend and backend assets.

### 2. Validation (The "Smoke Test")

After any schema change, execute `generate` and `migrate`. Never declare a task done without a successful `verify` run.

---

## 📂 Git Governance & Integration Strategy

### 1. Safe Git Operations

Use the `git_ops` tool for all version control.

- **Allowed Commands**: `add`, `commit`, `status`, `diff`, `log`, `branch`, `merge`.
- **Atomic Commits**: Commit logical units frequently.

### 2. Internal Integration (Merging Sub-Features)

To combine multiple feature worktrees (e.g., merging a backend worktree into a frontend one):

1. **Provision Integration**: Create a dedicated worktree for the merge: `initialize_worktree(feature_slug="feat-integration-<name>")`.
2. **Execute Merge**: In the integration worktree, run `git_ops(command="merge", args=["feat-<source-branch>"])`.
3. **Verify Combined State**: Run `execute_lifecycle(..., action="verify")` on the merged code.
4. **Guardrail**: Merging `main`, `master`, or `develop` is strictly forbidden. Only `feat-*` branches may be integrated.

---

## 🎯 Task Tracking (Beads Protocol)

**Beads** (bd CLI) is the source of truth for agent coordination. The environment is pre-initialized for you during provisioning.

### Operational Loop

1. **Claim**: `bd update <TASK_ID> --claim` before starting a file edit.
2. **Work**: Implement changes and run local verifications.
3. **Close**: `bd close <TASK_ID> "Summary of changes"` only after code is committed and verified.

### Coordination

- **Dependencies**: Use `bd dep add` to block tasks (e.g., "Frontend UI" is blocked by "API Endpoint").
- **Visibility**: Use `bd ready` to find the next available task in the pipeline.

For multi-step features or complex workflows, use **Beads** (bd CLI) for structured task tracking.

### Usage

```bash
# Initialize in worktree (stealth mode - no git operations)
bd init --stealth --server

# Create tasks with priorities
bd create "Implement feature X" -p 1
bd create "Add database schema" -p 0

# Link dependencies
bd dep add bd-a1b2 bd-a1b3  # bd-a1b2 is blocked by bd-a1b3

# Find unblocked work
bd ready

# Update task status
bd update bd-a1b2 --claim
bd close bd-a1b2 "Completed"
```

### When to Use Beads

- Complex multi-step implementations with dependencies
- Long-horizon tasks requiring persistent context
- Coordinating multiple agents on same feature
- For simple todo tracking, use the internal todo list instead.

---

## 📝 DEFINITION OF DONE (DoD)

A mission is complete only when:

1. **Internal Integration**: All related sub-features are merged into a single `feat-integration-*` worktree.
2. **Verification**: `execute_lifecycle(..., action="verify")` returns a zero exit code in the integration environment.
3. **Beads State**: Every relevant task is `closed`.
4. **Documentation**: New architectural decisions are recorded in `FEATURE_README.md`.
5. **Clean-up**: Call `MCP_DOCKER_stop_environment(feature_slug="<slug>")` for all ephemeral worktrees.
