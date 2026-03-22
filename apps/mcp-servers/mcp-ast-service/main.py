import os
import hashlib
import redis.asyncio as redis
import asyncio
import sys
from mcp.server.fastmcp import FastMCP
from parsers import parse_code

WORKSPACE_ROOT = os.getenv("WORKSPACE_ROOT", "/app")
DEFAULT_PROJECT = os.getenv("DEFAULT_PROJECT", "model_md")
# 1. Initialize FastMCP immediately - this makes the protocol handler ready
mcp = FastMCP("AST-Explorer")

# Configuration
IGNORE_DIRS = {
    "node_modules",
    "vendor",
    ".git",
    ".svn",
    ".hg",
    "__pycache__",
    "venv",
    ".venv",
    "env",
    "dist",
    "build",
    "target",
    "bin",
    "obj",
}

SUPPORTED_EXTENSIONS = {".py", ".js", ".ts", ".tsx", ".go", ".rs", ".cpp", ".h", ".cs"}

MAX_CONCURRENCY = 20
io_semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
CACHE_TTL = 3600

_redis_client = None


def get_redis_client():
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.Redis(
            host=os.getenv("REDIS_HOST", "cache"), port=6379, decode_responses=True
        )
    return _redis_client


async def process_file(file_path, r_client):
    """Internal helper to handle parsing and caching with concurrency control."""

    async with io_semaphore:
        try:
            content = await asyncio.to_thread(
                lambda: open(file_path, "r", encoding="utf-8").read()
            )
        except Exception as e:
            return f"Error reading {file_path}: {str(e)}"

        rel_path = os.path.relpath(file_path, WORKSPACE_ROOT)
        file_hash = hashlib.md5(content.encode()).hexdigest()
        ast_key = f"ast:{rel_path}"
        hash_key = f"hash:{rel_path}"

        try:
            async with r_client.pipeline(transaction=True) as pipe:
                pipe.get(ast_key)
                pipe.get(hash_key)
                cached_ast, cached_hash = await pipe.execute()

            if cached_ast and cached_hash == file_hash:
                return f"--- {file_path} (Cached) ---\n{cached_ast}"
        except Exception as e:
            print(f"Redis lookup failed for {rel_path}: {e}", file=sys.stderr)

        _, ext = os.path.splitext(file_path)
        try:
            ast_summary = await asyncio.to_thread(parse_code, content, ext)

            async with r_client.pipeline(transaction=True) as pipe:
                pipe.set(ast_key, ast_summary, ex=CACHE_TTL)
                pipe.set(hash_key, file_hash, ex=CACHE_TTL)
                await pipe.execute()

            return f"--- {file_path} ---\n{ast_summary}"
        except Exception as e:
            return f"Error parsing {file_path}: {str(e)}"


@mcp.tool()
async def get_repo_map(path: str | None = None) -> str:
    """
    Generates a high-level map...
    """
    target_slug = path if path else DEFAULT_PROJECT
    target = os.path.normpath(os.path.join(WORKSPACE_ROOT, target_slug))

    # Security check
    if not target.startswith(os.path.abspath(WORKSPACE_ROOT)):
        return f"Access Denied: Path {target} is outside of the workspace sandbox."

    r_client = get_redis_client()

    if not os.path.exists(target):
        return f"Path not found: {path} (Resolved to: {target})"

    if os.path.isfile(target):
        return await process_file(target, r_client)

    if os.path.isdir(target):
        all_files = []
        for root, dirs, files in os.walk(target):
            dirs[:] = [
                d for d in dirs if d not in IGNORE_DIRS and not d.startswith(".")
            ]
            for file in files:
                if os.path.splitext(file)[1].lower() in SUPPORTED_EXTENSIONS:
                    all_files.append(os.path.join(root, file))

        if not all_files:
            return f"No supported source files found in {target}"

        # Parse files in parallel
        tasks = [process_file(f, r_client) for f in all_files]
        results = await asyncio.gather(*tasks)

        return "\n\n".join(results)

    return "Unsupported path type."


@mcp.tool()
async def find_symbol(symbol_name: str, project_filter: str | None = None) -> str:
    """Search for a symbol, optionally restricted to a specific worktree/project."""
    r_client = get_redis_client()
    # If a filter is provided (e.g., 'model_md-worktree-auth'), only search that prefix
    prefix = f"ast:{project_filter}" if project_filter else "ast:"
    keys = await r_client.keys(f"{prefix}*")

    matches = []
    for key in keys:
        summary = await r_client.get(key)
        if summary and symbol_name in summary:
            matches.append(f"Found in: {key.replace('ast:', '')}")

    return "\n".join(matches) if matches else f"Symbol '{symbol_name}' not found."


@mcp.tool()
async def get_dependents(file_path: str, project_path: str | None = None) -> str:
    """Finds all files that import the given file_path."""
    target_project = project_path if project_path else DEFAULT_PROJECT
    target_name = os.path.basename(file_path).split(".")[0]

    r_client = get_redis_client()
    # ONLY look at keys belonging to the current project/worktree
    keys = await r_client.keys(f"ast:{target_project}/*")

    dependents = []
    for key in keys:
        content = await r_client.get(key)
        if content and "[Import]" in content and target_name in content:
            dependents.append(key.replace("ast:", ""))

    return "\n".join(dependents) if dependents else "No dependents found."


if __name__ == "__main__":
    # Check for stdio transport
    # The Gateway communicates via stdin/stdout, so we check for the flag or
    # if the environment variable we set in the catalog is present.
    is_stdio = "--stdio" in sys.argv or os.getenv("DOCKER_MCP_TRANSPORT") == "stdio"

    if is_stdio:
        mcp.run(transport="stdio")
    else:
        mcp.run(transport="sse")
