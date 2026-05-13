# Beads Enforcement & Multi-Agent Swarm Protocol

## Overview

This document defines the mandatory beads usage rules and the multi-agent swarm orchestration protocol for AI workers in this repository. All agents **MUST** comply.

---

## Part 1: Beads Enforcement Policy

### 1.1 Mandatory Usage

**Beads (bd CLI) is MANDATORY for ALL feature development work.** The internal todo list in the orchestrator is only permitted for ephemeral scratch notes. Every persistent task in the implementation DAG **MUST** be a beads issue.

### 1.2 Enforcement Rules

| Rule | Description | Consequence of Violation |
|------|-------------|--------------------------|
| **Create before code** | `bd create "Title" -p N` before writing any implementation code | Task is considered incomplete |
| **Claim before edit** | `bd update <ID> --claim` before starting a file edit | Revert changes, create task, restart |
| **Close after commit** | `bd close <ID> "Summary"` only after code is committed and verified | Definition of Done not met |
| **Link dependencies** | `bd dep add <CHILD> <PARENT>` for all inter-task relationships | Swarm validation will fail |
| **Close all tasks** | Every task in the epic must be closed before epic is complete | `bd epic close-eligible` will reject |

### 1.3 Beads Initialization

Beads is auto-initialized during worktree provisioning (`MCP_DOCKER_initialize_worktree`). If you need to reinitialize:

```bash
# Stealth mode (no git operations - preferred for worktrees)
bd init --stealth --server

# Server mode (connects to shared Dolt server)
bd init --server

# Verify initialization
bd status
```

### 1.4 Compliance Verification Checklist

Before marking ANY feature task as complete, the agent MUST verify:

```
□ Every modified file has a corresponding beads task
□ Task was claimed before editing
□ Task dependencies are linked with bd dep add
□ lsp_diagnostics clean on all changed files
□ Build passes (if applicable)
□ Task is closed after commit
□ bd ready shows no orphaned/unclaimed tasks in your epic
```

---

## Part 2: Multi-Agent Swarm Orchestration

### 2.1 When to Use Swarm Mode

Use the Swarm Manager pattern when:
- A feature requires 2+ specialist skill domains (e.g., DB + Backend + Frontend)
- Parallel execution of independent work units is possible
- Sub-agents need to checkpoint intermediate results for other agents to consume
- A coordinating agent is available to manage the DAG

### 2.2 Swarm Manager Role

The Swarm Manager is a coordinating agent responsible for:

1. **Decomposition**: Breaking a feature into granular, dependency-ordered tasks
2. **Epic Creation**: Creating a beads epic with `--mol-type=swarm`
3. **Task Creation**: Creating sub-tasks with explicit priorities and dependencies
4. **Swarm Validation**: Running `bd swarm validate` to confirm the DAG is sound
5. **Assignment**: Optionally setting coordinator via `bd swarm create --coordinator=`
6. **Monitoring**: Tracking completion via `bd epic status`
7. **Integration**: Running integration verification across all sub-agent outputs
8. **Epic Closure**: Closing the epic with `bd epic close-eligible` when done

### 2.3 Sub-Agent Role

Each specialist sub-agent is responsible for:

1. **Discovery**: Running `bd ready` to find unblocked tasks
2. **Claiming**: `bd update <TASK_ID> --claim` before starting work
3. **Implementation**: Writing code within their specialty domain
4. **Checkpointing**: Opening gates for downstream dependents when milestones are reached
5. **Verification**: Ensuring lsp_diagnostics clean and tests pass
6. **Closing**: `bd close <TASK_ID> "Summary of what was done"`
7. **Documentation**: Leaving notes on API decisions, file paths, interfaces

### 2.4 Checkpoint Protocol (Gates)

Gates are beads synchronization points that allow sub-agents to signal completion of shared interfaces without blocking the entire pipeline.

#### Gate Lifecycle

```
Manager creates gate ──→ Specialist opens gate ──→ Downstream agent waits ──→ Proceeds
```

#### Creating a Gate

The Manager (or a sub-agent) creates a gate for a shared contract:

```bash
bd gate create "api-data-shapes" \
  --description "Agreed API response shapes between backend and frontend"
```

#### Opening a Gate (Checkpoint)

When a sub-agent completes a milestone that unblocks others:

```bash
bd gate open "api-data-shapes" \
  "Backend API returns: { id: string, name: string, email: string }"
```

The gate note SHOULD contain the actual contract details (types, shapes, file paths).

#### Waiting on a Gate

A downstream agent blocks until the gate is open:

```bash
bd gate wait "api-data-shapes"
# Gate opens → agent proceeds with known contract
```

#### Gate Naming Conventions

Use a consistent namespace pattern to make gate purposes obvious across all agents:

```
<type>-<feature>[-<sub-context>]
```

