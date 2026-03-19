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
            return s.connect_ex(('localhost', port)) == 0

    port = start_port
    while True:
        fe, be, db = port, port + 1000, port + 2000
        if not any(is_port_in_use(p) for p in (fe, be, db)):
            docker_check = subprocess.run(
                ["docker", "ps", "--format", "{{.Ports}}"],
                capture_output=True, text=True
            )
            if not any(f":{p}->" in docker_check.stdout for p in (fe, be, db)):
                return fe, be, db
        port += 1

@mcp.tool()
def initialize_worktree(feature_slug: str) -> str:
    """Creates worktree, translates paths for Docker Host, and spins up services."""
    new_path = APP_ROOT / f"model_md-worktree-{feature_slug}"
    new_path_host = HOST_ROOT / f"model_md-worktree-{feature_slug}"

    if not BASE_PROJECT.exists():
        return f"Error: Base project directory {BASE_PROJECT} not found."
    if new_path.exists():
        return f"Error: Worktree path {new_path} already exists."

    try:
        subprocess.run(
            ["git", "worktree", "add", str(new_path), "-b", feature_slug],
            cwd=BASE_PROJECT, check=True, capture_output=True, text=True
        )

        git_file = new_path / ".git"
        if git_file.exists():
            content = git_file.read_text()
            if "gitdir: /app/" in content:
                relative_content = content.replace("gitdir: /app/", "gitdir: ../")
                git_file.write_text(relative_content)

        env_file = BASE_PROJECT / ".env"
        if env_file.exists():
            (new_path / ".env").write_text(env_file.read_text())

        fe_port, be_port, db_port = find_available_port_block()
        services_data = {
            "branch": feature_slug,
            "frontend": fe_port,
            "backend": be_port,
            "db": db_port
        }
        (new_path / "services.json").write_text(json.dumps(services_data))

        env = os.environ.copy()
        env.update({
            "BRANCH": feature_slug,
            "FRONTEND_PORT": str(fe_port),
            "BACKEND_PORT": str(be_port),
            "DB_PORT": str(db_port),
            "HOST_WORKTREE_PATH": str(new_path_host)
        })

        subprocess.run(
            [
                "docker", "compose",
                "-p", feature_slug,
                "-f", "docker-compose.feature.yml",
                "up", "-d"
            ],
            cwd=new_path, env=env, check=True, capture_output=True, text=True
        )

        return (f"✅ Environment initialized at {new_path}\n"
                f"Services: Frontend:{fe_port}, Backend:{be_port}, DB:{db_port}")

    except subprocess.CalledProcessError as e:
        return f"Initialization Failed: {e.stderr or e.stdout}"
    except Exception as e:
        return f"Unexpected Error: {str(e)}"

@mcp.tool()
def execute_lifecycle(feature_slug: str, action: str) -> str:
    """Executes a lifecycle action via the containers."""
    target_path = APP_ROOT / f"model_md-worktree-{feature_slug}"
    actions = {
        "initialize": [
            ["docker", "compose", "-p", feature_slug, "exec", "-T", "backend", "pnpm", "db:reset"],
            ["docker", "compose", "-p", feature_slug, "exec", "-T", "backend", "pnpm", "db:migrate"],
            ["docker", "compose", "-p", feature_slug, "exec", "-T", "backend", "pnpm", "db:seed"]
        ],
        "generate": [
            ["docker", "compose", "-p", feature_slug, "exec", "-T", "backend", "pnpm", "db:generate"],
        ],
        "migrate": [
            ["docker", "compose", "-p", feature_slug, "exec", "-T", "backend", "pnpm", "db:migrate"],
        ],
        "seed": [
            ["docker", "compose", "-p", feature_slug, "exec", "-T", "backend", "pnpm", "db:seed"],
        ],
        "verify": [
            ["docker", "compose", "-p", feature_slug, "exec", "-T", "backend", "pnpm", "test:db"],
            ["docker", "compose", "-p", feature_slug, "exec", "-T", "frontend", "pnpm", "build"]
        ],
        "build": [
            ["docker", "compose", "-p", feature_slug, "exec", "-T", "backend", "pnpm", "build"],
            ["docker", "compose", "-p", feature_slug, "exec", "-T", "frontend", "pnpm", "build"]
        ]
    }

    if action not in actions:
        return f"Error: Action '{action}' not recognized."

    results = []
    for cmd in actions[action]:
        try:
            res = subprocess.run(cmd, cwd=target_path, capture_output=True, text=True, check=True)
            results.append(res.stdout)
        except subprocess.CalledProcessError as e:
            return f"Action '{action}' failed at {' '.join(cmd)}: {e.stderr}"

    return "\n".join(results)

@mcp.tool()
def git_ops(feature_slug: str, command: str, args: list[str] = None) -> str:
    """Executes safe git commands within a worktree."""
    ALLOWED_COMMANDS = ["add", "commit", "status", "diff", "log", "branch"]
    if command not in ALLOWED_COMMANDS:
        return f"Error: Command '{command}' is not permitted."

    target_path = APP_ROOT / f"model_md-worktree-{feature_slug}"
    full_cmd = ["git", command] + (args if args else [])

    try:
        res = subprocess.run(full_cmd, cwd=target_path, capture_output=True, text=True, check=True)
        return res.stdout

    except subprocess.CalledProcessError as e:
        return f"Git Error: {e.stderr}"

@mcp.tool()
def get_environment_status(feature_slug: str) -> str:
    """Returns the status of all containers for a given feature."""
    res = subprocess.run(["docker", "compose", "-p", feature_slug, "ps"], capture_output=True, text=True)
    return res.stdout

@mcp.tool()
def stop_environment(feature_slug: str) -> str:
    """Tears down the docker-compose environment for a feature."""
    target_path = APP_ROOT / f"model_md-worktree-{feature_slug}"

    try:
        subprocess.run(["docker", "compose", "-p", feature_slug, "down", "-v"], 
                       cwd=target_path, check=True, capture_output=True)
        return f"Environment for {feature_slug} stopped and cleaned."
    except Exception as e:
        return f"Stop Error: {str(e)}"

@mcp.tool()
def list_features() -> str:
    """Lists all active feature worktrees."""
    worktrees = [p.name for p in APP_ROOT.glob("model_md-worktree-*")]
    return "\n".join(worktrees) if worktrees else "No active feature worktrees."

if __name__ == "__main__":
    mcp.run(transport='stdio')
