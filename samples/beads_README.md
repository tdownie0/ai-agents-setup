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
- `bd` - beads CLI (built from source with CGO_ENABLED=0)
- `dolt` - database backend
- `git` - dummy shim for stealth mode

### Building the Image

Rebuild with the updated Dockerfile.opencode:
```bash
docker build -f Dockerfile.opencode -t dev-opencode:latest .
```

## Usage

### Essential Commands

| Command | Action |
|---------|--------|
| `bd ready` | List tasks with no open blockers |
| `bd create "Title" -p 0` | Create a P0 task |
| `bd update <id> --claim` | Atomically claim a task |
| `bd dep add <child> <parent>` | Link tasks (blocks, related, parent-child) |
| `bd show <id>` | View task details and audit trail |
| `bd close <id> "Fixed"` | Close with resolution message |

### Workflow Integration

1. **Initialize beads** in worktree (stealth mode for Git-free environments):
   ```bash
   bd init --stealth --server
   ```

2. **Configure the database** (if needed):
   ```bash
   # Edit .beads/config.yaml
   no-git-ops: true
   dolt_server:
     host: "127.0.0.1"
     port: 3307
     user: "root"
     data_dir: ".beads/dolt"
   ```

3. **Start dolt server** (server mode requires running dolt):
   ```bash
   nohup dolt sql-server --port 3307 --data-dir .beads/dolt > /tmp/dolt.log 2>&1 &
   ```

4. **Create tasks** for your feature:
   ```bash
   bd create "Implement user registration" -p 1
   bd create "Add database schema for users" -p 0
   ```

5. **Link dependencies**:
   ```bash
   bd dep add bd-a1b2 bd-a1b3  # bd-a1b2 is blocked by bd-a1b3
   ```

6. **Find ready work**:
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
- Update status with `bd update <id> --claim` and `bd close <id> <resolution>`
```

## Storage Modes

### Server Mode (Recommended)
```bash
bd init --server
```
Connects to external Dolt server. Data in `.beads/dolt/`. Supports concurrent writers.

### Stealth Mode
```bash
bd init --stealth
```
No git operations - useful for non-git VCS, monorepos, CI/CD, or evaluation.

## Current Status

### Binaries in Image ✅

| Binary | Location | Notes |
|--------|----------|-------|
| `bd` | `/usr/local/bin/bd` | Built with CGO_ENABLED=0 |
| `dolt` | `/usr/local/bin/dolt` | Database backend |
| `git` | `/usr/local/bin/git` | Dummy shim for stealth mode |

### Verified Working ✅

```bash
$ bd init --stealth --server
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

- `BEADS_DIR` - Override database directory location
- `BEADS_PATH` - Path to bd executable (MCP server)
- `BEADS_ACTOR` - Actor name for audit trail

## Resources

- [Beads Documentation](https://gastownhall.github.io/beads/)
- [Agent Workflow Guide](https://github.com/gastownhall/beads/blob/main/AGENT_INSTRUCTIONS.md)
- [MCP Integration](./integrations/beads-mcp)
