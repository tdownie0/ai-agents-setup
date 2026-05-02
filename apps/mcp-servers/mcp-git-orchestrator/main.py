import os
import argparse
import json
import sys
import shutil
import signal
import psycopg2
from psycopg2.extras import RealDictCursor
from pathlib import Path
from mcp.server.fastmcp import FastMCP
from dbos import DBOS, DBOSConfig, Queue, DBOSClient, EnqueueOptions

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
orchestrator_queue = Queue("orchestrator_queue", worker_concurrency=1)


# --- Helpers ---
def _get_paths(feature_slug: str):
    """Utility to keep path logic consistent across all tools."""
    return {
        "worktree": APP_ROOT / f"model_md-worktree-{feature_slug}",
        "host": HOST_ROOT / f"model_md-worktree-{feature_slug}",
    }


@DBOS.step()
def _provision_git_worktree(new_path: Path, feature_slug: str):
    """Handles the physical creation and patching of the git worktree."""
    if new_path.exists() and any(new_path.iterdir()):
        sys.stderr.write(
            f"Worktree {new_path} already exists and is populated. Skipping.\n"
        )
        return

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


@DBOS.step()
def _get_or_assign_ports(
    worktree_path: Path, feature_slug: str
) -> tuple[int, int, int]:
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


@DBOS.step()
def _bootstrap_agent_env(worktree_path: Path):
    """Executes the stealth 'beads' initialization for the AI agent."""
    if (worktree_path / ".tmp_bin").exists():
        sys.stderr.write("Agent environment already bootstrapped. Skipping.\n")
        return

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


@DBOS.step()
def _docker_up_step(
    feature_slug: str, worktree_path: Path, fe: int, be: int, db: int, host_path: Path
):
    """Internal step to execute Docker Compose."""
    print(f"DEBUG: Internal Path: {worktree_path}", file=sys.stderr)
    print(f"DEBUG: Host Path: {host_path}", file=sys.stderr)
    env_vars = os.environ.copy()
    env_vars.update(
        {
            "BRANCH": feature_slug,
            "FRONTEND_PORT": str(fe),
            "BACKEND_PORT": str(be),
            "DB_PORT": str(db),
            "HOST_WORKTREE_PATH": str(host_path),
            "DATABASE_URL": "postgres://postgres:password@db:5432/postgres",
        }
    )

    composer = DockerComposeRunner(feature_slug, worktree_path, env_vars)
    result = composer.up()

    print(f"🐳 Docker Up STDOUT: {result.stdout}")
    if result.stderr:
        print(f"⚠️ Docker Up STDERR: {result.stderr}")

    return True


@mcp.tool()
async def get_job_status(job_id: str) -> str:
    """
    Checks the current progress of a background environment initialization or
    lifecycle task.

    Use this tool to poll for completion after calling 'initialize_worktree'.

    Interpret the Response:
        - PENDING/RUNNING: The environment is still being built. You must wait
          and poll again. Check 'retry_after_seconds' for a suggested wait time.
        - SUCCESS: The environment is live. You may now proceed to use
          'execute_lifecycle', 'git_ops', or 'get_environment_status'.
        - FAILURE: The setup failed. Read the 'message' or 'suggestion'
          field to troubleshoot.

    Args:
        job_id: The unique identifier returned by the initialization tool.
    """
    db_url = os.environ.get("DBOS_SYSTEM_DATABASE_URL")

    try:
        # Use a context manager to ensure the connection closes
        with psycopg2.connect(db_url) as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    "SELECT status, output FROM dbos.workflow_status WHERE workflow_uuid = %s",
                    (job_id,),
                )
                row = cur.fetchone()

        if not row:
            return json.dumps({"status": "NOT_FOUND", "job_id": job_id})

        status = row["status"]
        return json.dumps(
            {
                "job_id": job_id,
                "status": status,
                "details": row["output"] if status == "SUCCESS" else None,
            }
        )

    except Exception as e:
        return json.dumps(
            {"status": "ERROR", "message": f"Direct DB Read Failed: {str(e)}"}
        )


