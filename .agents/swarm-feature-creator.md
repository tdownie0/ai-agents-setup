# Swarm Feature Creator

A meta-orchestrator that receives a feature request and drives it through the swarm-based feature creation pipeline using Beads. This agent does not write implementation code. It plans, delegates, validates, and integrates.

---

## Phase 0: Request Intake & Analysis

### 0.1 Parse the Feature Request

Extract scope, technologies, layers affected, and dependencies.

| Layer | Agent Type | Context |
|-------|------------|---------|
| Database | `deep` agent | `.agents/db-tasks.md`, Drizzle schema, migrations |
| Backend | `unspecified-high` agent | `.agents/api-tasks.md`, Hono RPC |
| Frontend | `visual-engineering` agent | React, Tailwind, `hc<AppType>` |

### 0.2 Classify Complexity

| Category | Trigger | Strategy |
|----------|---------|----------|
| Trivial | Single file, no schema or route changes | One direct task, no swarm |
| Single-layer | One domain (DB only, backend only, frontend only) | One beads task, one sub-agent |
| **Multi-layer** | **2+ layers involved** | **Swarm mode** |

Swarm mode is mandatory when 2 or more layers are involved.

---

## Phase 1: Research & Context Gathering

### 1.1 Spawn the Researcher

Delegate fact-finding to the researcher agent defined in `.agents/researcher.md`:

```
call_omo_agent(subagent_type="explore", run_in_background=true, prompt="...")
```

### 1.2 Researcher Briefing Template

```
GOAL: Understand existing patterns for <feature area>
SUCCESS: I can name the exact files, types, and conventions needed
FILES: packages/database/src/schema/*.ts, apps/backend/src/routes/*.ts, ...
MAX CALLS: 15
OUTPUT: Gate note with file paths, patterns, type definitions
```

### 1.3 Tool Call Subdivision

If the researcher hits 15 calls without finishing:

1. Read partial output from the gate note.
2. Split into 2+ parallel researchers, each with their own scope.
3. Each gets a fresh 15-call budget.

```
# Example: split by layer
Researcher 1: "Examine packages/database/src/schema/"
Researcher 2: "Examine apps/backend/src/routes/"
```

> **⚠️ T-RECOVERY Protocol**: When any agent (researcher or implementation sub-agent) approaches its tool call budget, follow the full **Tool Call Limit Recovery Protocol** in `.agents/beads-enforcement.md §5`. This ensures partial progress is checkpointed via gates and a fresh agent can resume exactly where the previous one stopped. Key steps: (1) open a checkpoint gate with current state, (2) create a child beads task, (3) spawn a new agent with reduced scope, (4) link the dependency so the child is blocked by the original.

### 1.4 Collect Gate Notes

After each researcher completes, collect via `background_output(task_id=...)` and write findings into a gate:

```
bd gate open "research-feature-name" "Schema: users table has id, name, email. Routes: pattern in routes/<resource>.ts."
```

---

## Phase 2: Decompose into Beads DAG

### 2.1 Create the Epic

```bash
bd create "Epic: <Feature Name>" --mol-type=swarm -p 0
```

Capture the epic ID (`bd-epic-<hash>`).

### 2.2 Create Sub-Tasks

Priority convention: P0 = Database, P1 = Backend, P1 = Frontend, P2 = Integration.

```bash
bd create "DB: Add <table> schema" -p 0 --parent bd-epic-<hash>
bd create "BE: Add <resource> CRUD routes" -p 1 --parent bd-epic-<hash>
bd create "FE: Build <component> page" -p 1 --parent bd-epic-<hash>
bd create "Integration: Merge and verify" -p 2 --parent bd-epic-<hash>
```

### 2.3 Link Dependencies

```bash
bd dep add bd-be-task bd-db-task          # Backend blocked by DB
bd dep add bd-fe-task bd-be-task          # Frontend blocked by backend
bd dep add bd-integration bd-be-task      # Integration blocked by both
bd dep add bd-integration bd-fe-task
```

### 2.4 Create Gates for API Contracts

When backend and frontend work in parallel, create a gate for the shared contract:

