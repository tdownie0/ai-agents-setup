import sys
import os
from mcp.server.fastmcp import FastMCP
import subprocess
from pathlib import Path

UID = os.getenv("USER_ID", "1000")
GID = os.getenv("GROUP_ID", "1000")

mcp = FastMCP("Worktree-Orchestrator")
APP_ROOT = Path("/app")
BASE_PROJECT = APP_ROOT / "model_md"

print(f"Orchestrator initialized as UID:{UID}, GID:{GID}", file=sys.stderr, flush=True)

@mcp.tool()
def initialize_worktree(feature_slug: str) -> str:
    """
    Creates a sibling git worktree, injects .env, and hydrates with pnpm.
    Target: /app/model_md-worktree-{feature_slug}
    """
    new_path = APP_ROOT / f"model_md-worktree-{feature_slug}"

    if not BASE_PROJECT.exists():
        return f"Error: Base project directory {BASE_PROJECT} not found."

    if new_path.exists():
        return f"Error: Worktree path {new_path} already exists."

    try:
        subprocess.run(
            ["git", "worktree", "add", str(new_path), "-b", feature_slug],
            cwd=BASE_PROJECT, 
            check=True, 
            capture_output=True, 
            text=True
        )

        env_file = BASE_PROJECT / ".env"
        if env_file.exists():
            (new_path / ".env").write_text(env_file.read_text())

        subprocess.run(
            ["pnpm", "install", "--frozen-lockfile"], 
            cwd=new_path, 
            check=True, 
            capture_output=True, 
            text=True
        )

        return f"Successfully initialized worktree at {new_path}"

    except subprocess.CalledProcessError as e:
        return f"Init Error: {e.stderr or e.stdout}"
    except Exception as e:
        return f"Unexpected Error: {str(e)}"

@mcp.tool()
def git_ops(feature_slug: str, command: str, args: list[str] = None) -> str:
    """
    Executes safe git commands within a worktree.
    Args:
        feature_slug: The identifier for the worktree.
        command: The git verb (e.g., 'add', 'commit', 'status').
        args: A list of arguments (e.g., ['file.sql', '-m', 'message']).
    """
    ALLOWED_COMMANDS = ["add", "commit", "status", "diff", "log", "branch"]

    if command not in ALLOWED_COMMANDS:
        return f"Error: Command '{command}' is not permitted."

    target_path = APP_ROOT / f"model_md-worktree-{feature_slug}"
    full_cmd = ["git", command] + (args if args else [])

    try:
        res = subprocess.run(
            full_cmd, 
            cwd=target_path, 
            capture_output=True, 
            text=True, 
            check=True
        )
        return res.stdout

    except subprocess.CalledProcessError as e:
        return f"Git Error: {e.stderr}"

@mcp.tool()
def prepare_merge(feature_slug: str) -> str:
    """Verifies worktree status and prepares the branch for merging."""
    # Ensure no uncommitted changes exist before signaling readiness
    target_path = APP_ROOT / f"model_md-worktree-{feature_slug}"
    status = subprocess.run(["git", "status", "--porcelain"], cwd=target_path, capture_output=True, text=True)
    if status.stdout.strip():
        return "Error: Worktree has uncommitted changes. Please commit first."
    return "Worktree clean and ready for merge."

@mcp.tool()
def execute_merge(feature_slug: str, target_branch: str) -> str:
    """
    Merges a worktree branch into a target integration branch.
    Prevents merging into protected branches like 'main' or 'prod'.
    """
    PROTECTED_BRANCHES = ["main", "master", "prod", "production", "stable"]

    if target_branch in PROTECTED_BRANCHES:
        return f"Access Denied: Agents are not permitted to merge directly into {target_branch}."

    try:
        # 1. Ensure we are in the base repo to perform the merge
        # 2. Checkout the integration branch (e.g., feat/ui-refresh)
        subprocess.run(["git", "checkout", target_branch], cwd=BASE_PROJECT, check=True, capture_output=True)

        # 3. Merge the specific feature worktree branch
        subprocess.run(["git", "merge", feature_slug], cwd=BASE_PROJECT, check=True, capture_output=True)

        # 4. Cleanup the worktree after successful merge
        # We use --force if needed, but standard remove is safer
        subprocess.run(["git", "worktree", "remove", f"../model_md-worktree-{feature_slug}"], 
                       cwd=BASE_PROJECT, check=True, capture_output=True)

        # 5. Delete the now-merged local branch
        subprocess.run(["git", "branch", "-d", feature_slug], cwd=BASE_PROJECT, check=True, capture_output=True)

        return f"Successfully merged {feature_slug} into {target_branch} and cleaned up worktree."

    except subprocess.CalledProcessError as e:
        return f"Merge Conflict or Git Error: {e.stderr.decode()}"

if __name__ == "__main__":
    mcp.run(transport='stdio')
