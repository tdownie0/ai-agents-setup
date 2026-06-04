import os
import json
import sys
from pathlib import Path
from dbos import DBOS, Queue

# Import our custom modules
from provider import release_ports, find_available_port_block
from engine import DockerComposeRunner, GitRunner

# --- Configuration ---
UID = os.getenv("USER_ID", "1000")
GID = os.getenv("GROUP_ID", "1000")
APP_ROOT = Path("/app")
BASE_PROJECT = APP_ROOT / "model_md"
HOST_ROOT = Path(os.getenv("PROJECT_PARENT_PATH", "/home/user/project"))
TEST_USER_ID = os.getenv("TEST_USER_ID")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")
VITE_SUPABASE_URL = os.getenv("VITE_SUPABASE_URL")

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
            "SUPABASE_URL": str(SUPABASE_URL),
            "SUPABASE_ANON_KEY": str(SUPABASE_ANON_KEY),
            "VITE_SUPABASE_URL": str(VITE_SUPABASE_URL),
            "TEST_USER_ID": str(TEST_USER_ID),
        }
    )

    composer = DockerComposeRunner(feature_slug, worktree_path, env_vars)
    result = composer.up()

    print(f"🐳 Docker Up STDOUT: {result.stdout}")
    if result.stderr:
        print(f"⚠️ Docker Up STDERR: {result.stderr}")

    return True


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

    return f"✅ Environment initialized or recovered at {worktree_path}"


@DBOS.workflow()
def run_lifecycle_workflow(feature_slug: str, action: str) -> str:
    paths = _get_paths(feature_slug)
    env_vars = os.environ.copy()
    env_vars.update(
        {
            "BRANCH": feature_slug,
            "HOST_WORKTREE_PATH": str(paths["host"]),
            "DATABASE_URL": "postgres://postgres:password@db:5432/postgres",
            "SUPABASE_URL": str(SUPABASE_URL),
            "SUPABASE_ANON_KEY": str(SUPABASE_ANON_KEY),
            "VITE_SUPABASE_URL": str(VITE_SUPABASE_URL),
            "TEST_USER_ID": str(TEST_USER_ID),
        }
    )
    composer = DockerComposeRunner(feature_slug, paths["worktree"], env_vars)

    action_map = {
        "install": [
            ("backend", ["install", "--no-frozen-lockfile"]),
            ("frontend", ["install", "--no-frozen-lockfile"]),
        ],
        "initialize": [
            ("backend", ["--filter", "@model_md/database", "build"]),
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
        "build": [("backend", ["back:build"]), ("frontend", ["front:build"])],
    }

    if action not in action_map:
        return f"Error: Action '{action}' unknown."

    results = []
    try:
        for service, args in action_map[action]:
            res = composer.exec_pnpm(service, args)
            results.append(f"Success ({service} pnpm {' '.join(args)}):\n{res.stdout}")

        if action == "install":
            composer.exec_pnpm("backend", ["--filter", "@model_md/database", "build"])
            res = composer.restart(["backend", "frontend"])

        return "\n---\n".join(results)
    except Exception as e:
        return f"❌ Action '{action}' failed: {str(e)}"


@DBOS.workflow()
def run_stop_workflow(feature_slug: str):
    paths = _get_paths(feature_slug)
    target_path = paths["worktree"]
    host_path = paths["host"]
    services_file = target_path / "services.json"

    env_vars = os.environ.copy()

    if services_file.exists():
        try:
            data = json.loads(services_file.read_text())
            env_vars.update(
                {
                    "FRONTEND_PORT": str(data["frontend"]),
                    "BACKEND_PORT": str(data["backend"]),
                    "DB_PORT": str(data["db"]),
                }
            )
            release_ports([data["frontend"], data["backend"], data["db"]])
        except Exception as e:
            print(f"Warning: Port recovery failed: {e}", file=sys.stderr)

    env_vars.update({"BRANCH": feature_slug, "HOST_WORKTREE_PATH": str(host_path)})

    try:
        composer = DockerComposeRunner(feature_slug, target_path, env_vars)
        result = composer.down()

        if result.returncode != 0:
            raise RuntimeError(f"Docker Compose failed: {result.stderr}")

        return f"✅ Environment for {feature_slug} stopped and cleaned."
    except Exception as e:
        raise RuntimeError(f"Workflow Failure for {feature_slug}: {str(e)}")
