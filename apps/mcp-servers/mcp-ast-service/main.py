import os
import redis.asyncio as redis
import asyncio
import sys
import ast_scanner_rust
from mcp.server.fastmcp import FastMCP

WORKSPACE_ROOT = os.getenv("WORKSPACE_ROOT", "/app")
DEFAULT_PROJECT = os.getenv("DEFAULT_PROJECT", "model_md")
# 1. Initialize FastMCP immediately - this makes the protocol handler ready
mcp = FastMCP("AST-Explorer")

MAX_CONCURRENCY = 20
io_semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
CACHE_TTL = 3600

REDIS_HOST = os.getenv("REDIS_HOST", "cache")
REDIS_PORT = os.getenv("REDIS_PORT", "6379")
REDIS_URL = f"redis://{REDIS_HOST}:{REDIS_PORT}"

_redis_client = None


def get_redis_client():
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    return _redis_client


async def process_file(file_path, r_client):
    async with io_semaphore:
        rel_path = os.path.relpath(file_path, WORKSPACE_ROOT).lstrip("/")
        ast_key = f"ast:{rel_path}"
        hash_key = f"hash:{rel_path}"

        # mget returns a list: [val1, val2]. If a key is missing, the value is None.
        cached = await r_client.mget(ast_key, hash_key)

        if cached[0] and cached[1]:
            return f"--- {rel_path} (Cached) ---\n{cached[0]}"

        try:
            # Rust handles the heavy lifting: Read -> Hash -> Parse
            file_hash, ast_summary = await asyncio.to_thread(
                ast_scanner_rust.scan_file, file_path
            )

            async with r_client.pipeline(transaction=True) as pipe:
                pipe.set(ast_key, ast_summary, ex=CACHE_TTL)
                pipe.set(hash_key, file_hash, ex=CACHE_TTL)
                await pipe.execute()

            return f"--- {rel_path} ---\n{ast_summary}"

        except Exception as e:
            return f"Error scanning {rel_path}: {str(e)}"


@mcp.tool()
async def get_repo_map(path: str | None = None) -> str:
    """
    Generates a high-level map of the codebase architecture and populates the search cache.
    Use this to get an overview of project structure, classes, functions, and imports.

    Args:
        path (str | None): The sub-directory or project slug within the workspace to scan.
                          Defaults to the current project (DEFAULT_PROJECT).

    Returns:
        str: A concatenated list of file paths and their associated AST summaries
             (signatures, line numbers, and docstrings).
    """
    target_slug = path if path else DEFAULT_PROJECT
    target = os.path.normpath(os.path.join(WORKSPACE_ROOT, target_slug))

    if not target.startswith(os.path.abspath(WORKSPACE_ROOT)):
        return "Access Denied."

    try:
        data = await asyncio.to_thread(
            ast_scanner_rust.scan_directory, target, WORKSPACE_ROOT, REDIS_URL
        )

        return "\n\n".join(
            [
                f"--- {os.path.relpath(item['path'], WORKSPACE_ROOT)} ---\n{item['summary']}"
                for item in data
            ]
        )

    except Exception as e:
        return f"Mapping Error: {str(e)}"


@mcp.tool()
async def find_symbol(symbol_name: str, project_filter: str | None = None) -> str:
    """
    Searches the global AST cache for a specific symbol name (class, function, or variable).
    Only returns matches found in files previously indexed via get_repo_map.

    Args:
        symbol_name (str): The name of the symbol to search for.
        project_filter (str | None): Optional prefix to restrict search to a specific
                                     project or worktree (e.g., 'model_md').

    Returns:
        str: A newline-separated list of file paths where the symbol was found.
    """
    r_client = get_redis_client()
    prefix = f"ast:{project_filter.lstrip('/')}" if project_filter else "ast:"
    keys = await r_client.keys(f"{prefix}*")

    matches = []
    for key in keys:
        summary = await r_client.get(key)
        if summary and symbol_name in summary:
            matches.append(f"Found in: {key.replace('ast:', '')}")

    return "\n".join(matches) if matches else f"Symbol '{symbol_name}' not found."


@mcp.tool()
async def get_dependents(file_path: str, project_path: str | None = None) -> str:
    """
    Identifies all files that import the specified file.
    Useful for assessing the impact of a change to a shared module or database schema.

    Args:
        file_path (str): The path or filename to check for dependents.
        project_path (str | None): Optional project scope for the search.
                                  Defaults to DEFAULT_PROJECT.

    Returns:
        str: A list of file paths that contain an import statement referencing the target file.
    """
    target_project = project_path if project_path else DEFAULT_PROJECT
    target_name = os.path.basename(file_path).split(".")[0]

    r_client = get_redis_client()
    search_prefix = f"ast:{target_project.lstrip('/')}*"
    keys = await r_client.keys(search_prefix)

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
