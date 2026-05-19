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
