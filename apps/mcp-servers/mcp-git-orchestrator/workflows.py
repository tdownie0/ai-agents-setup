import os
import json
import re
import subprocess
import sys
from pathlib import Path
from dbos import DBOS, Queue

# Import our custom modules
from provider import release_ports, find_available_port_block
from engine import DockerComposeRunner, GitRunner

# --- Configuration ---
PROJECT_NAME = os.environ.get("PROJECT_NAME", "model_md")
APP_ROOT = Path("/app")
BASE_PROJECT = APP_ROOT / PROJECT_NAME
HOST_ROOT = Path(os.getenv("PROJECT_PARENT_PATH", "/home/user/project"))
TEST_USER_ID = os.getenv("TEST_USER_ID")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")
VITE_SUPABASE_URL = os.getenv("VITE_SUPABASE_URL")

orchestrator_queue = Queue("orchestrator_queue", worker_concurrency=1)

# Any of these key fragments marks an .env variable as a credential that must
# not be copied into feature worktrees (see _provision_git_worktree).
SECRET_ENV_RE = re.compile(
    r"(SERVICE_ROLE|API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|AUTH)",
    re.IGNORECASE,
)


def _is_secret_env_line(line: str) -> bool:
    """True when an .env line carries a credential-bearing key."""
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return False
    key = stripped.split("=", 1)[0].strip()
    return bool(SECRET_ENV_RE.search(key))


# --- Helpers ---
def _get_paths(feature_slug: str):
    """Utility to keep path logic consistent across all tools."""
    if not re.match(r"^[a-zA-Z0-9_-]+$", feature_slug):
        raise ValueError(f"Invalid feature_slug: '{feature_slug}'.")
    return {
        "worktree": APP_ROOT / "worktrees" / f"{PROJECT_NAME}-worktree-{feature_slug}",
        "host": HOST_ROOT / "worktrees" / f"{PROJECT_NAME}-worktree-{feature_slug}",
    }


@DBOS.step()
def _provision_git_worktree(new_path: Path, feature_slug: str):
    """Handles the physical creation and patching of the git worktree."""
    if new_path.exists() and any(new_path.iterdir()):
        sys.stderr.write(
            f"Worktree {new_path} already exists and is populated. Skipping.\n"
        )
        return

    # Worktrees live under APP_ROOT/worktrees (host: PROJECT_PARENT_PATH/
    # worktrees). The parent must exist before `git worktree add` can create
    # the leaf; inside the worker the bind target is /app/worktrees.
    new_path.parent.mkdir(parents=True, exist_ok=True)

    git = GitRunner(BASE_PROJECT)
    git.run_git("worktree", ["add", str(new_path), "-b", feature_slug])

    # Patch .git file for relative pathing across the host/container boundary.
    # Worktrees are now two levels below the mount root (worktrees/<name>),
    # so the gitdir resolves via "../../" back to <mount-root>/model_md/.git.
    git_file = new_path / ".git"
    if git_file.exists():
        content = git_file.read_text()
        git_file.write_text(content.replace("gitdir: /app/", "gitdir: ../../"))

    # Sync environment configuration WITHOUT credentials. The worktree .env
    # feeds the feature docker-compose (public URLs, ports, project identity);
    # secrets (gateway token, provider keys, service-role key) flow exclusively
    # via container env vars and must never land in feature worktrees.
    env_file = BASE_PROJECT / ".env"
    if env_file.exists():
        scrubbed = "\n".join(
            line
            for line in env_file.read_text().splitlines()
            if not _is_secret_env_line(line)
        )
        (new_path / ".env").write_text(scrubbed + "\n")


def _beads_database_name(feature_slug: str) -> str:
    """Server-mode database name for a feature worktree (MySQL-safe)."""
    safe = re.sub(r"[^A-Za-z0-9_]", "_", feature_slug)
    return f"{PROJECT_NAME}_worktree_{safe}"


@DBOS.step()
def _init_beads_for_worktree(new_path: Path, feature_slug: str):
    """Provision beads state for the worktree against the shared Dolt server.

    The dolt connection comes from the worker's BEADS_DOLT_* env (the `dolt`
    service in infra/docker-compose.yml); bd creates the database itself at
    open (CREATE DATABASE IF NOT EXISTS). --init-if-missing makes re-runs
    after partial failures a no-op.
    """
    database = _beads_database_name(feature_slug)
    cmd = [
        "bd",
        "init",
        "--server",
        "--external",
        "--database",
        database,
        "--non-interactive",
        "--role",
        "maintainer",
        "--skip-hooks",
        "--skip-agents",
        "--init-if-missing",
        "-q",
    ]
    # Force beads state into the worktree. bd resolves the repo root via git,
    # and from inside a worktree that resolves to the MAIN repo's common dir,
    # silently dropping .beads into BASE_PROJECT (observed 08:50 on the e2e
    # run and 09:29 on feat-test-beads). BEADS_DIR pins the state location so
    # placement no longer depends on git's toplevel resolution.
    env = os.environ.copy()
    env["BEADS_DIR"] = str(new_path / ".beads")
    try:
        result = subprocess.run(
            cmd,
            cwd=new_path,
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except FileNotFoundError:
        raise RuntimeError(
            "bd CLI missing from orchestrator image: rebuild with sudo task mcp:build-servers"
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"bd init timed out for {new_path}: is the dolt service up? (sudo task app:up)"
        )
    if result.returncode != 0:
        raise RuntimeError(
            f"bd init failed for {new_path} (db={database}):\n{result.stderr}"
        )
    # bd resolves the repo root via git; a mis-resolved toplevel would silently
    # drop .beads into BASE_PROJECT instead of the worktree (observed 08:50
    # on the e2e run). Verify placement explicitly before continuing.
    if not (new_path / ".beads").exists():
        raise RuntimeError(
            f"bd init wrote .beads outside the worktree (expected "
            f"{new_path / '.beads'}); git toplevel resolution is off - check "
            "the .git worktree patching"
        )
    # Fail loudly if the shared server is unreachable instead of letting the
    # first bd command fail later with a confusing error. Also triggers the
    # CREATE DATABASE IF NOT EXISTS on first open.
    try:
        ready = subprocess.run(
            ["bd", "ready"],
            cwd=new_path,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"bd ready timed out for {new_path}: is the dolt service up? (sudo task app:up)"
        )
    if ready.returncode != 0:
        raise RuntimeError(
            f"bd ready failed for {new_path} (db={database}):\n{ready.stderr}"
        )
    sys.stderr.write(f"Beads provisioned for {new_path} (db={database}).\n")


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
    DBOS.run_step(None, _init_beads_for_worktree, worktree_path, feature_slug)

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
