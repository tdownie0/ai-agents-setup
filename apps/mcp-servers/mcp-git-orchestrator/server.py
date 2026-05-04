import os
import json
import psycopg2
from psycopg2.extras import RealDictCursor
from pathlib import Path
from mcp.server.fastmcp import FastMCP
from dbos import DBOSClient, EnqueueOptions

from engine import DockerComposeRunner, GitRunner, LokiClient

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


@mcp.tool()
def get_environment_logs(
    feature_slug: str, service: str | None = None, tail: int = 50
) -> str:
    """
    Retrieves logs from Loki for a specific feature.
    If 'service' is provided, it narrows the search to that specific container.
    """
    loki = LokiClient()

    query_target = f"{feature_slug}.*{service}" if service else feature_slug
    recent_logs = loki.get_service_logs(service_name=query_target, tail=tail)

    return f"### Recent Logs for {query_target} (Loki)\n{recent_logs}"


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
    """
    Returns recent telemetry (Loki) for all containers associated with a feature.
    """

    loki = LokiClient()
    recent_activity = loki.get_service_logs(service_name=feature_slug, tail=20)

    return f"### Recent Environment Activity for {feature_slug}\n{recent_activity}"


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


@mcp.tool()
def list_features() -> str:
    """Lists all active feature worktrees."""
    worktrees = [p.name for p in APP_ROOT.glob("model_md-worktree-*")]
    return "\n".join(worktrees) if worktrees else "No active feature worktrees."
