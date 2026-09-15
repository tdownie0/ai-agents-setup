# Pi AI Coding Tool Configuration

This directory contains project-local configuration for the Pi AI coding tool.

## Files

- **settings.json**: Pi project settings (provider, model, thinking level)
- **mcp.json**: MCP server configuration (connects to mcp-gateway)
- **APPEND_SYSTEM.md**: Additional system prompt instructions appended to Pi's defaults

## Pi Auto-Discovers

Pi automatically loads from the project root and parent directories:

- `AGENTS.md` or `CLAUDE.md` - Agent instructions (concatenated)
- `.pi/settings.json` - Project settings (overrides global)
- `.pi/mcp.json` - Project MCP config
- `.pi/APPEND_SYSTEM.md` - Appended system prompt

## Custom Subagents (pi-sub-agent)

The [pi-sub-agent](https://www.npmjs.com/package/pi-sub-agent) extension loads role prompts
from **`$PI_CODING_AGENT_DIR/agents/*.md`** (user-level) or `.pi/agents/*.md` (project-level) —
**not** a `subagents/` directory. In this repo, `.pi/agents/*.md` is both:
the project-level agents dir in-worktree, and (via `ai:setup` seeding) the user-level
`$PI_CODING_AGENT_DIR/agents/` dir in the container. Supported frontmatter fields:

- `name` (required) — agent id
- `description` (required) — shown to the dispatcher for selection
- `tools` (optional) — comma string or array, e.g. `read, grep, find, ls, bash`
- `model` (optional) — model override; when omitted the agent inherits the dispatcher's model

The markdown body becomes the appended system prompt for the spawned pi session
(`--append-system-prompt`). Any other frontmatter fields are ignored.

## Container Layout

Agent containers run with `PI_CODING_AGENT_DIR=/home/node/.pi/agent` and mount
`${PROJECT_PARENT_PATH}/.docker/pi:/home/node/.pi`. The repo's `.pi/` is seeded by
`go-task ai:setup P=pi` into `${PROJECT_PARENT_PATH}/.docker/pi/agent/`, so:

- `.pi/settings.json` → `/home/node/.pi/agent/settings.json`
- `.pi/mcp.json` → `/home/node/.pi/agent/mcp.json`
- `.pi/agents/*.md` → `/home/node/.pi/agent/agents/*.md` — the location pi-sub-agent loads

## Global Config (Host)

User-global configuration lives at `~/.pi/agent/`:

- `~/.pi/agent/settings.json` - Global settings
- `~/.pi/agent/mcp.json` - Global MCP servers
- `~/.pi/agent/auth.json` - API keys
- `~/.pi/agent/models.json` - Custom model definitions
- `~/.pi/agent/extensions/` - Pi extensions
- `~/.pi/agent/skills/` - Pi skills
- `~/.pi/agent/AGENTS.md` - Global agent instructions

## Key Environment Variables

- `GEMINI_API_KEY` - API key for Google Gemini
- `PI_CODING_AGENT_DIR` - Override config directory (default: `~/.pi/agent`)