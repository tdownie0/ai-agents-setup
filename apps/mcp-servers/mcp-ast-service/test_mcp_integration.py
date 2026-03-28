import asyncio
import json
import sys
import argparse
import subprocess
import os
import time
from pathlib import Path
from dotenv import load_dotenv

script_dir = Path(__file__).resolve().parent
project_root = script_dir.parent.parent.parent
env_path = project_root / ".env"

if env_path.exists():
    load_dotenv(dotenv_path=env_path)
    print(f"✅ Loaded environment from: {env_path}")
else:
    print(f"⚠️ Warning: No .env found at {env_path}. Using shell variables.")

workspace_root = os.environ.get("PROJECT_PARENT_PATH")

if not workspace_root:
    print("❌ Error: PARENT_PROJECT_PATH environment variable is not set.")
    sys.exit(1)

# Ensure the path is absolute for Docker
workspace_root = os.path.abspath(os.path.expanduser(workspace_root))
workspace_volume = f"{workspace_root}:/app"

CONTAINER_NAME = "ast-mcp-test"
DOCKER_CMD = [
    "docker",
    "run",
    "-i",
    "--rm",
    "--name",
    CONTAINER_NAME,
    "--network",
    "model_md_dev-network",
    "-e",
    "DOCKER_MCP_TRANSPORT=stdio",
    "-e",
    "WORKSPACE_ROOT=/app",
    "-e",
    "REDIS_HOST=cache",
    "-v",
    workspace_volume,
    "ast-explorer:latest",
    "python3",
    "main.py",
]


def prepare_test_env():
    CACHE_CONTAINER = "model_md-cache-1"

    check_running = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", CACHE_CONTAINER],
        capture_output=True,
        text=True,
    )

    if check_running.returncode != 0 or "true" not in check_running.stdout:
        print("⚠️  Warning: 'cache' container not running. Skipping cache reset.")
        return

    print("Cleaning Redis cache for cold test...")
    # Execute a command in the existing 'cache' container to clear AST keys
    for pattern in ["ast:*", "hash:*"]:
        subprocess.run(
            [
                "docker",
                "exec",
                CACHE_CONTAINER,
                "redis-cli",
                "eval",
                f"for _,k in ipairs(redis.call('keys','{pattern}')) do redis.call('del',k) end",
                "0",
            ],
            capture_output=True,
        )


async def run_scenario(
    force_clear: bool = False, no_write: bool = False, target_path: str = "model_md"
):
    if force_clear:
        print("🧼 Force clear requested...")
        prepare_test_env()
    else:
        print("⏩ Skipping cache clear (Warm Start)...")

    print(f"🚀 Launching Named Container: {CONTAINER_NAME}")
    proc = await asyncio.create_subprocess_exec(
        *DOCKER_CMD,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=sys.stderr,
    )

    async def call(method, params=None, msg_id=1):
        req = {"jsonrpc": "2.0", "id": msg_id, "method": method}
        if params:
            req["params"] = params
        proc.stdin.write(json.dumps(req).encode() + b"\n")
        await proc.stdin.drain()

        line = await proc.stdout.readline()
        return json.loads(line.decode()) if line else None

    try:
        # 1. Handshake
        await call(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            },
            1,
        )
        proc.stdin.write(
            json.dumps(
                {"jsonrpc": "2.0", "method": "notifications/initialized"}
            ).encode()
            + b"\n"
        )

        # 2. Index the repo
        print(f"📦 Indexing path: {target_path}...")

        start_time = time.perf_counter()

        repo_response = await call(
            "tools/call",
            {"name": "get_repo_map", "arguments": {"path": target_path}},
            msg_id=2,
        )

        end_time = time.perf_counter()
        duration = end_time - start_time

        # Extract the text from the MCP content block
        if repo_response and "result" in repo_response:
            full_map_text = repo_response["result"]["content"][0]["text"]

            if not no_write:
                with open("repo_map_debug.txt", "w") as f:
                    f.write(full_map_text)

                print("💾 Full map saved to repo_map_debug.txt")
            else:
                print("🚫 --no-write active: Skipping disk I/O.")
            print(f"⏱️  Indexing completed in: {duration:.4f} seconds")
        else:
            print(f"❌ Indexing failed (after {duration:.4f}s): {repo_response}")

        # 3. Test find_symbol (Looking for the 'users' table definition)
        print("🔍 Testing 'find_symbol' for 'pgTable'...")
        sym = await call(
            "tools/call",
            {"name": "find_symbol", "arguments": {"symbol_name": "pgTable"}},
            3,
        )
        print(f"📍 SYMBOL RESULT:\n{sym['result']['content'][0]['text']}\n")

        # 4. Test get_dependents (Testing who imports users.ts)
        # Note: We check 'users.ts' because seed.test.ts imports it!

        print("🔗 Testing 'get_dependents' for 'users.ts'...")
        dep = await call(
            "tools/call",
            {"name": "get_dependents", "arguments": {"file_path": "users.ts"}},
            4,
        )
        print(f"🔗 DEPENDENTS RESULT:\n{dep['result']['content'][0]['text']}\n")

    finally:
        print(f"🛑 Killing container {CONTAINER_NAME}...")
        # Force shutdown from the host to ensure --rm triggers

        subprocess.run(
            ["docker", "stop", "-t", "1", CONTAINER_NAME], capture_output=True
        )
        proc.terminate()
        await proc.wait()
        print("✅ Clean exit.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MCP AST Service Integration Test")

    # Adding --clear or -c flag. 'store_true' means it defaults to False
    # unless the flag is present.
    parser.add_argument(
        "--clear",
        "-c",
        action="store_true",
        help="Force a Redis cache clear before running tests",
    )

    parser.add_argument(
        "--no-write",
        "-n",
        action="store_true",
        help="Skip writing the repo map result to a local text file",
    )

    parser.add_argument(
        "--path",
        "-p",
        type=str,
        default="model_md",
        help="The directory path to scan (defaults to 'model_md')",
    )

    args = parser.parse_args()

    try:
        asyncio.run(
            run_scenario(
                force_clear=args.clear, no_write=args.no_write, target_path=args.path
            )
        )
    except KeyboardInterrupt:
        print("\n✅ Stopped by user.")
        sys.exit(0)
