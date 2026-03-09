#!/bin/bash
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)

    envsubst < bin/mcp-gateway-setup/local-mcp.yaml.template > bin/mcp-gateway-setup/local-mcp.yaml
else
    echo "Error: .env file not found at root."
    exit 1
fi

MCP_ROOT="${DOCKER_MCP_ROOT:-$HOME/.docker/mcp}"

cat <<EOF > "bin/mcp-gateway-setup/catalog.json"
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

echo "Files generated in mcp-gateway-setup/."
echo "Please use these files as an example for the following locations, or move them (though you \
should not need to update the existing docker-mcp catalog.json entry) to $MCP_ROOT and \
$MCP_ROOT/local-mcp.yaml respectively."