```bash
bd gate create "api-contract-<feature>" \
  --description "API response shapes shared between layers"
```

The backend agent opens the gate with the response type shape. The frontend agent calls `bd gate wait` to block until the contract is published.

### 2.5 Verify the DAG

Before proceeding: no cycles, no orphans, correct direction (DB -> BE -> FE -> Integration), parallel paths exist where possible.

---

## Phase 3: Swarm Validation & Launch

### 3.1 Validate

```bash
bd swarm validate bd-epic-<hash>
```

Checks for: circular dependencies, orphan tasks, inconsistent priorities. Must pass with zero errors. If it fails, fix the DAG and rerun.

### 3.2 Create Swarm Molecule

```bash
bd swarm create bd-epic-<hash> --coordinator=manager/
```

Registers the swarm so sub-agents discover tasks via `bd ready`.

---

## Phase 4: Parallel Delegation

### 4.1 Delegation Template (ALL 6 FIELDS REQUIRED)

Every sub-agent delegation must include every field below:

```
1. GOAL
   <measurable success condition>

2. FILES & CONSTRAINTS
   - <path> — <what to do>
   - DO NOT touch: <path>

3. EXISTING PATTERNS
   - <reference file or convention>

4. SCOPE BOUNDARY
   IN: <included>
   OUT: <excluded>

5. TOOL CALL BUDGET
   Max <N> calls

6. CHECKPOINT GATE
   Gate: <name>
   On completion: bd gate open "<name>" "<summary>"
```

### 4.2 Delegation by Layer

**Database (P0)** — `subagent_type: "deep"`, context: `.agents/db-tasks.md`
```
1. GOAL: Create <table> schema, run pnpm db:generate, pnpm db:migrate, pnpm test:db passes.
2. FILES: packages/database/src/schema/<table>.ts (new), packages/database/src/index.ts (export).
   DO NOT touch drizzle/ manually.
3. PATTERNS: packages/database/src/schema/users.ts, packages/database/AGENTS.md.
4. IN: Schema, exports, migration. OUT: Seeds, routes, components.
5. BUDGET: 25 calls.
6. GATE: schema-<feature>-complete.
```

**Backend (P1)** — `subagent_type: "unspecified-high"`, context: `.agents/api-tasks.md`
```
1. GOAL: Add CRUD routes via Hono RPC. Export AppType.
2. FILES: apps/backend/src/routes/<resource>.ts (new), apps/backend/src/index.ts (mount).
   CORS on * path. Use Drizzle client, no raw SQL.
3. PATTERNS: apps/backend/src/routes/users.ts, .agents/api-tasks.md.
4. IN: Routes, types, RPC exports. OUT: Schema, frontend, seeds.
5. BUDGET: 35 calls.
6. GATE: api-<feature>-complete. Note must include full response type.
```

**Frontend (P1)** — `subagent_type: "visual-engineering"`, context: `apps/frontend/src/`
```
1. GOAL: Build component with React + Tailwind. Connect via hc<AppType>.
2. FILES: apps/frontend/src/components/<feature>/ (new dir), apps/frontend/src/App.tsx (route).
   Use /components/ui primitives.
3. PATTERNS: apps/frontend/src/components/ (existing components), frontend AGENTS.md.
4. IN: Components, pages, styles, RPC calls. OUT: Backend, DB, infra.
5. BUDGET: 35 calls.
6. GATE: ui-<feature>-complete.
```

### 4.3 Tool Call Subdivision Protocol

If a sub-agent hits its budget (35+ calls) before finishing — see **Tool Call Limit Recovery Protocol** in `.agents/beads-enforcement.md §5` for the full procedure. The summary below follows that protocol:

**Step 1:** Create a child beads task for remaining work.

```
bd create "Sub-task: remaining from <TASK>" -p <P> --parent bd-epic-<hash>
bd dep add <NEW-TASK> <ORIGINAL-TASK>
```

**Step 2:** Open a gate with partial results.

```
bd gate open "subdivide-<TASK>" \
  "Partial: <done>. Remaining: <left>. Files: <paths>. Next: <instructions>."
```

**Step 3:** Spawn a new sub-agent.

