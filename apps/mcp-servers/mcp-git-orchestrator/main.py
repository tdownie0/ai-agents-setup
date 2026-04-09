import os
import json
import sys
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
def get_paths(feature_slug: str):
    """Utility to keep path logic consistent across all tools."""
    return {
        "worktree": APP_ROOT / f"model_md-worktree-{feature_slug}",
        "host": HOST_ROOT / f"model_md-worktree-{feature_slug}",
    }


@mcp.tool()
def initialize_worktree(feature_slug: str) -> str:
    """
    Ensures a git worktree exists and its Docker services are running.
    If the worktree already exists, it skips git creation and just restarts services.
    """
    paths = get_paths(feature_slug)
    new_path = paths["worktree"]
    services_file = new_path / "services.json"
    existed_initially = new_path.exists()

    if not BASE_PROJECT.exists():
        return f"Error: Base project directory {BASE_PROJECT} not found."

    try:
        git = GitRunner(BASE_PROJECT)
        if not existed_initially:
            git.run_git("worktree", ["add", str(new_path), "-b", feature_slug])

            # Patch .git file for container environment
            git_file = new_path / ".git"
            if git_file.exists():
                content = git_file.read_text()
                git_file.write_text(content.replace("gitdir: /app/", "gitdir: ../"))

            # Sync .env
            env_file = BASE_PROJECT / ".env"
            if env_file.exists():
                (new_path / ".env").write_text(env_file.read_text())

        if services_file.exists():
            data = json.loads(services_file.read_text())
            fe, be, db = data["frontend"], data["backend"], data["db"]
        else:
            fe, be, db = find_available_port_block()
            services_file.write_text(
                json.dumps(
                    {"branch": feature_slug, "frontend": fe, "backend": be, "db": db}
                )
            )

        env = os.environ.copy()
        env.update(
            {
                "BRANCH": feature_slug,
                "FRONTEND_PORT": str(fe),
                "BACKEND_PORT": str(be),
                "DB_PORT": str(db),
                "HOST_WORKTREE_PATH": str(paths["host"]),
                "DATABASE_URL": "postgres://postgres:password@db:5432/postgres",
            }
        )

        composer = DockerComposeRunner(feature_slug, new_path, env)

        if not existed_initially:
            try:
                Executor(new_path).run(["bd", "init", "--stealth", "--server"])
            except Exception as e:
                print(f"Warning: Beads init failed: {e}", file=sys.stderr)

        composer.up()

        status = "recovered" if existed_initially else "created"
        return (
            f"✅ Environment {status} at {new_path}\nPorts: FE:{fe}, BE:{be}, DB:{db}"
        )

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
    paths = get_paths(feature_slug)
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
    target_path = get_paths(feature_slug)["worktree"]
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

    target_path = get_paths(feature_slug)["worktree"]
    git = GitRunner(target_path)
    safe_args = list(git_args) if git_args else []

    # Security: Merging Policy
    if command == "merge":
        if not safe_args:
            return "Error: Merge requires a branch."
        for arg in safe_args:
            if arg.startswith("-"):
                continue
            if not arg.startswith("feat-") or any(
                x in arg for x in ["main", "master", "develop"]
            ):
                return f"Error: Security Violation. Merge of {arg} blocked."
        if "--no-edit" not in safe_args:
            safe_args.append("--no-edit")

    # Defaults
    if command == "add" and not safe_args:
        safe_args = ["."]
    if command == "commit" and not any(x in safe_args for x in ["-m", "--message"]):
        safe_args = ["-m", "Agent: implemented changes"] + safe_args

    try:
        res = git.run_git(command, safe_args)
        return res.stdout or f"Success: git {command} completed."
    except Exception as e:
        return f"Git Error: {str(e)}"


@mcp.tool()
def get_environment_status(feature_slug: str) -> str:
    """Returns the status of all containers for a given feature."""
    target_path = get_paths(feature_slug)["worktree"]
    composer = DockerComposeRunner(feature_slug, target_path)
    return composer.ps().stdout


@mcp.tool()
def stop_environment(feature_slug: str) -> str:
    """Tears down the docker-compose environment for a feature."""
    target_path = get_paths(feature_slug)["worktree"]
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