| Type | Pattern | Example | Opened By | Consumed By |
|------|---------|---------|-----------|-------------|
| Research | `research-<feature>` | `research-user-preferences` | Researcher | All agents |
| Contract | `contract-<context>-<name>` | `contract-api-preferences` | Upstream agent | Downstream agent |
| Schema | `schema-<feature>` | `schema-user-preferences` | DB Specialist | Backend Specialist |
| Checkpoint | `checkpoint-<TASK_ID>` | `checkpoint-bd-pref-db` | Any agent (T-RECOVERY) | Manager / successor |
| Impact | `impact-<scope>` | `impact-users-schema` | Researcher | Manager |
| Synthesis | `synthesis-<topic>` | `synthesis-db-patterns` | Researcher | Manager |
| API Contract | `api-contract-<feature>` | `api-contract-preferences` | Backend Specialist | Frontend Specialist |
| UI Contract | `ui-contract-<feature>` | `ui-contract-dashboard` | Designer | CSS / HTML / JS agents |
| Subdivide | `subdivide-<TASK_ID>` | `subdivide-bd-pref-api` | Manager (tool-limit recovery) | Successor agent |

**Rules:**
1. Gate names MUST be unique within an epic's scope.
2. Use kebab-case only — no spaces, underscores, or CamelCase.
3. The `contract-` prefix is reserved for cross-layer interface agreements.
4. The `checkpoint-` prefix is reserved for T-RECOVERY checkpoints (see §5).
5. Each gate SHOULD document the type (Research, Impact, Contract, etc.) in its `--description`.

