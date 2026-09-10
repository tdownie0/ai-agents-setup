#!/usr/bin/env python3
import sys
import json
import urllib.request
import urllib.error

# Force unbuffered I/O for instant line-by-line agent communication
sys.stdout.reconfigure(line_buffering=True)
sys.stdin.reconfigure(line_buffering=True)

MCP_URL = "http://mcp-gateway:8811/mcp"
session_id = None


def post(payload: dict) -> str:
    global session_id
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
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


def main():
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        try:
            payload = json.loads(line.strip())
            response = post(payload)
            if response.strip():
                sys.stdout.write(response + "\n")
        except urllib.error.HTTPError as e:
            if e.code == 404 and session_id:
                try:
                    response = reinitialize(payload)
                    if response.strip():
                        sys.stdout.write(response + "\n")
                except Exception as retry_err:
                    sys.stderr.write(f"Retry Error: {str(retry_err)}\n")
            else:
                sys.stderr.write(f"HTTP Error: {e.code}: {e.reason}\n")
        except Exception as e:
            sys.stderr.write(f"Write Error: {str(e)}\n")


if __name__ == "__main__":
    main()