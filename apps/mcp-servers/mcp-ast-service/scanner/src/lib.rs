use ignore::WalkBuilder;
use rayon::prelude::*;
use std::env;
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

struct LangConfig {
    definitions: &'static [&'static str],
    imports: &'static [&'static str],
}

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

// --- CORE LOGIC (Future PyO3 Exports) ---

/// It returns (hash, summary) or an error.
pub fn scan_file_internal(path: &str) -> Result<(String, String), String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", md5::compute(&content));
    let summary = parse_content_to_summary(&content, path)?;
    Ok((hash, summary))
}

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        eprintln!("Usage: ast-scanner <file_path> OR ast-scanner --dir <directory_path>");
        std::process::exit(1);
    }

    if args[1] == "--dir" && args.len() > 2 {
        perform_parallel_scan(&args[2]);
    } else {
        let file_path = &args[1];
        match scan_file_internal(file_path) {
            Ok((_hash, summary)) => println!("{}", summary),
            Err(e) => {
                eprintln!("Error: {}", e);
                std::process::exit(1);
            }
        }
    }
}

fn perform_parallel_scan(path: &str) -> Vec<ScanResult> {
    let walker = WalkBuilder::new(path)
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

    let results: Vec<ScanResult> = files
        .par_iter()
        .map(|entry| {
            let p_str = entry.path().to_string_lossy().to_string();
            match scan_file_internal(&p_str) {
                Ok((hash, summary)) => ScanResult {
                    path: p_str,
                    hash: hash,
                    summary: summary,
                },
                Err(e) => ScanResult {
                    path: p_str,
                    hash: "ERROR".to_string(),
                    summary: format!("Error: {}", e),
                },
            }
        })
        .collect();

    results
}

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

        // Language-Specific Docstring Extraction
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

        // Recurse deeper for nested definitions (classes/modules)
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

use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};

struct ScanResult {
    path: String,
    hash: String,
    summary: String,
}

#[pyfunction]
fn scan_directory(py: Python<'_>, dir_path: String) -> PyResult<Bound<'_, PyList>> {
    let results: Vec<ScanResult> = perform_parallel_scan(&dir_path);

    let list = PyList::empty(py);

    for res in results {
        let dict = PyDict::new(py);
        dict.set_item("path", res.path)?;
        dict.set_item("hash", res.hash)?;
        dict.set_item("summary", res.summary)?;
        list.append(dict)?;
    }

    Ok(list)
}

// This wraps your internal logic for Python
#[pyfunction]
fn scan_file(path: String) -> PyResult<(String, String)> {
    scan_file_internal(&path).map_err(|e| PyRuntimeError::new_err(e))
}

// This defines the Python module name
#[pymodule]
fn ast_scanner_rust(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(scan_file, m)?)?;
    m.add_function(wrap_pyfunction!(scan_directory, m)?)?;
    Ok(())
}
