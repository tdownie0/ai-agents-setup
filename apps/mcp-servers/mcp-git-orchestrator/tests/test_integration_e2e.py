import asyncio
import json
import os
import sys
import time
import urllib.error
import urllib.request
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

DBOS_DATABASE = os.environ.get("DATABASE_URL")
if not DBOS_DATABASE:
    print("❌ Error: DATABASE_URL not set in .env")
    sys.exit(1)

MCP_GATEWAY_AUTH_TOKEN = os.environ.get("MCP_GATEWAY_AUTH_TOKEN")
if not MCP_GATEWAY_AUTH_TOKEN:
    print("❌ Error: MCP_GATEWAY_AUTH_TOKEN not set in .env")
    sys.exit(1)

REDIS_HOST = os.environ.get("REDIS_HOST", "model_md-cache-1")
CONTAINER_NAME = "git-orchestrator-e2e-test"
IMAGE_NAME = "git-orchestrator:latest"
FEATURE_SLUG = "e2e-canary"

# The mcp-gateway owns the git-orchestrator server lifecycle; this test only
# talks to the already-running gateway over streamable HTTP (mirrors
# infra/mcp_bridge.py). No container is spawned here.
MCP_URL = os.environ.get("MCP_GATEWAY_ENDPOINT", "http://localhost:8811/mcp")
session_id = None


def post(payload: dict) -> str:
    global session_id
    headers = {
        "Content-Type": "application/json",
        # Streamable HTTP: response may arrive as SSE events, so the client
        # must advertise text/event-stream too (gateway 400s otherwise: "Accept
        # must contain both 'application/json' and 'text/event-stream'").
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
    with urllib.request.urlopen(req) as response:
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
            "clientInfo": {"name": "mcp-bridge", "version": "2.0.0"},
        },
    }
    post(init)
    post({"jsonrpc": "2.0", "method": "notifications/initialized"})
    return post(payload)


