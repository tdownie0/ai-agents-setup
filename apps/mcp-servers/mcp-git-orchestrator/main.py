import os
import json
import sys
import shutil
from pathlib import Path
from mcp.server.fastmcp import FastMCP

# Import our custom modules
from provider import release_ports, find_available_port_block
from engine import DockerComposeRunner, GitRunner, Executor

# --- Configuration ---
UID = os.getenv("USER_ID", "1000")
GID = os.getenv("GROUP_ID", "1000")
APP_ROOT = Path("/app")
BASE_PROJECT = APP_ROOT / "model_md"
HOST_ROOT = Path(os.getenv("PROJECT_PARENT_PATH", "/home/user/project"))

mcp = FastMCP("Worktree-Orchestrator")


# --- Helpers ---
def _get_paths(feature_slug: str):
    """Utility to keep path logic consistent across all tools."""
    return {
        "worktree": APP_ROOT / f"model_md-worktree-{feature_slug}",
        "host": HOST_ROOT / f"model_md-worktree-{feature_slug}",
    }


def _provision_git_worktree(new_path: Path, feature_slug: str):
    """Handles the physical creation and patching of the git worktree."""
    git = GitRunner(BASE_PROJECT)
    git.run_git("worktree", ["add", str(new_path), "-b", feature_slug])

    # Patch .git file for container environment (relative pathing fix)
    git_file = new_path / ".git"
    if git_file.exists():
        content = git_file.read_text()
        git_file.write_text(content.replace("gitdir: /app/", "gitdir: ../"))

    # Sync environment configuration
    env_file = BASE_PROJECT / ".env"
    if env_file.exists():
        (new_path / ".env").write_text(env_file.read_text())


def _get_or_assign_ports(worktree_path: Path, feature_slug: str):
    """Retrieves existing ports or allocates a new block via Redis."""
    services_file = worktree_path / "services.json"

    if services_file.exists():
        data = json.loads(services_file.read_text())
        return data["frontend"], data["backend"], data["db"]

    fe, be, db = find_available_port_block()
    services_file.write_text(
        json.dumps({"branch": feature_slug, "frontend": fe, "backend": be, "db": db})
    )
    return fe, be, db


def _bootstrap_agent_env(worktree_path: Path):
    """Executes the stealth 'beads' initialization for the AI agent."""
    fake_git_dir = worktree_path / ".tmp_bin"
    try:
        fake_git_dir.mkdir(parents=True, exist_ok=True)
        (fake_git_dir / "git").write_text("#!/bin/sh\nexit 1")
        (fake_git_dir / "git").chmod(0o755)

        custom_env = os.environ.copy()
        custom_env["PATH"] = f"{fake_git_dir}:{custom_env['PATH']}"

        executor = Executor(worktree_path, env=custom_env)
        executor.run(["bd", "init", "--stealth", "--server"], check=False)
    finally:
        if fake_git_dir.exists():
            shutil.rmtree(fake_git_dir)


def _validate_git_policy(command: str, args: list[str]) -> str | None:
    """
    Enforces security constraints on git operations.
    Returns an error message string if invalid, otherwise None.
    """
    if command == "merge":
        if not args:
            return "Error: Merge requires a branch."

        for arg in args:
            if arg.startswith("-"):
                continue

            is_valid_feat = arg.startswith("feat-")
            is_protected = any(x in arg for x in ["main", "master", "develop"])

            if not is_valid_feat or is_protected:
                return f"Error: Security Violation. Merge of {arg} blocked."

    return None


def _apply_git_defaults(command: str, args: list[str]) -> list[str]:
    """Injects safe defaults for specific git commands."""
    safe_args = list(args)

    if command == "merge" and "--no-edit" not in safe_args:
        safe_args.append("--no-edit")

    if command == "add" and not safe_args:
        safe_args = ["."]

    if command == "commit" and not any(x in safe_args for x in ["-m", "--message"]):
        safe_args = ["-m", "Agent: implemented changes"] + safe_args

    return safe_args


@mcp.tool()
def initialize_worktree(feature_slug: str) -> str:
    """
    Ensures a git worktree exists and its Docker services are running.
    """
    paths = _get_paths(feature_slug)
    worktree_path = paths["worktree"]
    existed_initially = worktree_path.exists()

    if not BASE_PROJECT.exists():
        return f"❌ Error: Base project directory {BASE_PROJECT} not found."

    try:
        if not existed_initially:
            _provision_git_worktree(worktree_path, feature_slug)

        fe, be, db = _get_or_assign_ports(worktree_path, feature_slug)

        env_vars = os.environ.copy()
        env_vars.update(
            {
                "BRANCH": feature_slug,
                "FRONTEND_PORT": str(fe),
                "BACKEND_PORT": str(be),
                "DB_PORT": str(db),
                "HOST_WORKTREE_PATH": str(paths["host"]),
                "DATABASE_URL": "postgres://postgres:password@db:5432/postgres",
            }
        )

        composer = DockerComposeRunner(feature_slug, worktree_path, env_vars)

        if not existed_initially:
            _bootstrap_agent_env(worktree_path)

        composer.up()

        status = "recovered" if existed_initially else "created"
        return f"✅ Environment {status} at {worktree_path}\nPorts: FE:{fe}, BE:{be}, DB:{db}"

    except Exception as e:
        return f"❌ Initialization Failed: {str(e)}"


