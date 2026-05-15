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

---

### 🧠 Context Window & Tool Efficiency
- **Targeted Indexing**: If assigned to a sub-directory, run `get_repo_map` on that specific subdirectory first to save tokens and processing time.
- **Quota Management**: Monitor your tool usage. If a single task requires >100 tool calls, you MUST:
  1. Use `bd create` to split the remaining work into a sub-task.
  2. Document the current state in a **Gate** or **Beads task summary**.
  3. Hand off the sub-task to a fresh agent instance.
- **Cache Reliance**: Trust the `get_repo_map` tool; it uses Redis caching. Re-running it after small file changes is fast and recommended to keep your internal symbol table updated.

---

### 🛠️ MANDATORY INITIALIZATION SEQUENCE

1. **Provision**: `MCP_DOCKER_initialize_worktree(feature_slug="feat-<name>")`.
   - _Note: This tool automatically initializes **Beads** (bd) in stealth mode._
2. **Bootstrap**: `MCP_DOCKER_execute_lifecycle(feature_slug="feat-<name>", action="initialize")`.
3. **Plan (Beads)**: Before writing code, use `bd create` to define the implementation steps.
4. **Context Loading**: `MCP_DOCKER_get_repo_map(path="model_md-worktree-<slug>")`.

---

## 🏗️ Isolated Environment Lifecycle

