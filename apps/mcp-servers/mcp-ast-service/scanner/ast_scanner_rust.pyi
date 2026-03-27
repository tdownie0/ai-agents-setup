def scan_file(path: str) -> tuple[str, str]:
    """
    Scans a file using the Rust tree-sitter engine.
    Returns a tuple of (md5_hash, ast_summary).
    """
    ...

def scan_directory(path: str) -> str:
    """
    Scans an entire directory recursively in parallel.
    Returns a JSON-encoded string containing a list of objects with
    path, hash, and summary keys.
    """
    ...