async def run_e2e_test():
    # Worker owns the socket; host user is NOT in docker group per AGENTS.md.
    print(f"🚀 Connecting to Orchestrator Stack: {CONTAINER_NAME}")

    async def call_mcp(method, params=None, msg_id=1):
        """Helper to send JSON-RPC and filter out log noise."""

        req = {"jsonrpc": "2.0", "id": msg_id, "method": method}
        if params:
            req["params"] = params

        try:
            response = post(req)
        except urllib.error.HTTPError as e:
            if e.code == 404 and session_id:
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
            # envelope is the `data:` payload; strip the framing so the
            # id-matching below can see it (`event:` lines are pure noise).
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
        # --- PHASE 1: MCP Handshake ---
        print("🤝 Performing MCP Handshake...")
        await call_mcp(
            "initialize",
            {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "e2e-test-runner", "version": "1.0"},
            },
            1,
        )

        post({"jsonrpc": "2.0", "method": "notifications/initialized"})

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
            content_text = resp["result"]["content"][0]["text"]
            # Parse the background job info
            job_info = json.loads(content_text)
            job_id = job_info.get("job_id")
            print(f"✅ Job {job_id} queued. Entering polling loop...")
        else:
            print(f"❌ Failed to initialize: {resp}")
            return

        is_ready = False
        for i in range(18):
            await asyncio.sleep(10)

            status_resp = await call_mcp(
                "tools/call",
                {
                    "name": "get_job_status",
                    "arguments": {"job_id": job_id},
                },
                msg_id=100 + i,
            )

            if not status_resp or "result" not in status_resp:
                print(f"⚠️  Unexpected MCP response: {status_resp}")
                continue

            content_text = status_resp["result"]["content"][0]["text"]

            try:
                status_data = json.loads(content_text)
                current_status = status_data.get("status")
                print(f"⏳ [{i + 1}/30] Status: {current_status}")

                if current_status == "SUCCESS":
                    is_ready = True
                    break
                elif current_status == "FAILURE":
                    error_msg = status_data.get("error", "Unknown DBOS Error")
                    raise Exception(f"Background initialization failed: {error_msg}")
            except json.JSONDecodeError:
                print(f"🖥️  Server (non-JSON): {content_text}")
                if "✅" in content_text or "SUCCESS" in content_text:
                    is_ready = True
                    break
        if not is_ready:
            raise TimeoutError(
                f"❌ Environment {FEATURE_SLUG} took too long to initialize (180s+)."
            )

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

        # --- PHASE 4: Verify via the Running Stack (Worker-side Docker) ---
        print("🐳 Verifying Feature Containers (via get_environment_status)...")
        status_res = await call_mcp(
            "tools/call",
            {
                "name": "get_environment_status",
                "arguments": {"feature_slug": FEATURE_SLUG},
            },
            4,
        )

        if status_res and "result" in status_res:
            status_text = status_res["result"]["content"][0]["text"]
            print(f"✅ Feature Environment Status:\n{status_text}")

            assert "Recent Environment Activity" in status_text
            assert "No logs found" not in status_text
        else:
            print(f"❌ Status check failed: {status_res}")
            raise AssertionError(
                "get_environment_status failed to confirm feature containers."
            )

        # --- PHASE 5: Verify Telemetry via Loki ---
        print("📊 Verifying Telemetry (Loki) via MCP...")
        log_output = ""
        for attempt in range(10):
            log_res = await call_mcp(
                "tools/call",
                {
                    "name": "get_environment_logs",
                    "arguments": {
                        "feature_slug": FEATURE_SLUG,
                        "service": "backend",
                        "tail": 10,
                    },
                },
                450 + attempt,
            )

            if log_res and "result" in log_res:
                log_output = log_res["result"]["content"][0]["text"]
                if "No logs found" not in log_output:
                    print(f"✅ Loki Log Output Snippet:\n{log_output[:200]}...")
                    break

            print(
                f"⏳ Attempt {attempt + 1}/10: Logs not indexed yet, retrying in 4s..."
            )
            await asyncio.sleep(4)
        else:
            print(
                f"❌ Loki telemetry check failed after 5 attempts. Final output: {log_output}"
            )
            raise AssertionError("Telemetry pipeline timeout: Logs never reached Loki.")

        # --- PHASE 6: Check get_environment_status ---
        print("🌍 Verifying Global Environment Status via Loki...")
        status_res = await call_mcp(
            "tools/call",
            {
                "name": "get_environment_status",
                "arguments": {"feature_slug": FEATURE_SLUG},
            },
            500,
        )

        if status_res and "result" in status_res:
            status_text = status_res["result"]["content"][0]["text"]
            print(f"✅ Global Status Output:\n{status_text}")

            assert "Recent Environment Activity" in status_text
            assert "No logs found" not in status_text

        # --- PHASE 7: Teardown ---
        print(f"🧹 Tearing down environment: {FEATURE_SLUG}")

        stop_resp = await call_mcp(
            "tools/call",
            {"name": "stop_environment", "arguments": {"feature_slug": FEATURE_SLUG}},
            msg_id=999,
        )

        if stop_resp and "result" in stop_resp:
            content_text = stop_resp["result"]["content"][0]["text"]

            # We use a helper-style approach to skip any log noise
            try:
                # Find the first '{' to avoid log prefixes
                json_payload = (
                    content_text[content_text.find("{") :]
                    if "{" in content_text
                    else content_text
                )
                stop_job_info = json.loads(json_payload)
                stop_job_id = stop_job_info.get("job_id")
                print(f"✅ Stop Job {stop_job_id} queued. Waiting for cleanup...")
            except (json.JSONDecodeError, ValueError) as e:
                print(
                    f"❌ Failed to parse stop response JSON. Raw text: {content_text}"
                )
                return

        else:
            print(f"❌ Failed to initiate teardown: {stop_resp}")
            return

        is_cleaned = False
        for i in range(15):
            await asyncio.sleep(5)
            status_resp = await call_mcp(
                "tools/call",
                {
                    "name": "get_job_status",
                    "arguments": {"job_id": stop_job_id},
                },
                msg_id=1000 + i,
            )

            if status_resp and "result" in status_resp:
                status_text = status_resp["result"]["content"][0]["text"]

                try:
                    # Again, skip any log noise before parsing
                    json_payload = (
                        status_text[status_text.find("{") :]
                        if "{" in status_text
                        else status_text
                    )
                    status_data = json.loads(json_payload)
                    current_status = status_data.get("status")

                    print(f"⏳ [Teardown {i + 1}/15] Status: {current_status}")

                    if current_status == "SUCCESS":
                        is_cleaned = True
                        print("✅ Environment successfully stopped and cleaned.")
                        break
                    elif current_status == "FAILURE":
                        print(
                            f"❌ Worker reported teardown failure: {status_data.get('error')}"
                        )
                        break
                except (json.JSONDecodeError, ValueError):
                    # Fallback for plain text status if the server isn't returning JSON
                    if "SUCCESS" in status_text:
                        is_cleaned = True
                        break
            else:
                print(f"⚠️  Polling check {i + 1} failed to get a valid response.")

        if not is_cleaned:
            print("🏁 Teardown polling finished (check Docker manually if needed).")
    except Exception as e:
        print(f"💥 Test crashed: {e}")
    finally:
        print("🛑 Shutting down Orchestrator...")

        stop_resp_final = await call_mcp(
            "tools/call",
            {
                "name": "stop_environment",
                "arguments": {"feature_slug": FEATURE_SLUG},
            },
            995,  # distinct message id, avoids clashing with the 1-104 wait loop
        )
        print(f"🏁 E2E Test Complete.")


if __name__ == "__main__":
    try:
        asyncio.run(run_e2e_test())
    except KeyboardInterrupt:
        pass
