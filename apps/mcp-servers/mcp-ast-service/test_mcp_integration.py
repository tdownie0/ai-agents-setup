import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

script_dir = Path(__file__).resolve().parent
project_root = script_dir.parent.parent.parent
env_path = project_root / ".env"


def load_env_file(path: Path) -> bool:
    """Fallback .env parser (used when python-dotenv is missing on the host).
    Never overwrites variables already set in the shell; expands ${VAR}."""
    if not path.exists():
        return False
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        resolved = value
        for _ in range(10):  # bounded expansion of nested ${VAR} references
            expanded = re.sub(
                r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}",
                lambda m: os.environ.get(m.group(1), ""),
                resolved,
            )
            if expanded == resolved:
                break
            resolved = expanded
        os.environ.setdefault(key, resolved)
    return True


try:
    from dotenv import load_dotenv

    if env_path.exists():
        load_dotenv(dotenv_path=env_path)
        print(f"✅ Loaded environment from: {env_path} (python-dotenv)")
    else:
        print(f"⚠️ Warning: No .env found at {env_path}. Using shell variables.")
except ImportError:
    if load_env_file(env_path):
        print(f"✅ Loaded environment from: {env_path} (fallback parser)")
    else:
        print(f"⚠️ Warning: No .env found at {env_path}. Using shell variables.")

MCP_GATEWAY_AUTH_TOKEN = os.environ.get("MCP_GATEWAY_AUTH_TOKEN")
if not MCP_GATEWAY_AUTH_TOKEN:
    print("❌ Error: MCP_GATEWAY_AUTH_TOKEN not set in .env")
    sys.exit(1)

# The mcp-gateway (docker-compose service) publishes 8811 on 127.0.0.1 and
# spawns the ast-explorer server container on demand — no test container is
# created here. The stack (agent-core profile) must be up.
MCP_URL = os.environ.get("MCP_GATEWAY_ENDPOINT", "http://localhost:8811/mcp")
MCP_TIMEOUT = int(os.environ.get("MCP_TIMEOUT", "300"))

# Only used by the optional '--clear' cache reset, which talks to the cache
# container the stack already runs. Not required for the test flow itself.
WORKSPACE_ROOT = os.environ.get("PROJECT_PARENT_PATH")
if not WORKSPACE_ROOT:
    print(
        "⚠️  Warning: PROJECT_PARENT_PATH not set in .env. "
        "--clear will be unavailable (docker-based cache reset)."
    )


session_id = None


def post(payload: dict) -> str:
    global session_id
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {MCP_GATEWAY_AUTH_TOKEN}",
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    req = urllib.request.Request(
        MCP_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=MCP_TIMEOUT) as response:
        if "Mcp-Session-Id" in response.headers:
            session_id = response.headers["Mcp-Session-Id"]
        return response.read().decode("utf-8")


def reinitialize(payload: dict) -> str:
    """Establish a fresh session (gateway restart invalidates old ones)."""
    global session_id
    session_id = None
    init = {
        "jsonrpc": "2.0",
        "id": "session-init",
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "ast-mcp-integration-test", "version": "2.0.0"},
        },
    }
    post(init)
    post({"jsonrpc": "2.0", "method": "notifications/initialized"})
    return post(payload)


