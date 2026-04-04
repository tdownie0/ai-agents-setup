import os
import redis.asyncio as redis
import asyncio
import sys
import ast_scanner_rust
from mcp.server.fastmcp import FastMCP
from typing import List, Dict, cast

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


def get_safe_path(input_path: str) -> str:
    """Standardizes path resolution for security and Redis key consistency."""
    root = os.path.abspath(WORKSPACE_ROOT)
    # lstrip('/') prevents user input from 'resetting' the path to root during join
    safe_join = os.path.join(root, input_path.lstrip("/"))
    # normpath removes ../ and ./; abspath makes it final
    return os.path.abspath(os.path.normpath(safe_join))


@mcp.tool()
async def scan_specific_file(file_path: str) -> str:
    """
    Performs a deep AST scan of a single file to extract signatures, docstrings, and imports.
    Use this to refresh the cache for a specific file or to get deep details on a file
    after locating it via find_symbol or get_repo_map.

    Args:
        file_path (str): The path to the file relative to the workspace root
                         (e.g., 'src/main.py' or 'packages/db/schema.ts').

    Returns:
        str: The formatted AST summary of the file, or an error message if
             the file cannot be read or is outside the workspace.
    """
    abs_path = get_safe_path(file_path)
    if not abs_path.startswith(os.path.abspath(WORKSPACE_ROOT)):
        return "Access Denied: Path is outside workspace."

    r_client = get_redis_client()
    return await process_file(abs_path, r_client)


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
    target = get_safe_path(target_slug)

    if not target.startswith(os.path.abspath(WORKSPACE_ROOT)):
        return "Access Denied."

    try:
        raw_data = await asyncio.to_thread(
            ast_scanner_rust.scan_directory, target, WORKSPACE_ROOT, REDIS_URL
        )
        data = cast(List[Dict[str, str]], raw_data)

        formatted_results = []
        for item in data:
            # Type checker is now happy with item["path"]
            rel = os.path.relpath(item["path"], WORKSPACE_ROOT)
            formatted_results.append(f"--- {rel} ---\n{item['summary']}")

        return "\n\n".join(formatted_results)

    except Exception as e:
        return f"Mapping Error: {str(e)}"


def get_redis_prefix(input_path: str, namespace: str = "ast") -> str:
    """
    Converts a user-provided path into a consistent Redis key prefix.
    Example: 'model_md/' -> 'ast:model_md'
    """
    abs_path = get_safe_path(input_path)
    # Get the path relative to /app
    rel = os.path.relpath(abs_path, os.path.abspath(WORKSPACE_ROOT))

    # Strip leading slashes and any './' markers to keep keys clean
    clean_rel = rel.lstrip("./").lstrip("/")

    # If the path is just the root itself, relpath might return '.'
    if clean_rel == ".":
        return f"{namespace}:"

    return f"{namespace}:{clean_rel}"


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
    prefix = get_redis_prefix(project_filter) if project_filter else "ast:"
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
    prefix = get_redis_prefix(target_project)

    target_name = os.path.basename(file_path).split(".")[0]
    r_client = get_redis_client()

    keys = await r_client.keys(f"{prefix}*")

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
