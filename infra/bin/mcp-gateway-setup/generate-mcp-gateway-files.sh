#!/bin/bash
set -euo pipefail

# Resolve an absolute path without requiring `realpath` (portable across
# Linux/macOS). Fails closed to the given default if the dir can't be cd'd to.
abs_path() {
  local path="$1"
  local fallback="$2"
  if [ -d "$path" ]; then
    cd "$path" && pwd
  else
    echo "$fallback"
  fi
}

detect_mcp_root() {
  if [ -n "${DOCKER_MCP_ROOT:-}" ]; then
    echo "${DOCKER_MCP_ROOT}"
    return
  fi

  local repo_parent=""
  if [ -n "${PROJECT_PATH:-}" ]; then
    local proj_dir
    proj_dir="$(abs_path "$(dirname "$PROJECT_PATH")" "/")"
    if [ "$proj_dir" != "/" ]; then
      repo_parent="$proj_dir"
    fi
  fi

  if [ -z "$repo_parent" ]; then
    local script_dir repo_root
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    repo_root="$(cd "$script_dir/../../.." && pwd)"
    repo_parent="$(dirname "$repo_root")"
  fi

  echo "${repo_parent}/.docker/mcp"
}

MCP_DIR="$(detect_mcp_root)"
BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CATALOGS_DIR="$MCP_DIR/catalogs"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$CATALOGS_DIR"

envsubst < "$BIN_DIR/local-mcp.yaml.template" > "$TMP_DIR/local-mcp.yaml"

cat <<EOF > "$TMP_DIR/catalog.json"
{
  "catalogs": {
    "local-mcp": {
      "displayName": "Local Development Catalog",
      "url": "$MCP_DIR/catalogs/local-mcp.yaml"
    }
  }
}
EOF

cp "$TMP_DIR/local-mcp.yaml" "$CATALOGS_DIR/local-mcp.yaml"
cp "$TMP_DIR/catalog.json" "$MCP_DIR/catalog.json"

cat <<EOF

=======================================================================
MCP configuration installed to: ${MCP_DIR}
=======================================================================

Generated files:
  - ${MCP_DIR}/catalog.json
  - ${MCP_DIR}/catalogs/local-mcp.yaml

=======================================================================

EOF