@mcp.tool()
def execute_lifecycle(feature_slug: str, action: str) -> str:
    """
    Executes a predefined lifecycle action within the feature-specific Docker containers.

    This tool is the primary way to manage the environment state after making code changes.
    Always run 'install' if package.json files have been modified.

    Available Actions:
        - install: Runs 'pnpm install' in both backend and frontend containers.
        - initialize: Performs a full database reset, migration, and seeding.
        - generate: Runs Drizzle schema generation.
        - migrate: Applies pending database migrations.
        - seed: Populates the database with seed data.
        - verify: Runs database-related tests.
        - format: Automatically fixes linting errors and formats code (pnpm lint & pnpm fmt).
        - build: Compiles the backend and frontend applications.

    Args:
        feature_slug: The unique identifier for the feature worktree.
        action: One of 'install', 'initialize', 'generate', 'migrate', 'seed', 'verify', 'build'.
    """
    paths = _get_paths(feature_slug)
    composer = DockerComposeRunner(feature_slug, paths["worktree"])

    action_map = {
        "install": [("backend", ["install"]), ("frontend", ["install"])],
        "initialize": [
            ("backend", ["db:reset"]),
            ("backend", ["db:migrate"]),
            ("backend", ["db:seed"]),
        ],
        "generate": [("backend", ["db:generate"])],
        "migrate": [("backend", ["db:migrate"])],
        "seed": [("backend", ["db:seed"])],
        "verify": [("backend", ["test:db"])],
        "format": [
            ("backend", ["lint:fix"]),
            ("backend", ["fmt"]),
            ("frontend", ["lint:fix"]),
            ("frontend", ["fmt"]),
        ],
        "build": [("backend", ["build"]), ("frontend", ["build"])],
    }

    if action not in action_map:
        return f"Error: Action '{action}' unknown."

    results = []
    try:
        for service, args in action_map[action]:
            res = composer.exec_pnpm(service, args)
            results.append(f"Success ({service} pnpm {' '.join(args)}):\n{res.stdout}")
        return "\n---\n".join(results)
    except Exception as e:
        return f"❌ Action '{action}' failed: {str(e)}"


@mcp.tool()
def get_environment_logs(
    feature_slug: str, service: str | None = None, tail: int = 50
) -> str:
    """
    Retrieves the last 'n' lines of logs for a feature's containers.
    If 'service' is provided (e.g., 'backend', 'db'), only those logs are returned.
    """
    target_path = _get_paths(feature_slug)["worktree"]
    composer = DockerComposeRunner(feature_slug, target_path)
    return composer.logs(tail=tail, service=service).stdout


@mcp.tool()
def git_ops(feature_slug: str, command: str, git_args: list[str] | None = None) -> str:
    """
    Executes permitted git commands within a specific feature worktree.

    CRITICAL: Merging is strictly limited to internal 'feat-*' branches.
    Attempts to merge 'main', 'master', or 'develop' will be blocked.

    Args:
        feature_slug (str): The unique identifier for the feature (e.g., 'lint-addition').
        command (str): The git command to run (add, commit, status, diff, log, branch, merge).
        git_args (list[str] | None): A list of string arguments required for the command.
                  - For merge: ["feat-posts-backend"] (REQUIRED)
                  - For add: ["."] or ["path/to/file"]
                  - For commit: ["-m", "your message"]
    """
    ALLOWED = ["add", "commit", "status", "diff", "log", "branch", "merge"]
    if command not in ALLOWED:
        return f"Error: '{command}' unauthorized."

    input_args = git_args or []

    error = _validate_git_policy(command, input_args)
    if error:
        return error

    safe_args = _apply_git_defaults(command, input_args)
    target_path = _get_paths(feature_slug)["worktree"]

    try:
        git = GitRunner(target_path)
        res = git.run_git(command, safe_args)
        return res.stdout or f"Success: git {command} completed."
    except Exception as e:
        return f"Git Error: {str(e)}"


@mcp.tool()
def get_environment_status(feature_slug: str) -> str:
    """Returns the status of all containers for a given feature."""
    target_path = _get_paths(feature_slug)["worktree"]
    composer = DockerComposeRunner(feature_slug, target_path)
    return composer.ps().stdout


@mcp.tool()
def stop_environment(feature_slug: str) -> str:
    """Tears down the docker-compose environment for a feature."""
    target_path = _get_paths(feature_slug)["worktree"]
    services_file = target_path / "services.json"

    if services_file.exists():
        try:
            data = json.loads(services_file.read_text())
            release_ports([data["frontend"], data["backend"], data["db"]])
        except Exception as e:
            print(f"Warning: Redis cleanup failed: {e}", file=sys.stderr)

    try:
        composer = DockerComposeRunner(feature_slug, target_path)
        composer.down()
        return f"✅ Environment for {feature_slug} stopped and cleaned."
    except Exception as e:
        return f"❌ Stop Error: {str(e)}"


@mcp.tool()
def list_features() -> str:
    """Lists all active feature worktrees."""
    worktrees = [p.name for p in APP_ROOT.glob("model_md-worktree-*")]
    return "\n".join(worktrees) if worktrees else "No active feature worktrees."


if __name__ == "__main__":
    mcp.run(transport="stdio")
