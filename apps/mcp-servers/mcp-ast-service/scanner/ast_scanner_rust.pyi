from typing import TypedDict, Optional

class ScanResult(TypedDict):
    path: str
    rel_path: str
    hash: str
    summary: str

def scan_directory(
    dir_path: str, workspace_root: str, redis_url: Optional[str] = None
) -> list[ScanResult]:
    """

    Scans an entire directory recursively in parallel using the Rust engine.

    Args:
        dir_path: The absolute path to the directory to scan.
        workspace_root: The root of the workspace for path normalization.

        redis_url: Optional Redis connection string for internal caching.

    Returns:
        A list of dictionaries containing path, rel_path, hash, and AST summary.
    """
    ...

def scan_file(path: str) -> tuple[str, str]:
    """
    Parses a single file and returns a tuple of (hash, summary).
    """
    ...
