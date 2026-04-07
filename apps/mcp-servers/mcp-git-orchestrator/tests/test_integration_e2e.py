import asyncio
import json
import sys
import os
import subprocess
import time
from pathlib import Path
from dotenv import load_dotenv

# --- 1. Configuration & Environment ---
script_dir = Path(__file__).resolve().parent
project_root = script_dir.parent.parent.parent.parent
load_dotenv(project_root / ".env")

# Pathing: The orchestrator needs to know where the project lives on the HOST
WORKSPACE_ROOT = os.environ.get("PROJECT_PARENT_PATH")
if not WORKSPACE_ROOT:
    print("❌ Error: PROJECT_PARENT_PATH not set in .env")
    sys.exit(1)


REDIS_HOST = os.environ.get("REDIS_HOST", "model_md-cache-1")
CONTAINER_NAME = "git-orchestrator-e2e-test"
IMAGE_NAME = "git-orchestrator:latest"
FEATURE_SLUG = "e2e-canary"

# The command to spin up the "Brain" (The Orchestrator)
DOCKER_CMD = [
    "docker",
    "run",
    "-i",
    "--rm",
    "--name",
    CONTAINER_NAME,
    "--network",
    "model_md_dev-network",
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",  # Give it Docker powers
    "-v",
    f"{WORKSPACE_ROOT}:/app",  # Mount the source code
    "-e",
    "WORKSPACE_ROOT=/app",
    "-e",
    f"PROJECT_PARENT_PATH={WORKSPACE_ROOT}",
    "-e",
    f"REDIS_HOST={REDIS_HOST}",
    IMAGE_NAME,
    "python3",
    "main.py",
]


async def run_e2e_test():
    print(f"🚀 Starting Orchestrator Container: {CONTAINER_NAME}")

    # Start the orchestrator process
    proc = await asyncio.create_subprocess_exec(
        *DOCKER_CMD,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=sys.stderr,
    )

    async def call_mcp(method, params=None, msg_id=1):
        """Helper to send JSON-RPC over stdio"""
        req = {"jsonrpc": "2.0", "id": msg_id, "method": method}
        if params:
            req["params"] = params

        proc.stdin.write(json.dumps(req).encode() + b"\n")
        await proc.stdin.drain()

        line = await proc.stdout.readline()
        return json.loads(line.decode()) if line else None

    try:
        # --- PHASE 1: MCP Handshake ---
        print("🤝 Performing MCP Handshake...")
        await call_mcp(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "e2e-test-runner", "version": "1.0"},
            },
            1,
        )

        proc.stdin.write(
            json.dumps(
                {"jsonrpc": "2.0", "method": "notifications/initialized"}
            ).encode()
            + b"\n"
        )

        # --- PHASE 2: Create Worktree & Feature Env ---
        print(f"🛠️  Calling 'initialize_worktree' for: {FEATURE_SLUG}")
        start_time = time.perf_counter()

        resp = await call_mcp(
            "tools/call",
            {
                "name": "initialize_worktree",
                "arguments": {"feature_slug": FEATURE_SLUG},
            },
            2,
        )

        duration = time.perf_counter() - start_time

        if resp and "result" in resp:
            content = resp["result"]["content"][0]["text"]
            print(f"✅ Response ({duration:.2f}s):\n{content}")
        else:
            print(f"❌ Failed to initialize: {resp}")
            return

        # --- PHASE 3: Verify via Git ---
        print("🔍 Verifying Git Worktree existence...")
        # We run this on the HOST to see if the container actually did the work
        git_res = await call_mcp(
            "tools/call",
            {
                "name": "git_ops",
                "arguments": {"feature_slug": FEATURE_SLUG, "command": "status"},
            },
            3,
        )

        if git_res and "result" in git_res:
            git_output = git_res["result"]["content"][0]["text"]
            print(f"✅ Git Tool Output:\n{git_output}")

            # If 'git status' worked, we are officially in the worktree
            assert (
                "On branch" in git_output or "Not currently on any branch" in git_output
            )
        else:
            print(f"❌ Git Tool failed to see the worktree: {git_res}")
            raise AssertionError(
                "Orchestrator created worktree but git_ops cannot access it."
            )

        # --- PHASE 4: Verify via Docker ---
        print("🐳 Verifying Feature Containers...")
        check_docker = subprocess.run(
            [
                "docker",
                "ps",
                "--filter",
                f"name={FEATURE_SLUG}",
                "--format",
                "{{.Names}}",
            ],
            capture_output=True,
            text=True,
        )

        assert FEATURE_SLUG in check_docker.stdout, "Feature containers not found!"
        print(f"✅ Docker containers for {FEATURE_SLUG} are running.")

        # --- PHASE 5: Teardown ---
        print(f"🧹 Tearing down environment: {FEATURE_SLUG}")

        stop_resp = await call_mcp(
            "tools/call",
            {"name": "stop_environment", "arguments": {"feature_slug": FEATURE_SLUG}},
            3,
        )
        print(f"✅ Cleanup response: {stop_resp['result']['content'][0]['text']}")

    except Exception as e:
        print(f"💥 Test crashed: {e}")
    finally:
        print("🛑 Shutting down Orchestrator...")

        subprocess.run(
            ["docker", "stop", "-t", "2", CONTAINER_NAME], capture_output=True
        )
        if proc.returncode is None:
            proc.terminate()

            await proc.wait()
        print("🏁 E2E Test Complete.")


if __name__ == "__main__":
    try:
        asyncio.run(run_e2e_test())
    except KeyboardInterrupt:
        pass