> **See also**: Full lifecycle details in [`.agents/worktree-lifecycle.md`](.agents/beads-enforcement.md#part-3-integration--definition-of-done).

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

## 🎯 Beads Enforcement Policy (MANDATORY)

> **See also**: Complete protocol with enforcement rules, compliance checklist, and error recovery in [`.agents/beads-enforcement.md`](.agents/beads-enforcement.md).

**Beads** (bd CLI) **MUST be used for ALL feature development.** No exceptions. The internal todo list is only for scratch notes. Every task in the implementation DAG must be a beads issue.

### Operational Loop (MANDATORY)

Every agent working on a feature MUST follow this loop for every single task:

1. **Initialize**: `bd init --stealth --server` (auto-done during worktree provisioning).
2. **Create**: `bd create "Task title" -p <priority>` before writing any code.
3. **Claim**: `bd update <TASK_ID> --claim` before starting a file edit.
4. **Work**: Implement changes and run local verifications.
5. **Close**: `bd close <TASK_ID> "Summary of changes"` only after code is committed and verified.

### Coordination & Dependencies

- **Dependencies**: Use `bd dep add <CHILD> <PARENT>` to block tasks (e.g., "Frontend UI" is blocked by "API Endpoint").
- **Visibility**: Use `bd ready` to find the next available task in the pipeline.
- **Gate Sync**: Use `bd gate` to synchronize parallel sub-agents at checkpoints.
- **Swarm Validation**: Use `bd swarm validate <EPIC_ID>` before starting multi-agent work.

### Usage Reference

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

# Create an epic for multi-agent coordination
bd create "Epic: User Profile Dashboard" --mol-type=swarm -p 0

# Validate swarm structure before parallel execution
bd swarm validate bd-epic-123

# Create a swarm molecule (manager pattern)
bd swarm create bd-epic-123 --coordinator=manager/
```

### Compliance Check

Before declaring any task complete, verify:

- [ ] Every file changed has a corresponding beads task
- [ ] Task was **claimed** before editing (`bd update <id> --claim`)
- [ ] Task is **closed** after commit (`bd close <id> "Summary"`)
- [ ] Dependencies are linked with `bd dep add`
- [ ] `bd ready` shows no orphaned tasks

---

## 🧠 Multi-Agent Swarm Orchestration

> **See also**: Full swarm protocol with gates, checkpoint lifecycle, and error recovery in [`.agents/beads-enforcement.md`](.agents/beads-enforcement.md#part-2-multi-agent-swarm-orchestration).

For complex features involving multiple specialities (e.g., frontend + backend + database), use the **Swarm Manager** pattern. This allows a coordinating agent to decompose work, delegate to specialist sub-agents, and synchronize via beads checkpoints.

### Architecture

```
                    ┌──────────────────────────┐
                    │    Swarm Manager Agent    │
                    │  (creates epic, plans     │
                    │   tasks, assigns work,    │
                    │   validates integration)  │
                    └──────────┬───────────────┘
                               │
                ┌──────────────┼──────────────────┐
                │              │                   │
        ┌───────▼───────┐ ┌───▼────────┐  ┌──────▼─────────┐
        │ Specialist A   │ │ Specialist B│  │ Specialist C    │
        │ (e.g. Designer)│ │ (e.g. CSS) │  │ (e.g. JS/TS)  │
        │ Creates task,  │ │ Creates task│  │ Creates task,   │
        │ implements,    │ │ depends on  │  │ depends on      │
        │ checkpoints    │ │ Designer    │  │ HTML structure  │
        └────────────────┘ └────────────┘  └─────────────────┘
```

### Swarm Manager Protocol

1. **Create Epic**: Manager creates an epic in beads for the full feature:
   ```bash
   bd create "Epic: User Profile Dashboard" --mol-type=swarm -p 0
   ```

2. **Decompose into Sub-Tasks**: Manager creates concrete tasks with explicit dependencies:
   ```bash
   bd create "Design profile layout" -p 1 --parent bd-epic-123
   bd create "Implement CSS styling" -p 2 --parent bd-epic-123
   bd create "Write HTML structure" -p 2 --parent bd-epic-123
   bd create "Add JS/TS interactivity" -p 2 --parent bd-epic-123
   ```

3. **Link Dependencies**: Establish the DAG:
   ```bash
   bd dep add bd-css-task bd-design-task   # CSS blocked by Design
   bd dep add bd-html-task bd-design-task  # HTML blocked by Design
   bd dep add bd-jsts-task bd-html-task    # JS/TS blocked by HTML
   ```

4. **Validate Swarm**: Confirm the dependency graph is sound:
   ```bash
   bd swarm validate bd-epic-123
   ```

5. **Create Swarm Molecule**: Enable coordinator discovery:
   ```bash
   bd swarm create bd-epic-123 --coordinator=manager/
   ```

6. **Sub-Agent Claims & Works**: Each specialist runs `bd ready`, finds unblocked tasks, claims them:
   ```bash
   bd ready                       # Find unblocked work
   bd update bd-design-task --claim  # Claim the task
   # ... implement ...
   bd close bd-design-task "Design mockup complete"
   ```

### Checkpointing via Gates

Use **bd gate** to synchronize sub-agents at agreed checkpoints without blocking the entire pipeline:

```bash
# Manager creates a gate for API contract agreement
bd gate create "profile-api-contract" --description "Designer and JS/TS agent agree on data shapes"

# Designer opens the gate when design spec is ready
bd gate open "profile-api-contract" "Design spec published: shapes for UserProfile, Preferences"

# JS/TS agent waits for the gate
bd gate wait "profile-api-contract"

# JS/TS agent proceeds knowing the contract is settled
```

### Parallel Execution Waves

Tasks are organized into execution **waves** based on dependency depth:

| Wave | Tasks | Description |
|------|-------|-------------|
| 1 | Design | Designer creates mockups, specs, API contracts |
| 2 | CSS, HTML | CSS implements styles, HTML implements structure (parallel, depend on Design) |
| 3 | JS/TS | Interactivity layer (depends on HTML structure) |
| 4 | Integration | Manager merges all work, verifies integration |

### Sub-Agent Contract

When a sub-agent completes its portion, it MUST:

1. **Close** its beads task with a summary of what was done
2. **Document** any API decisions, file paths created, or interfaces defined in a gate note
3. **Open gates** for downstream dependents
4. **Verification**: Confirm `lsp_diagnostics` clean on changed files

### Manager Integration

The Swarm Manager is responsible for:

1. Tracking all task completion via `bd epic status bd-epic-123`
2. Running integration verification across all sub-agent outputs
3. Closing the epic when all children are complete: `bd epic close-eligible bd-epic-123`
4. Resolving dependency conflicts between sub-agent outputs

### When NOT to Use Swarm

- Single-file changes (use direct beads task)
- Trivial configuration updates (use direct beads task)
- Tasks where one agent handles all layers (simple features)

---

## 🧬 Swarm Feature Creation Pipeline

> **See also**: Full pipeline with delegation templates, tool call subdivision, and error recovery matrix in [`.agents/swarm-feature-creator.md`](.agents/swarm-feature-creator.md).

This pipeline automates feature creation from request to delivery. It combines the **Swarm Manager** pattern (see [Multi-Agent Swarm Orchestration](#-multi-agent-swarm-orchestration)) with the **Beads** task system (see [Beads Enforcement Policy](#-beads-enforcement-policy-mandatory)) to decompose, delegate, and deliver features in parallel.

```
Feature Request → Research → Decomposition → Swarm Launch → 
Parallel Execution → Integration → Verification → Delivery
```

### Role Reference

| Role | File | Responsibility | Type |
|------|------|----------------|------|
| Swarm Feature Creator | `.agents/swarm-feature-creator.md` | Decomposes features, creates DAG, delegates, verifies | Orchestrator |
| Researcher | `.agents/researcher.md` | Codebase exploration with bounded tool calls | Specialist |
| Database Specialist | `packages/database/AGENTS.md` | Schema design and migrations | Specialist |
| Backend Specialist | `apps/backend/AGENTS.md` | API routes and business logic | Specialist |
| Frontend Specialist | `apps/frontend/AGENTS.md` | UI components and state management | Specialist |

### Sample

See `samples/swarm-feature-creation-full-stack.md` for a complete walkthrough of a full-stack feature built with this pipeline.

### When to Use Swarm Feature Creation

- **Multi-layer features**: Changes touching DB + Backend + Frontend
- **Cross-domain work**: Features requiring 2 or more specialist domains
- **Parallel opportunity**: Any feature where tasks can run concurrently

The orchestrator handles decomposition and dependency mapping, specialists execute in parallel, and the manager verifies integration before closing out.

## 📝 DEFINITION OF DONE (DoD)

> **See also**: Role-specific definitions for Database, Backend, and Frontend specialists in their respective `AGENTS.md` files under `packages/database/`, `apps/backend/`, and `apps/frontend/`.

A mission is complete only when:

1. **Internal Integration**: All related sub-features are merged into a single `feat-integration-*` worktree.
2. **Verification**: `execute_lifecycle(..., action="verify")` returns a zero exit code in the integration environment.
3. **Beads State**: Every relevant task is `closed`.
4. **Documentation**: New architectural decisions are recorded in `FEATURE_README.md`.
5. **Clean-up**: Call `MCP_DOCKER_stop_environment(feature_slug="<slug>")` for all ephemeral worktrees.
