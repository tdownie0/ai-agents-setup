use ignore::WalkBuilder;
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};
use rayon::prelude::*;
use redis::Commands;
use std::fs;
use std::path::Path;
use tree_sitter::{Node, Parser};

const IGNORE_DIRS: &[&str] = &[
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
];

const SUPPORTED_EXTENSIONS: &[&str] = &["py", "js", "ts", "tsx", "go", "rs", "cpp", "h", "cs"];

#[derive(Debug, Clone)]
struct ScanResult {
    path: String,
    rel_path: String,
    hash: String,
    summary: String,
}

struct LangConfig {
    definitions: &'static [&'static str],
    imports: &'static [&'static str],
}

// --- CONFIGURATION ---

fn get_config_for_ext(ext: &str) -> LangConfig {
    match ext {
        "rs" => LangConfig {
            definitions: &[
                "function_item",
                "struct_item",
                "enum_item",
                "trait_item",
                "impl_item",
                "mod_item",
                "type_item",
                "const_item",
            ],
            imports: &["use_declaration", "extern_crate_declaration"],
        },
        "py" => LangConfig {
            definitions: &["class_definition", "function_definition"],
            imports: &["import_statement", "import_from_statement"],
        },
        "ts" | "tsx" | "js" => LangConfig {
            definitions: &[
                "interface_declaration",
                "function_definition",
                "method_definition",
                "type_alias_declaration",
                "lexical_declaration",
                "variable_declaration",
                "class_declaration",
            ],
            imports: &["import_statement"],
        },
        "go" => LangConfig {
            definitions: &[
                "function_declaration",
                "method_declaration",
                "type_declaration",
            ],
            imports: &["import_declaration"],
        },
        _ => LangConfig {
            definitions: &["function_definition", "function_item"],
            imports: &[],
        },
    }
}

// --- CORE LOGIC ---

pub fn scan_file_internal(path: &str) -> Result<(String, String), String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", md5::compute(&content));
    let summary = parse_content_to_summary(&content, path)?;
    Ok((hash, summary))
}

fn perform_parallel_scan(
    dir_path: &str,
    workspace_root: &str,
    redis_url: Option<&str>,
) -> Vec<ScanResult> {
    let walker = WalkBuilder::new(dir_path)
        .hidden(true)
        .filter_entry(|entry| {
            let name = entry.file_name().to_str().unwrap_or("");
            !IGNORE_DIRS.contains(&name)
        })
        .build();

    let files: Vec<_> = walker
        .filter_map(|e| e.ok())
        .filter(|e| {
            let path = e.path();
            path.is_file()
                && path
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|ext| SUPPORTED_EXTENSIONS.contains(&ext))
                    .unwrap_or(false)
        })
        .collect();

    // Prepare Redis client if URL is provided
    let redis_client = redis_url.and_then(|url| redis::Client::open(url).ok());

    let results: Vec<ScanResult> = files
        .par_iter()
        .map(|entry| {
            let p_str = entry.path().to_string_lossy().to_string();

            let rel_path = entry
                .path()
                .strip_prefix(workspace_root)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .to_string()
                .trim_start_matches('/')
                .to_string();

            let (hash, summary) = match scan_file_internal(&p_str) {
                Ok(res) => res,
                Err(e) => ("ERROR".to_string(), format!("Error: {}", e)),
            };

            // IN-LOOP CACHING: Push to Redis immediately while on a background thread
            if let Some(ref client) = redis_client {
                if let Ok(mut con) = client.get_connection() {
                    let _: Result<(), _> = con.set_ex(format!("ast:{}", rel_path), &summary, 3600);
                    let _: Result<(), _> = con.set_ex(format!("hash:{}", rel_path), &hash, 3600);
                }
            }

            ScanResult {
                path: p_str,
                rel_path,
                hash,
                summary,
            }
        })
        .collect();

    results
}

// --- TREE-SITTER HELPERS ---

fn parse_content_to_summary(source_code: &str, file_path: &str) -> Result<String, String> {
    let extension = Path::new(file_path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let config = get_config_for_ext(extension);
    let mut parser = Parser::new();

    let lang = match extension {
        "py" => tree_sitter_python::language(),
        "ts" | "tsx" => tree_sitter_typescript::language_tsx(),
        "js" => tree_sitter_javascript::language(),
        "go" => tree_sitter_go::language(),
        "rs" => tree_sitter_rust::language(),
        _ => tree_sitter_python::language(),
    };

    parser.set_language(&lang).map_err(|e| e.to_string())?;
    let tree = parser.parse(source_code, None).ok_or("Failed to parse")?;
    let mut summary = Vec::new();

    get_summary(
        tree.root_node(),
        source_code,
        0,
        &mut summary,
        &config,
        extension,
    );
    Ok(summary.join("\n"))
}

fn get_summary(
    node: Node,
    source: &str,
    depth: usize,
    summary: &mut Vec<String>,
    config: &LangConfig,
    ext: &str,
) {
    let indent = "  ".repeat(depth);
    let node_type = node.kind();

    if config.definitions.contains(&node_type) {
        let signature = source[node.start_byte()..node.end_byte()]
            .lines()
            .next()
            .unwrap_or("");
        let line_no = node.start_position().row + 1;
        summary.push(format!(
            "{}{}[{}] # Line {}",
            indent, signature, node_type, line_no
        ));

        if ext == "py" {
            for child in node.children(&mut node.walk()) {
                if child.kind() == "block" {
                    if let Some(first_expr) = child.child(0) {
                        if first_expr.kind() == "expression_statement" {
                            let doc = source[first_expr.start_byte()..first_expr.end_byte()].trim();
                            summary.push(format!("{}  {}", indent, truncate(doc, 50)));
                        }
                    }
                }
            }
        }
        for child in node.children(&mut node.walk()) {
            get_summary(child, source, depth + 1, summary, config, ext);
        }
    } else if config.imports.contains(&node_type) {
        let import_text = source[node.start_byte()..node.end_byte()].trim();
        summary.push(format!("{}[Import] {}", indent, import_text));
    } else {
        for child in node.children(&mut node.walk()) {
            get_summary(child, source, depth, summary, config, ext);
        }
    }
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.len() > max_chars {
        format!("{}...", &s[..max_chars])
    } else {
        s.to_string()
    }
}

// --- PY03 EXPORTS ---

#[pyfunction]
#[pyo3(signature = (dir_path, workspace_root, redis_url=None))]
fn scan_directory(
    py: Python<'_>,
    dir_path: String,
    workspace_root: String,
    redis_url: Option<String>,
) -> PyResult<Bound<'_, PyList>> {
    // Run the heavy lifting

    let results =
        py.detach(|| perform_parallel_scan(&dir_path, &workspace_root, redis_url.as_deref()));

    let list = PyList::empty(py);
    for res in results {
        let dict = PyDict::new(py);
        dict.set_item("path", res.path)?;
        dict.set_item("rel_path", res.rel_path)?;
        dict.set_item("hash", res.hash)?;
        dict.set_item("summary", res.summary)?;
        list.append(dict)?;
    }

    Ok(list)
}

#[pyfunction]
fn scan_file(path: String) -> PyResult<(String, String)> {
    scan_file_internal(&path).map_err(|e| PyRuntimeError::new_err(e))
}

#[pymodule]
fn ast_scanner_rust(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(scan_file, m)?)?;
    m.add_function(wrap_pyfunction!(scan_directory, m)?)?;
    Ok(())
}
