import sys
import os
import socket
import subprocess
import redis
import time
from typing import cast, Set

# Configuration Constants
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
PORT_REGISTRY_KEY = "active_ports"
PORT_LOCK_KEY = "lock:port_allocation"

# Singleton Redis connection
r: redis.Redis = redis.Redis(
    host=REDIS_HOST,
    port=REDIS_PORT,
    db=0,
    decode_responses=True,
)


def is_port_in_use(port: int) -> bool:
    """Checks if a port is physically occupied on the host."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("localhost", port)) == 0


def release_ports(ports: list[int]):
    """Helper to remove ports from registry."""
    if ports:
        r.srem(PORT_REGISTRY_KEY, *ports)


def find_available_port_block(start_port=5174, timeout=10) -> tuple[int, int, int]:
    """Finds three available ports using a global Redis lock and registry."""
    start_time = time.time()

    # Acquire Distributed Mutex
    while not r.set(PORT_LOCK_KEY, "locked", nx=True, ex=20):
        if time.time() - start_time > timeout:
            print(f"❌ [REDIS] Lock timeout after {timeout}s", file=sys.stderr)
            raise TimeoutError("Could not acquire port allocation lock")
        time.sleep(0.1)

    try:
        # Get currently tracked ports
        raw_members = cast(Set[str], r.smembers(PORT_REGISTRY_KEY))
        allocated_ports = {int(p) for p in raw_members}
        port = start_port
        while True:
            fe, be, db = port, port + 1000, port + 2000
            requested = {fe, be, db}

            # Check Redis registry
            if not (requested & allocated_ports):
                # Check OS-level usage
                if not any(is_port_in_use(p) for p in requested):
                    # Double check Docker PS to be safe
                    try:
                        docker_check = subprocess.run(
                            ["docker", "ps", "--format", "{{.Ports}}"],
                            capture_output=True,
                            text=True,
                            timeout=5,  # Critical: don't hang the orchestrator
                        )
                    except subprocess.TimeoutExpired:
                        print(
                            "⚠️ [DOCKER] docker ps timed out! Check socket permissions.",
                            file=sys.stderr,
                        )
                        raise

                    if not any(f":{p}->" in docker_check.stdout for p in requested):
                        r.sadd(PORT_REGISTRY_KEY, *requested)
                        return fe, be, db
                    else:
                        print(
                            f"🚧 [DOCKER] Port collision found in running containers for {requested}",
                            file=sys.stderr,
                        )

            port += 1
            if port > start_port + 500:  # Safety break to prevent infinite loops
                raise RuntimeError("Searched 500 port blocks and found none available.")

    except Exception as e:
        print(f"💥 [ERROR] find_available_port_block failed: {str(e)}", file=sys.stderr)
        raise
    finally:
        # Clean up the lock
        locked_by_us = r.get(PORT_LOCK_KEY) == "locked"
        if locked_by_us:
            r.delete(PORT_LOCK_KEY)