@mcp.tool()
def initialize_worktree(feature_slug: str) -> str:
    """
    Starts a durable, asynchronous background process to create a git worktree
    and spin up Docker containers for a specific feature.

    This is the first step in starting work on any new feature. Because
    environment setup (Docker build/up) can take 1-3 minutes, this tool
    returns a job_id immediately.

    Workflow:
        1. Call this tool to start the setup.
        2. Capture the 'job_id' from the response.
        3. Poll 'get_job_status' every 30 seconds using that job_id.
        4. DO NOT attempt to use 'execute_lifecycle' or 'git_ops' until
           'get_job_status' returns 'SUCCESS'.

    Args:
        feature_slug: The unique identifier for the feature (e.g., 'feat-ui-update').
    """
    client = DBOSClient(system_database_url=os.environ["DBOS_SYSTEM_DATABASE_URL"])

    options: EnqueueOptions = {
        "queue_name": "orchestrator_queue",
        "workflow_name": "run_initialize_workflow",
    }

    handle = client.enqueue(options, feature_slug)

    return json.dumps(
        {
            "status": "QUEUED",
            "job_id": handle.workflow_id,
            "msg": "Job sent to persistent worker queue.",
        }
    )


@DBOS.workflow()
def run_initialize_workflow(feature_slug: str) -> str:
    """
    The durable background workflow. DBOS checkpoints progress in Supabase
    after every 'run_step'.
    """
    paths = _get_paths(feature_slug)
    worktree_path = paths["worktree"]

    if not BASE_PROJECT.exists():
        raise Exception(f"Base project directory {BASE_PROJECT} not found.")

    DBOS.run_step(None, _provision_git_worktree, worktree_path, feature_slug)

    fe, be, db = DBOS.run_step(None, _get_or_assign_ports, worktree_path, feature_slug)

    DBOS.run_step(
        None, _docker_up_step, feature_slug, worktree_path, fe, be, db, paths["host"]
    )

    DBOS.run_step(None, _bootstrap_agent_env, worktree_path)

    return f"✅ Environment initialized or recovered at {worktree_path}"


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
    client = DBOSClient(system_database_url=os.environ["DBOS_SYSTEM_DATABASE_URL"])
    handle = client.enqueue(
        {
            "queue_name": "orchestrator_queue",
            "workflow_name": "run_lifecycle_workflow",
        },
        feature_slug,
        action,
    )

    return json.dumps({"status": "QUEUED", "job_id": handle.workflow_id})


@DBOS.workflow()
def run_lifecycle_workflow(feature_slug: str, action: str) -> str:
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
    """
    Enqueues a background job to tear down the feature environment.
    """
    client = DBOSClient(system_database_url=os.environ["DBOS_SYSTEM_DATABASE_URL"])

    options: EnqueueOptions = {
        "queue_name": "orchestrator_queue",
        "workflow_name": "run_stop_workflow",
    }

    handle = client.enqueue(options, feature_slug)

    return json.dumps(
        {
            "status": "QUEUED",
            "job_id": handle.workflow_id,
            "msg": f"Teardown for {feature_slug} sent to worker queue.",
        }
    )


@DBOS.workflow()
def run_stop_workflow(feature_slug: str):
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--worker", action="store_true", help="Run as a persistent DBOS worker"
    )
    args = parser.parse_args()

    if args.worker:
        dbos_config: DBOSConfig = {
            "name": "mcp-git-orchestrator",
            "system_database_url": os.environ.get("DBOS_SYSTEM_DATABASE_URL"),
        }
        DBOS(config=dbos_config)
        DBOS.listen_queues([orchestrator_queue])
        DBOS.launch()
        print("🚀 Worker listening on 'orchestrator_queue'...")

        try:
            while True:
                signal.pause()

        except (KeyboardInterrupt, SystemExit):
            DBOS.destroy()

    else:
        mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
