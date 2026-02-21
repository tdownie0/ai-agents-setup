import os
import hashlib
import redis
import sys
from mcp.server.fastmcp import FastMCP
from parsers import parse_code
from concurrent.futures import ThreadPoolExecutor

PROJECT_ROOT = os.getenv("PROJECT_ROOT", "/app")
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


    file_hash = hashlib.md5(content.encode()).hexdigest()
    ast_key = f"ast:{file_path}"
    hash_key = f"hash:{file_path}"

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
def get_repo_map(path: str = ".") -> str:
    """
    Generates a high-level map...
    """
    target = os.path.normpath(os.path.join(PROJECT_ROOT, path))
    
    # Security check
    if not target.startswith(PROJECT_ROOT):
        target = PROJECT_ROOT

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
        
        # Parse files in parallel
        with ThreadPoolExecutor(max_workers=10) as executor:
            results = list(executor.map(lambda f: process_file(f, r_client), all_files))

        if not results:
            return f"No supported source files found in {path}"


        return "\n\n".join(results)

    return "Unsupported path type."

@mcp.tool()
def find_symbol(symbol_name: str) -> str:
    """Search the Redis cache for any file containing a specific class or function."""
    r_client = get_redis_client()
    # Find all keys starting with ast:
    keys = r_client.keys("ast:*")
    matches = []
    
    for key in keys:
        summary = r_client.get(key)
        if symbol_name in summary:
            # key is 'ast:/app/server/src/index.ts'
            file_path = key.replace("ast:", "")
            matches.append(f"Found in: {file_path}")
            
    return "\n".join(matches) if matches else f"Symbol '{symbol_name}' not found in cache."

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
