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

# Resolve the MCP catalog root.
#
# Priority:
#   1. DOCKER_MCP_ROOT (explicit override; Taskfile passes
#      LOCAL_DOCKER_DESKTOP_CATALOG here).
#   2. <parent-of-main-project>/.docker/mcp — the directory alongside the
#      git worktrees, derived from PROJECT_PATH (passed by tasks/mcp.yml).
#   3. Script-location fallback: three levels above this script is the repo
#      root; its parent is the worktree parent directory.
#
# NEVER anchor the fallback to $HOME: under `sudo`, $HOME resolves to /root,
# which silently scatters root-owned catalog files outside the workspace.
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

# Write intermediates to a temp dir, not the repo, so a `sudo task mcp:setup`
# never leaves root-owned files inside the worktree.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$CATALOGS_DIR"

envsubst < "$BIN_DIR/local-mcp.yaml.template" > "$TMP_DIR/local-mcp.yaml"

cat <<EOF > "$TMP_DIR/catalog.json"
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

cp "$TMP_DIR/local-mcp.yaml" "$CATALOGS_DIR/local-mcp.yaml"
cp "$TMP_DIR/catalog.json" "$MCP_DIR/catalog.json"

# If invoked under sudo, restore ownership to the invoking user so catalogs
# are usable by the non-root workflow (git-orchestrator, agents).
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_UID:-}" ]; then
  chown -R "${SUDO_UID}:${SUDO_GID:-$SUDO_UID}" "$MCP_DIR"
fi

cat <<EOF

=======================================================================
MCP configuration installed to: ${MCP_DIR}
=======================================================================

Generated files:
  - ${MCP_DIR}/catalog.json
  - ${MCP_DIR}/catalogs/local-mcp.yaml

Register your MCP servers using:
  docker mcp server enable supabase-manager
  docker mcp server enable ast-explorer
  docker mcp server enable git-orchestrator

=======================================================================

EOF