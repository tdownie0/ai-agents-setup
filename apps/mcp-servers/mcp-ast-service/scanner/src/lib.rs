use ignore::WalkBuilder;
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};
use r2d2_redis::r2d2;
use r2d2_redis::redis::Commands;
use r2d2_redis::RedisConnectionManager;
use rayon::prelude::*;
use std::fs;
use std::path::Path;
use tree_sitter::{Language, Node, Parser};

// --- CONSTANTS ---

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

// --- ABSTRACTIONS ---

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SupportedLanguage {
    Rust,
    Python,
    TypeScript,
    JavaScript,
    Go,
}

impl SupportedLanguage {
    fn from_extension(ext: &str) -> Option<Self> {
        match ext {
            "rs" => Some(Self::Rust),
            "py" => Some(Self::Python),
            "ts" | "tsx" => Some(Self::TypeScript),
            "js" => Some(Self::JavaScript),
            "go" => Some(Self::Go),
            _ => None,
        }
    }

    fn ts_language(&self) -> Language {
        match self {
            Self::Rust => tree_sitter_rust::language(),
            Self::Python => tree_sitter_python::language(),
            Self::TypeScript => tree_sitter_typescript::language_tsx(),
            Self::JavaScript => tree_sitter_javascript::language(),
            Self::Go => tree_sitter_go::language(),
        }
    }

    fn config(&self) -> LangConfig {
        match self {
            Self::Rust => LangConfig {
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
            Self::Python => LangConfig {
                definitions: &["class_definition", "function_definition"],
                imports: &["import_statement", "import_from_statement"],
            },

            Self::TypeScript | Self::JavaScript => LangConfig {
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
            Self::Go => LangConfig {
                definitions: &[
                    "function_declaration",
                    "method_declaration",
                    "type_declaration",
                ],
                imports: &["import_declaration"],
            },
        }
    }
}

struct LangConfig {
    definitions: &'static [&'static str],
    imports: &'static [&'static str],
}

#[derive(Debug, Clone)]
struct ScanResult {
    path: String,
    rel_path: String,
    hash: String,
    summary: String,
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
                    .and_then(SupportedLanguage::from_extension)
                    .is_some()
        })
        .collect();

    let pool = redis_url.and_then(|url| {
        let manager = RedisConnectionManager::new(url).ok()?;
        r2d2::Pool::builder().max_size(16).build(manager).ok()
    });

    files
        .par_iter()
        .map(|entry| {
            let p_str = entry.path().to_string_lossy().to_string();
            let rel_path = entry
                .path()
                .strip_prefix(workspace_root)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .trim_start_matches('/')
                .to_string();

            let (hash, summary) = match scan_file_internal(&p_str) {
                Ok(res) => res,
                Err(e) => ("ERROR".to_string(), format!("Error: {}", e)),
            };

            if let Some(ref p) = pool {
                if let Ok(mut con) = p.get() {
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
        .collect()
}

// --- TREE-SITTER HELPERS ---

fn parse_content_to_summary(source_code: &str, file_path: &str) -> Result<String, String> {
    let extension = Path::new(file_path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    let lang_type = SupportedLanguage::from_extension(extension)
        .ok_or_else(|| format!("Unsupported extension: {}", extension))?;

    let config = lang_type.config();
    let mut parser = Parser::new();

    parser
        .set_language(&lang_type.ts_language())
        .map_err(|e| e.to_string())?;

    let tree = parser.parse(source_code, None).ok_or("Failed to parse")?;
    let mut summary = Vec::new();

    get_summary(
        tree.root_node(),
        source_code,
        0,
        &mut summary,
        &config,
        lang_type,
    );
    Ok(summary.join("\n"))
}

fn get_summary(
    node: Node,
    source: &str,
    depth: usize,
    summary: &mut Vec<String>,
    config: &LangConfig,
    lang: SupportedLanguage,
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

        // Extract Python docstrings if applicable
        if lang == SupportedLanguage::Python {
            if let Some(doc) = extract_python_docstring(node, source) {
                summary.push(format!("{}  {}", indent, truncate(&doc, 50)));
            }
        }

        for child in node.children(&mut node.walk()) {
            get_summary(child, source, depth + 1, summary, config, lang);
        }
    } else if config.imports.contains(&node_type) {
        let import_text = source[node.start_byte()..node.end_byte()].trim();
        summary.push(format!("{}[Import] {}", indent, import_text));
    } else {
        for child in node.children(&mut node.walk()) {
            get_summary(child, source, depth, summary, config, lang);
        }
    }
}

fn extract_python_docstring(node: Node, source: &str) -> Option<String> {
    for child in node.children(&mut node.walk()) {
        if child.kind() == "block" {
            if let Some(first_expr) = child.child(0) {
                if first_expr.kind() == "expression_statement" {
                    return Some(
                        source[first_expr.start_byte()..first_expr.end_byte()]
                            .trim()
                            .to_string(),
                    );
                }
            }
        }
    }
    None
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
