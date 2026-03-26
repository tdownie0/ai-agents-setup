import sys
import os
import json
import socket
import subprocess
from pathlib import Path
from mcp.server.fastmcp import FastMCP

# Environment configuration
UID = os.getenv("USER_ID", "1000")
GID = os.getenv("GROUP_ID", "1000")
mcp = FastMCP("Worktree-Orchestrator")

APP_ROOT = Path("/app")
BASE_PROJECT = APP_ROOT / "model_md"
HOST_ROOT = Path(os.getenv("PROJECT_PARENT_PATH", "/home/user/project"))
print(f"Orchestrator initialized as UID:{UID}, GID:{GID}", file=sys.stderr, flush=True)


def find_available_port_block(start_port=5174) -> tuple[int, int, int]:
    """Finds a block of three consecutive available ports."""

    def is_port_in_use(port):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            return s.connect_ex(("localhost", port)) == 0

    port = start_port
    while True:
        fe, be, db = port, port + 1000, port + 2000
        if not any(is_port_in_use(p) for p in (fe, be, db)):
            docker_check = subprocess.run(
                ["docker", "ps", "--format", "{{.Ports}}"],
                capture_output=True,
                text=True,
            )
            if not any(f":{p}->" in docker_check.stdout for p in (fe, be, db)):
                return fe, be, db
        port += 1


@mcp.tool()
def initialize_worktree(feature_slug: str) -> str:
    """
    Ensures a git worktree exists and its Docker services are running.
    If the worktree already exists, it skips git creation and just restarts services.
    """
    new_path = APP_ROOT / f"model_md-worktree-{feature_slug}"
    new_path_host = HOST_ROOT / f"model_md-worktree-{feature_slug}"
    services_file = new_path / "services.json"

    if not BASE_PROJECT.exists():
        return f"Error: Base project directory {BASE_PROJECT} not found."

    try:
        if not new_path.exists():
            subprocess.run(
                ["git", "worktree", "add", str(new_path), "-b", feature_slug],
                cwd=BASE_PROJECT,
                check=True,
                capture_output=True,
                text=True,
            )

            git_file = new_path / ".git"
            if git_file.exists():
                content = git_file.read_text()
                if "gitdir: /app/" in content:
                    git_file.write_text(content.replace("gitdir: /app/", "gitdir: ../"))

            env_file = BASE_PROJECT / ".env"
            if env_file.exists():
                (new_path / ".env").write_text(env_file.read_text())

            fe_port, be_port, db_port = find_available_port_block()
            services_data = {
                "branch": feature_slug,
                "frontend": fe_port,
                "backend": be_port,
                "db": db_port,
            }
            services_file.write_text(json.dumps(services_data))
        else:
            if services_file.exists():
                services_data = json.loads(services_file.read_text())
                fe_port = services_data["frontend"]
                be_port = services_data["backend"]
                db_port = services_data["db"]
            else:
                fe_port, be_port, db_port = find_available_port_block()

        env = os.environ.copy()
        env.update(
            {
                "BRANCH": feature_slug,
                "FRONTEND_PORT": str(fe_port),
                "BACKEND_PORT": str(be_port),
                "DB_PORT": str(db_port),
                "HOST_WORKTREE_PATH": str(new_path_host),
                "DATABASE_URL": "postgres://postgres:password@db:5432/postgres",
            }
        )

        subprocess.run(
            [
                "docker",
                "compose",
                "-p",
                feature_slug,
                "-f",
                "docker-compose.feature.yml",
                "up",
                "-d",
            ],
            cwd=new_path,
            env=env,
            check=True,
            capture_output=True,
            text=True,
        )

        status_msg = (
            "recovered and started" if new_path.exists() else "created and started"
        )
        return (
            f"✅ Environment {status_msg} at {new_path}\n"
            f"Services: Frontend:{fe_port}, Backend:{be_port}, DB:{db_port}"
        )

    except subprocess.CalledProcessError as e:
        return f"Initialization Failed: {e.stderr or e.stdout}"
    except Exception as e:
        return f"Unexpected Error: {str(e)}"


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
    target_path = APP_ROOT / f"model_md-worktree-{feature_slug}"

    def compose_exec(service: str, args: list[str]):
        return [
            "docker",
            "compose",
            "-p",
            feature_slug,
            "exec",
            "-T",
            service,
            "pnpm",
        ] + args

    actions = {
        "install": [
            compose_exec("backend", ["install"]),
            compose_exec("frontend", ["install"]),
        ],
        "initialize": [
            compose_exec("backend", ["db:reset"]),
            compose_exec("backend", ["db:migrate"]),
            compose_exec("backend", ["db:seed"]),
        ],
        "generate": [compose_exec("backend", ["db:generate"])],
        "migrate": [compose_exec("backend", ["db:migrate"])],
        "seed": [compose_exec("backend", ["db:seed"])],
        "verify": [compose_exec("backend", ["test:db"])],
        "format": [
            compose_exec("backend", ["lint:fix"]),
            compose_exec("backend", ["fmt"]),
            compose_exec("frontend", ["lint:fix"]),
            compose_exec("frontend", ["fmt"]),
        ],
        "build": [
            compose_exec("backend", ["build"]),
            compose_exec("frontend", ["build"]),
        ],
    }

    if action not in actions:
        return f"Error: Action '{action}' not recognized. Available: {list(actions.keys())}"

    results = []
    for cmd in actions[action]:
        try:
            res = subprocess.run(
                cmd, cwd=target_path, capture_output=True, text=True, check=True
            )
            results.append(f"Success ({' '.join(cmd)}):\n{res.stdout}")
        except subprocess.CalledProcessError as e:
            return (
                f"Action '{action}' failed at command: {' '.join(cmd)}\n"
                f"STDOUT: {e.stdout}\nSTDERR: {e.stderr}"
            )

    return "\n---\n".join(results)


