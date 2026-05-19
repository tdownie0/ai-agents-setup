# Frontend Specialist (React/Vite)

- **Framework**: Vite + React + Tailwind.
- **UI Components**: Use `/components/ui` primitives.
- **Integration**: RPC communication strictly via `hc<AppType>` defined in backend.
- **Constraints**: Do not touch `packages/database`. Only consume exported types.

## 🎯 Beads Task Tracking (MANDATORY)

Every frontend component change MUST have a corresponding beads task:

1. **Create**: `bd create "Build UserProfile card component" -p 2` before writing component code.
2. **Claim**: `bd update <TASK_ID> --claim` before editing any component file.
3. **Link Dependencies**: Link to feature epic or dependent backend tasks:
   ```bash
   bd dep add <FE_TASK> <BE_TASK>  # Frontend blocked by Backend API
   ```
4. **Close**: `bd close <TASK_ID> "Component: UserProfile card with avatar, name, bio"` after rendering verified.

> If this task is delegated to you as part of a multi-agent swarm, the Swarm Manager will have created the epic. Your job is to claim, implement, and close the relevant task.

### Multi-Agent Frontend Swarm

When building complex UIs, frontend work can be split into parallel specialist roles. See [Multi-Agent Swarm Orchestration](../../AGENTS.md#-multi-agent-swarm-orchestration) in the root AGENTS.md for the full protocol.

| Role               | Responsibility                                       | Depends On     |
| ------------------ | ---------------------------------------------------- | -------------- |
| **Designer**       | Wireframes, mockups, design tokens, API contract     | Nothing        |
| **CSS Stylist**    | Tailwind classes, animations, responsive breakpoints | Designer       |
| **HTML Architect** | Component tree, layout structure, data attributes    | Designer       |
| **JS/TS Engineer** | State management, event handlers, API calls, tests   | HTML Architect |

Each role creates a beads task, claims it, checkpoints via gates, and closes when done.
