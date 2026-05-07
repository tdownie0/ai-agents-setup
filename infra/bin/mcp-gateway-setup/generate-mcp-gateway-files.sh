#!/bin/bash
set -euo pipefail

MCP_DIR="${DOCKER_MCP_ROOT:-$HOME/.docker/mcp}"
BIN_DIR="infra/bin/mcp-gateway-setup"

envsubst < $BIN_DIR/local-mcp.yaml.template > $BIN_DIR/local-mcp.yaml

cat <<EOF > "$BIN_DIR/catalog.json"
{
  "catalogs": {
    "docker-mcp": {
      "displayName": "Docker MCP Catalog",
      "url": "https://desktop.docker.com/mcp/catalog/v2/catalog.yaml",
      "lastUpdate": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    },
    "local-mcp": {
      "displayName": "Local Development Catalog",
      "url": "$MCP_DIR/catalogs/local-mcp.yaml"
    }
  }
}
EOF

cat <<EOF

========================================================================
Files generated in infra/bin/mcp-gateway-setup/
========================================================================

Please use these files as an example for populating the local docker/mcp
configuration. Depending on where Docker Desktop is installed, this
directory may possibly be located at:
  ${MCP_DIR}

Place 'local-mcp.yaml' inside the 'catalogs' directory within that path.

Note: Adjust for your OS pathing (e.g., Windows '\\\\', Linux '/').

------------------------------------------------------------------------
Next Steps:
------------------------------------------------------------------------
After configuring, register your MCP servers using:
  docker mcp server enable supabase-manager

========================================================================

EOF