@mcp.tool()
def get_environment_logs(
    feature_slug: str, service: str | None = None, tail: int = 50
) -> str:
    """
    Retrieves the last 'n' lines of logs for a feature's containers.
    If 'service' is provided (e.g., 'backend', 'db'), only those logs are returned.
    """
    target_path = APP_ROOT / f"model_md-worktree-{feature_slug}"

    cmd = [
        "docker",
        "compose",
        "-p",
        feature_slug,
        "logs",
        f"--tail={tail}",
        "--no-color",
    ]

    if service:
        cmd.append(service)

    try:
        res = subprocess.run(
            cmd, cwd=target_path, capture_output=True, text=True, check=True
        )
        if not res.stdout and not res.stderr:
            return (
                f"No logs found for {feature_slug} {f'({service})' if service else ''}."
            )
        return res.stdout or res.stderr
    except subprocess.CalledProcessError as e:
        return f"Failed to retrieve logs: {e.stderr}"


@mcp.tool()
def git_ops(feature_slug: str, command: str, args: list[str] | None = None) -> str:
    """
    Executes permitted git commands within a specific feature worktree.

    Allowed commands: add, commit, status, diff, log, branch.

    Args:
        feature_slug: The unique identifier for the feature (e.g., 'lint-addition').
        command: The git command to run.
        args: A list of string arguments.
              Example for add: ["."] or ["apps/backend/package.json"]
              Example for commit: ["-m", "your message"]
              Note: 'add' defaults to ["."] and 'commit' provides a default message if args are empty.
    """
    ALLOWED_COMMANDS = ["add", "commit", "status", "diff", "log", "branch"]
    if command not in ALLOWED_COMMANDS:
        return f"Error: Command '{command}' is not permitted."

    target_path = APP_ROOT / f"model_md-worktree-{feature_slug}"

    safe_args = args if args is not None else []

    if command == "add" and not safe_args:
        safe_args = ["."]

    if command == "commit" and not any(arg in safe_args for arg in ["-m", "--message"]):
        safe_args = ["-m", "Agent: implemented feature changes"] + safe_args

    full_cmd = ["git", command] + safe_args

    try:
        res = subprocess.run(
            full_cmd, cwd=target_path, capture_output=True, text=True, check=True
        )
        return res.stdout

    except subprocess.CalledProcessError as e:
        return f"Git Error: {e.stderr}"


@mcp.tool()
def get_environment_status(feature_slug: str) -> str:
    """Returns the status of all containers for a given feature."""
    res = subprocess.run(
        ["docker", "compose", "-p", feature_slug, "ps"], capture_output=True, text=True
    )
    return res.stdout


@mcp.tool()
def stop_environment(feature_slug: str) -> str:
    """Tears down the docker-compose environment for a feature."""
    target_path = APP_ROOT / f"model_md-worktree-{feature_slug}"

    try:
        subprocess.run(
            ["docker", "compose", "-p", feature_slug, "down", "-v"],
            cwd=target_path,
            check=True,
            capture_output=True,
        )
        return f"Environment for {feature_slug} stopped and cleaned."
    except Exception as e:
        return f"Stop Error: {str(e)}"


@mcp.tool()
def list_features() -> str:
    """Lists all active feature worktrees."""
    worktrees = [p.name for p in APP_ROOT.glob("model_md-worktree-*")]
    return "\n".join(worktrees) if worktrees else "No active feature worktrees."


if __name__ == "__main__":
    mcp.run(transport="stdio")
