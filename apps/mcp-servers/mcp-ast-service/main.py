import os
import hashlib
import redis
import sys
from mcp.server.fastmcp import FastMCP
from parsers import parse_code
from concurrent.futures import ThreadPoolExecutor

WORKSPACE_ROOT = os.getenv("WORKSPACE_ROOT", "/app")
DEFAULT_PROJECT = os.getenv("DEFAULT_PROJECT", "model_md")
# 1. Initialize FastMCP immediately - this makes the protocol handler ready
mcp = FastMCP("AST-Explorer")

# Configuration
IGNORE_DIRS = {
    'node_modules', 'vendor', '.git', '.svn', '.hg', 
    '__pycache__', 'venv', '.venv', 'env', 'dist', 
    'build', 'target', 'bin', 'obj'
}

SUPPORTED_EXTENSIONS = {
    '.py', '.js', '.ts', '.tsx', '.go', '.rs', '.cpp', '.h', '.cs'
}

# 2. Lazy Redis Connection

# This prevents the script from hanging during the Gateway's handshake phase
def get_redis_client():
    client = redis.Redis(
        host=os.getenv("REDIS_HOST", "cache"), 
        port=6379, 
        decode_responses=True
    )
    return client

def process_file(file_path, r_client):
    """Internal helper to handle parsing and caching for a single file."""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        return f"Error reading {file_path}: {str(e)}"


    rel_path = os.path.relpath(file_path, WORKSPACE_ROOT)

    file_hash = hashlib.md5(content.encode()).hexdigest()
    ast_key = f"ast:{rel_path}"
    hash_key = f"hash:{rel_path}"

    # Try to use cache, but fail gracefully if Redis is down
    cached_ast = None
    cached_hash = None
    try:
        cached_ast = r_client.get(ast_key)
        cached_hash = r_client.get(hash_key)
    except Exception as e:
        print(f"Redis lookup failed: {e}", file=sys.stderr)

    if cached_ast and cached_hash == file_hash:
        return f"--- {file_path} (Cached) ---\n{cached_ast}"


    _, ext = os.path.splitext(file_path)
    try:
        ast_summary = parse_code(content, ext)
        
        # Store in Redis if available
        try:
            r_client.set(ast_key, ast_summary)
            r_client.set(hash_key, file_hash)
        except:
            pass 

            
        return f"--- {file_path} ---\n{ast_summary}"
    except Exception as e:
        return f"Error parsing {file_path}: {str(e)}"

@mcp.tool()
def get_repo_map(path: str = None) -> str:
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
        return process_file(target, r_client)

    if os.path.isdir(target):
        all_files = []
        for root, dirs, files in os.walk(target):
            dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and not d.startswith('.')]
            for file in files:
                if os.path.splitext(file)[1].lower() in SUPPORTED_EXTENSIONS:
                    all_files.append(os.path.join(root, file))

        if not all_files:
            return f"No supported source files found in {target}"
        
        # Parse files in parallel
        with ThreadPoolExecutor(max_workers=10) as executor:
            results = list(executor.map(lambda f: process_file(f, r_client), all_files))

        return "\n\n".join(results)

    return "Unsupported path type."

@mcp.tool()
def find_symbol(symbol_name: str, project_filter: str = None) -> str:
    """Search for a symbol, optionally restricted to a specific worktree/project."""
    r_client = get_redis_client()
    # If a filter is provided (e.g., 'model_md-worktree-auth'), only search that prefix
    prefix = f"ast:{project_filter}" if project_filter else "ast:"
    keys = r_client.keys(f"{prefix}*")
    
    matches = []
    for key in keys:
        summary = r_client.get(key)
        if symbol_name in summary:
            matches.append(f"Found in: {key.replace('ast:', '')}")
            
    return "\n".join(matches) if matches else f"Symbol '{symbol_name}' not found."

@mcp.tool()
def get_dependents(file_path: str, project_path: str = None) -> str:
    """Finds all files that import the given file_path."""
    target_project = project_path if project_path else DEFAULT_PROJECT
    target_name = os.path.basename(file_path).split('.')[0]
    
    r_client = get_redis_client()
    # ONLY look at keys belonging to the current project/worktree
    keys = r_client.keys(f"ast:{target_project}/*")

    dependents = []
    for key in keys:
        content = r_client.get(key)
        if content and "[Import]" in content and target_name in content:
            dependents.append(key.replace("ast:", ""))
            
    return "\n".join(dependents) if dependents else "No dependents found."

if __name__ == "__main__":
    # Check for stdio transport
    # The Gateway communicates via stdin/stdout, so we check for the flag or 
    # if the environment variable we set in the catalog is present.
    is_stdio = ("--stdio" in sys.argv or 
                os.getenv("DOCKER_MCP_TRANSPORT") == "stdio")
    
    if is_stdio:
        mcp.run(transport='stdio')
    else:
        mcp.run(transport='sse')