def prepare_test_env():
    """Best-effort Redis cache reset against the stack's running cache
    container. Requires docker CLI access on the host (the README keeps the
    user out of the docker group, so this typically needs a docker-aware
    shell). Failure is non-fatal: the test still runs, just warm."""
    if not WORKSPACE_ROOT:
        print("⚠️  Skipping cache reset (PROJECT_PARENT_PATH not set).")
        return

    candidates = ["model_md-cache-1", "cache"]
    cache_container = None
    for name in candidates:
        check_running = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", name],
            capture_output=True,
            text=True,
        )
        if check_running.returncode == 0 and "true" in check_running.stdout:
            cache_container = name
            break

    if cache_container is None:
        print(
            "⚠️  Warning: running 'cache' container not found (or docker is not "
            "accessible). Skipping cache reset — test will run warm."
        )
        return

    print(f"🧹 Cleaning Redis cache in '{cache_container}' for cold test...")
    # Clear AST keys only (ast:* and hash:*) so the stack stays intact.
    for pattern in ["ast:*", "hash:*"]:
        result = subprocess.run(
            [
                "docker",
                "exec",
                cache_container,
                "redis-cli",
                "eval",
                f"for _,k in ipairs(redis.call('keys','{pattern}')) do redis.call('del',k) end",
                "0",
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            print(f"⚠️  Failed to clear '{pattern}': {result.stderr.strip()}")


async def run_scenario(
    force_clear: bool = False, no_write: bool = False, target_path: str = "model_md"
):
    if force_clear:
        print("🧼 Force clear requested...")
        prepare_test_env()
    else:
        print("⏩ Skipping cache clear (Warm Start)...")

    print(f"🚀 Connecting to MCP Gateway: {MCP_URL}")

    async def call_mcp(method, params=None, msg_id=1):
        """Send JSON-RPC over the gateway and return the id-matched response
        after stripping SSE framing and log noise."""
        req = {"jsonrpc": "2.0", "id": msg_id, "method": method}
        if params:
            req["params"] = params

        try:
            response = post(req)
        except urllib.error.HTTPError as e:
            if e.code == 404 and session_id:
                print("♻️  Session expired; re-initializing...")
                try:
                    response = reinitialize(req)
                except Exception as retry_err:
                    print(f"⚠️  Retry Error: {str(retry_err)}")
                    return None
            else:
                print(f"⚠️  HTTP Error: {e.code}: {e.reason}")
                return None
        except Exception as e:
            print(f"⚠️  Request Error: {str(e)}")
            return None

        if not response or not response.strip():
            return None

        for line in response.splitlines():
            decoded = line.strip()
            if not decoded:
                continue

            # Streamable transport: responses arrive as SSE. The JSON-RPC
            # envelope is the `data:` payload; strip the framing (`event:`
            # lines are pure noise).
            if decoded.startswith("data:"):
                decoded = decoded[len("data:") :].strip()
            elif decoded.startswith("event:"):
                continue

            if not decoded.startswith("{"):
                print(f"🖥️  LOG: {decoded}")
                continue

            try:
                data = json.loads(decoded)
                if isinstance(data, dict) and data.get("id") == msg_id:
                    return data
            except json.JSONDecodeError:
                print(f"⚠️  Junk ignored: {decoded[:50]}...")
                continue

        return None

    try:
        # 1. Handshake
        print("🤝 Performing MCP Handshake...")
        await call_mcp(
            "initialize",
            {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "ast-mcp-integration-test", "version": "2.0.0"},
            },
            1,
        )
        post({"jsonrpc": "2.0", "method": "notifications/initialized"})

        # 2. Index the repo
        print(f"📦 Indexing path: {target_path}...")

        start_time = time.perf_counter()

        repo_response = await call_mcp(
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
        sym = await call_mcp(
            "tools/call",
            {"name": "find_symbol", "arguments": {"symbol_name": "pgTable"}},
            3,
        )
        if sym and "result" in sym:
            print(f"📍 SYMBOL RESULT:\n{sym['result']['content'][0]['text']}\n")
        else:
            print(f"❌ find_symbol failed: {sym}")

        # 4. Test get_dependents (Testing who imports users.ts)
        # Note: We check 'users.ts' because seed.test.ts imports it!
        print("🔗 Testing 'get_dependents' for 'users.ts'...")
        dep = await call_mcp(
            "tools/call",
            {"name": "get_dependents", "arguments": {"file_path": "users.ts"}},
            4,
        )
        if dep and "result" in dep:
            print(f"🔗 DEPENDENTS RESULT:\n{dep['result']['content'][0]['text']}\n")
        else:
            print(f"❌ get_dependents failed: {dep}")

        # 5. Test scan_specific_file (Warm Start - should be Cached)
        test_file = f"{target_path}/packages/database/src/schema/users.ts"
        print(f"🎯 Testing 'scan_specific_file' (Warm) for: {test_file}")

        warm_res = await call_mcp(
            "tools/call",
            {"name": "scan_specific_file", "arguments": {"file_path": test_file}},
            5,
        )

        if warm_res and "result" in warm_res:
            warm_text = warm_res["result"]["content"][0]["text"]
            print(f"📄 WARM RESULT: {warm_text[:100]}...")

            if "(Cached)" in warm_text:
                print("✅ Success: Cache hit detected.")
            else:
                print("⚠️  Warning: Expected cache hit but got fresh scan.")
        else:
            print(f"❌ scan_specific_file failed: {warm_res}")

    finally:
        print("✅ Test complete. Gateway-managed server left to the stack.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="MCP AST Service Integration Test (local, via mcp-gateway)"
    )

    parser.add_argument(
        "--clear",
        "-c",
        action="store_true",
        help="Force a Redis cache clear before running tests (requires docker access)",
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

