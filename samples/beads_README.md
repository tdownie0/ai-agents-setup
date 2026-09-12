# Beads Integration

## Overview

This feature integrates [Beads](https://github.com/gastownhall/beads) (bd) - a distributed graph issue tracker for AI agents - into the model_md workflow.

## What is Beads?

Beads provides a persistent, structured memory for coding agents:
- **Dependency-aware task graph** - Tasks link via `relates_to`, `blocks`, `parent-child`
- **Hash-based IDs** (`bd-a1b2`) - Zero-collision in multi-agent/multi-branch workflows
- **`bd ready`** - Lists tasks with no open blockers (auto-ready detection)
- **Dolt-powered** - Version-controlled SQL database with branching

## Installation

The base image now includes beads and dolt. Binaries are available in PATH after rebuild:
- `bd` - beads CLI (built from source with CGO_ENABLED=1 -tags gms_pure_go)
- `dolt` - database backend
- `git` - dummy shim for stealth mode

### Building the Image

Agent images are rebuilt via `sudo task up -- --build`; the orchestrator image
(the component that provisions beads into new worktrees) via
`sudo task mcp:build-servers`.

## Usage

### Essential Commands

| Command | Action |
|---------|--------|
| `bd ready` | List tasks with no open blockers |
| `bd create "Title" -p 0` | Create a P0 task |
| `bd update <id> --claim` | Atomically claim a task |
| `bd dep add <child> <parent>` | Link tasks (blocks, related, parent-child) |
| `bd show <id>` | View task details and audit trail |
| `bd close <id> --reason "Fixed"` | Close with resolution message |

### Workflow Integration

1. **Initialize beads** against the shared Dolt server (worktrees are
   auto-provisioned this way by `initialize_worktree`; connection env is baked
   into the container and the database is created by bd at first connect):
   ```bash
   bd init --server --external --database model_md_worktree_<slug> --non-interactive -q
   ```
   (If `.beads/` already exists, add `--init-if-missing` or just skip this step.)

2. **Create tasks** for your feature:
   ```bash
   bd create "Implement user registration" -p 1
   bd create "Add database schema for users" -p 0
   ```

3. **Link dependencies**:
   ```bash
   bd dep add bd-a1b2 bd-a1b3  # bd-a1b2 is blocked by bd-a1b3
   ```

4. **Find ready work**:
   ```bash
   bd ready  # Shows tasks with no open blockers
   ```

### Hierarchy Support

Beads supports hierarchical IDs for epics:
- `bd-a3f8` (Epic)
- `bd-a3f8.1` (Task)
- `bd-a3f8.1.1` (Sub-task)

## Agent Integration

Add to your AGENTS.md:

```markdown
## Task Tracking

Use 'bd' for task tracking:
- Run `bd ready` to find unblocked tasks
- Create tasks with `bd create "Title" -p <priority>`
- Link dependencies with `bd dep add <child> <parent>`
- Update status with `bd update <id> --claim` and `bd close <id> --reason <resolution>`
```

## Storage Modes

### Shared Server Mode (Current)
The stack runs ONE shared Dolt sql-server (image `dolthub/dolt-sql-server:2.2.0`,
service `dolt` in `infra/docker-compose.yml`, port 3306 on the dev network).
Each git worktree uses its own database (`model_md_worktree_<slug>`, created by
bd at first connect). All bd-capable containers set `BEADS_DOLT_SERVER_HOST=dolt`,
`BEADS_DOLT_SERVER_PORT=3306`, `BEADS_DOLT_SERVER_MODE=1`; no per-worktree dolt
process is ever spawned. This replaces the old per-worktree server flow whose
first-run failures (stale `dolt-server.lock`, local server boot) caused the
"trouble initializing beads the first time" friction.

### Stealth Mode
```bash
bd init --stealth
```
No git operations - useful for non-git VCS, monorepos, CI/CD, or evaluation.

## Current Status

### Binaries in Image ✅

| Binary | Location | Notes |
|--------|----------|-------|
| `bd` | `/usr/local/bin/bd` | Built with CGO_ENABLED=1 -tags gms_pure_go |
| `dolt` | `/usr/local/bin/dolt` | Database backend |
| `git` | `/usr/local/bin/git` | Dummy shim for stealth mode |

### Verified Working ✅

```bash
$ bd init --server --external --database model_md_worktree_feat_beads_integration --non-interactive -q
✓ bd initialized successfully!
  Backend: dolt
  Mode: server
  Database: model_md_worktree_feat_beads_integration

$ bd create "Test task" -p 1
✓ Created issue: model_md-worktree-feat-beads-integration-xxx

$ bd ready
○ model_md-worktree-feat-beads-integration-xxx ● P1 Test task
Ready: 1 issues with no active blockers
```

## Environment Variables

- `BEADS_DIR` - Override the beads state directory location. Worktrees discover `.beads/` automatically; main-repo sessions must pin this to a writable path.
- `BEADS_DOLT_SERVER_HOST` / `BEADS_DOLT_SERVER_PORT` / `BEADS_DOLT_SERVER_MODE` - Point bd at the shared Dolt service (set by compose on every bd-capable container)
- `BEADS_PATH` - Path to bd executable (MCP server)
- `BEADS_ACTOR` - Actor name for audit trail

## Resources

- [Beads Documentation](https://gastownhall.github.io/beads/)
- [Agent Workflow Guide](https://github.com/gastownhall/beads/blob/main/AGENT_INSTRUCTIONS.md)
- [MCP Integration](./integrations/beads-mcp)