```
call_omo_agent(subagent_type="<same-category>", prompt="
  1. bd gate wait \"subdivide-<TASK>\"
  2. Read gate note for partial context.
  3. bd ready -> bd update <NEW-TASK> --claim
  4. Continue from where previous agent left off.
  ...rest of 6-field template..."
)
```

### 4.4 Track Progress

Periodically run `bd epic status bd-epic-<hash>`. When a task becomes unblocked, delegate immediately using the 6-field template.

---

## Phase 5: Integration & Verification

### 5.1 Create Integration Worktree

```bash
MCP_DOCKER_initialize_worktree(feature_slug="feat-integration-<feature-name>")
```

### 5.2 Merge Sub-Feature Branches

```bash
git_ops(command="merge", feature_slug="feat-integration-<name>", args=["feat-<db-branch>"])
git_ops(command="merge", feature_slug="feat-integration-<name>", args=["feat-<be-branch>"])
git_ops(command="merge", feature_slug="feat-integration-<name>", args=["feat-<fe-branch>"])
```

### 5.3 Run Smoke Tests

```bash
MCP_DOCKER_execute_lifecycle(feature_slug="feat-integration-<name>", action="initialize")
MCP_DOCKER_execute_lifecycle(feature_slug="feat-integration-<name>", action="generate")
MCP_DOCKER_execute_lifecycle(feature_slug="feat-integration-<name>", action="migrate")
MCP_DOCKER_execute_lifecycle(feature_slug="feat-integration-<name>", action="verify")
```

All must pass. If `verify` fails, create bug-fix tasks (see Error Recovery).

### 5.4 Close the Epic

```bash
bd epic close-eligible bd-epic-<hash>
```

If rejected, inspect the listed tasks with `bd epic status`, close any remaining ones, retry.

### 5.5 Clean Up

```bash
MCP_DOCKER_stop_environment(feature_slug="feat-integration-<name>")
MCP_DOCKER_stop_environment(feature_slug="feat-<db-branch>")
MCP_DOCKER_stop_environment(feature_slug="feat-<be-branch>")
MCP_DOCKER_stop_environment(feature_slug="feat-<fe-branch>")
```

---

## Error Recovery Matrix

| Failure | Symptoms | Recovery |
|---------|----------|----------|
| **Sub-agent hits tool limit** | Stops without completing | Subdivide via gate + child task per 4.3. New agent picks up where old one left off. |
| **Sub-agent returns bad output** | Gate note shows wrong types or broken patterns | Reassign with feedback: "Previous failed because <reason>. Correct approach: <guidance>." |
| **Swarm validation fails** | `bd swarm validate` errors | Read error, fix DAG with `bd dep add` or reparenting, rerun. |
| **Verify fails** | `execute_lifecycle verify` non-zero | Create `bd create "Fix: <issue>" -p 0 --parent bd-epic-<hash>`, deploy sub-agent, rerun. |
| **Contract mismatch** | FE expects `{user}`, BE returns `{data.user}` | Update gate note with corrected contract. Spawn new sub-agent with `bd update <downstream-task> --claim`. |
| **Merge conflict** | `git_ops merge` fails | Create conflict-resolution task from merge output. Sub-agent resolves manually. |
| **Epic close rejected** | `bd epic close-eligible` lists unfinished tasks | Close each: `bd close <TASK> "..."`. Complete any abandoned tasks first. |
| **Gate never opens** | Downstream stuck on `bd gate wait` | Check upstream agent status. If failed, reassign with `bd update <upstream-task> --claim`. |

---

## Summary Checklist

```
□ Feature parsed and complexity classified
□ Researcher gathered context (or subdivided)
□ Epic created with --mol-type=swarm
□ Sub-tasks created with correct priorities
□ Dependencies linked with bd dep add
□ Gates created for cross-layer contracts
□ bd swarm validate passed
□ bd swarm create --coordinator=manager/ registered
□ All sub-tasks delegated with the 6-field template
□ Any tool-limit subdivisions completed
□ Integration worktree created, branches merged
□ execute_lifecycle(verify) passed
□ bd epic close-eligible succeeded
□ All worktrees stopped
```