> **Timeout handling**: If a downstream agent calls `bd gate wait "<name>"` and the upstream agent fails or never opens the gate, the Swarm Manager should detect this via `bd epic status` and either reassign the upstream task or manually open the gate with updated contract details. See [Error Recovery](#28-error-recovery) for resolution steps.

### 2.5 API Contract Management

When multiple agents work on connected layers, they MUST agree on shared interfaces:

1. **Design Phase**: Designer defines the API contract (data shapes, component props, route signatures)
2. **Gate Note**: Contract is published via gate open note
3. **All Sub-Agents**: Read the gate note before implementing their layer
4. **Consistency Check**: Manager verifies all layers implement the same contract during integration

Example gate note for a component contract:

```
Gate: profile-widget-api
Status: OPEN
Contract:
  Component: UserProfileCard
  Props:
    - user: { id: string, name: string, avatarUrl: string, bio: string }
    - variant: "compact" | "full"
  Events:
    - onEdit: (userId: string) => void
  CSS Classes:
    - .user-profile-card (container)
    - .user-profile-card--compact (modifier)
    - .user-profile-card__avatar
    - .user-profile-card__name
    - .user-profile-card__bio
```

### 2.6 Full Swarm Workflow

```
┌─────────────────────────────────────────────────────────────────────┐
│                     MULTI-AGENT SWARM WORKFLOW                      │
└─────────────────────────────────────────────────────────────────────┘

Manager:
  1. bd create "Epic: Feature X" --mol-type=swarm -p 0
  2. bd create "Sub-task A" -p 1 --parent bd-epic-123
  3. bd create "Sub-task B" -p 2 --parent bd-epic-123
  4. bd create "Sub-task C" -p 2 --parent bd-epic-123
  5. bd dep add bd-b bd-a    # B blocked by A
  6. bd dep add bd-c bd-b    # C blocked by B
  7. bd gate create "contract-ab" --description "API between A and B"
  8. bd swarm validate bd-epic-123
  9. bd swarm create bd-epic-123 --coordinator=manager/

Agent A (no deps → starts immediately):
  1. bd ready → finds bd-a
  2. bd update bd-a --claim
  3. ... implements ...
  4. bd gate open "contract-ab" "Published: interface IFoo { ... }"
  5. bd close bd-a "Implemented Foo module with IFoo interface"

Agent B (blocked by A → waits for gate):
  1. bd gate wait "contract-ab"
  2. bd ready → bd-b now unblocked
  3. bd update bd-b --claim
  4. ... implements using IFoo from gate note ...
  5. bd close bd-b "Implemented Bar module consuming IFoo"

Agent C (blocked by B → waits for B to close):
  1. bd ready → bd-c unblocked after bd-b closes
  2. bd update bd-c --claim
  3. ... implements ...
  4. bd close bd-c "Completed integration layer"

Manager:
  10. bd epic status bd-epic-123  # Monitor progress
  11. ... integration verification ...
  12. bd epic close-eligible bd-epic-123
  13. bd close bd-epic-123 "Feature X complete"
```

### 2.7 Swarm Validation Requirements

Before `bd swarm validate` passes, the epic MUST have:

- **No cycles**: Dependency graph must be a DAG
- **All roots have dependents**: No orphan tasks
- **Leaves checked**: No task missing dependencies that it should have
- **Connected subgraphs**: No disconnected clusters
- **Correct dependency direction**: Requirements-based, not temporal

### 2.8 Error Recovery

| Situation | Resolution |
|-----------|------------|
| Sub-agent fails to complete | Manager reassigns task (`bd update <ID> --assignee new-agent`) |
| Contract changes mid-flight | Manager updates gate note, reopens, downstream agents re-read |
| Dependency cycle detected | Manager restructures tasks, reruns `bd swarm validate` |
| Integration verification fails | Manager creates bug-fix tasks, assigns to relevant sub-agent |

---

## Part 3: Integration & Definition of Done

### 3.1 Integration Workflow

After all sub-agent tasks are closed:

1. **Manager** runs integration worktree (merge all sub-feature branches)
2. **Manager** executes `execute_lifecycle(action="verify")`
3. **Manager** resolves any integration conflicts
4. **Manager** closes the epic

### 3.2 Swarm DoD

A swarm feature is complete only when:

- [ ] All sub-tasks are in `closed` status
- [ ] Epic has zero open children
- [ ] `bd epic close-eligible <EPIC_ID>` confirms readiness
- [ ] Integration verification passes (build + tests)
- [ ] `FEATURE_README.md` documents API contracts and architecture

---

## Part 4: Quick Reference

### Manager Commands

| Step | Command |
|------|---------|
| Create epic | `bd create "Epic" --mol-type=swarm -p 0` |
| Create sub-task | `bd create "Task" -p N --parent bd-epic` |
| Link dependency | `bd dep add bd-child bd-parent` |
| Create gate | `bd gate create "name" --description "..."` |
| Validate swarm | `bd swarm validate bd-epic` |
| Enable swarm | `bd swarm create bd-epic --coordinator=manager/` |
| Check status | `bd epic status bd-epic` |
| Close epic | `bd epic close-eligible bd-epic` |

### Sub-Agent Commands

| Step | Command |
|------|---------|
| Find work | `bd ready` |
| Claim task | `bd update <ID> --claim` |
| Open gate | `bd gate open "name" "Details"` |
| Wait on gate | `bd gate wait "name"` |
| Close task | `bd close <ID> "Summary"` |

---

## Part 5: Tool Call Limit Recovery Protocol (T-RECOVERY)

### 5.1 Context

Sub-agents in this environment have a finite tool call budget. When the budget is exhausted mid-work, the agent is terminated and its context is lost. This protocol ensures partial progress is checkpointed via beads gates so a fresh agent can pick up exactly where the previous one stopped. No work is lost, no context is wasted.

### 5.2 Budget Assignment Rules

| Task Complexity | Max Tool Calls | Checkpoint Every N Calls |
|----------------|---------------|------------------------|
| Simple (single file edit) | 15 | No checkpoint needed |
| Medium (2-4 files, single layer) | 25 | 15 |
| Complex (5+ files, multi-layer) | 40 | 20 |
| Research/Exploration | 15 | 10 |

### 5.3 Subdivision Protocol

Follow these steps when a sub-agent approaches its tool call limit:

1. **Agent detects approaching limit** (at 80% of budget consumed).
2. **Agent stops all new work immediately.** Do not start new edits or searches.
3. **Agent opens a beads gate** with current state:
   ```
   bd gate open "checkpoint-<TASK_ID>" "Progress: <DETAILS>. Remaining: <WHAT'S LEFT>. Next steps: <SUGGESTION>."
   ```
4. **Orchestrator detects the gate** (or agent timeout) and assesses remaining work.
5. **Orchestrator creates a child task** for the remaining scope:
   ```
   bd create "Remaining: <TASK_DESC>" -p <PRIORITY> --parent <ORIGINAL_EPIC>
   ```
6. **Orchestrator links the dependency** so the child is blocked by the original:
   ```
   bd dep add <CHILD> <ORIGINAL>
   ```
7. **Orchestrator spawns a new sub-agent** with:
   - The partial results from the gate note as starting context
   - Reduced scope (only the remaining work)
   - A fresh tool call budget
8. **New agent waits on the gate**, reads checkpoint context, claims the child task, and continues.

### 5.4 Context Preservation Template

When opening a checkpoint gate, use this template:

```
## Gate Note: checkpoint-<TASK_ID>
### Completed:
- What was done (files modified, decisions made)

### Partial Results:
- Code snippets, findings, patterns discovered

### Blockers Encountered:
- What stopped progress

### Remaining Work:
- What still needs to be done

### Context for Next Agent:
- Patterns to follow, files to read, design decisions
```

### 5.5 Anti-Patterns

The following behaviors are **forbidden** during tool call recovery:

- ❌ **Silently losing partial progress.** Always open a gate note before the budget runs out.
- ❌ **Restarting the full task from scratch.** The new agent should only handle remaining work.
- ❌ **Not preserving discovered context.** File paths found, patterns observed, and design decisions must be in the gate note.
- ❌ **Giving the new agent an unlimited budget.** Assign a fresh budget using the table in 5.2 for the reduced scope.
