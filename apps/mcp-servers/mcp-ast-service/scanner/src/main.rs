use ignore::WalkBuilder;
use rayon::prelude::*;
use serde_json::json;
use std::env;
use std::fs;
use std::path::Path;
use tree_sitter::{Node, Parser};

// --- Configuration ---
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

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        eprintln!("Usage: ast-scanner <file_path> OR ast-scanner --dir <directory_path>");
        std::process::exit(1);
    }

    if args[1] == "--dir" && args.len() > 2 {
        scan_directory(&args[2]);
    } else {
        // Single file mode
        let file_path = &args[1];
        match parse_file_to_summary(file_path) {
            Ok(summary) => println!("{}", summary),

            Err(e) => {
                eprintln!("Error: {}", e);
                std::process::exit(1);
            }
        }
    }
}

fn scan_directory(path: &str) {
    let mut builder = WalkBuilder::new(path);

    // Configure the walker to skip your IGNORE_DIRS
    let walker = builder
        .hidden(true) // Skip hidden files (.git, etc)
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

    // Parallel processing with Rayon
    let results: Vec<_> = files
        .par_iter()
        .map(|entry| {
            let p_str = entry.path().to_string_lossy().to_string();
            let summary = parse_file_to_summary(&p_str).unwrap_or_else(|e| format!("Error: {}", e));

            json!({
                "path": p_str,
                "summary": summary
            })
        })
        .collect();

    println!("{}", serde_json::to_string(&results).unwrap());
}

fn parse_file_to_summary(file_path: &str) -> Result<String, String> {
    let source_code = fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let extension = Path::new(file_path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");

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
    let tree = parser.parse(&source_code, None).ok_or("Failed to parse")?;
    let mut summary = Vec::new();
    get_summary(tree.root_node(), &source_code, 0, &mut summary);

    Ok(summary.join("\n"))
}

fn get_summary(node: Node, source: &str, depth: usize, summary: &mut Vec<String>) {
    let indent = "  ".repeat(depth);
    let node_type = node.kind();
    let definition_types = [
        // Python/TS/JS
        "class_definition",
        "function_definition",
        "method_definition",
        "interface_declaration",
        "type_alias_declaration",
        "lexical_declaration",
        // Rust Specific
        "function_item",
        "struct_item",
        "enum_item",
        "trait_item",
        "impl_item",
        "mod_item",
        "type_item",
        "const_item",
    ];
    let import_types = ["import_statement", "import_from_statement"];

    if definition_types.contains(&node_type) {
        let signature = source[node.start_byte()..node.end_byte()]
            .lines()
            .next()
            .unwrap_or("");
        let line_no = node.start_position().row + 1;
        summary.push(format!(
            "{}{}[{}] # Line {}",
            indent, signature, node_type, line_no
        ));

        // Docstring extraction
        for child in node.children(&mut node.walk()) {
            if child.kind() == "block" {
                if let Some(first_expr) = child.child(0) {
                    if first_expr.kind() == "expression_statement" {
                        let doc = &source[first_expr.start_byte()..first_expr.end_byte()].trim();
                        let snippet = if doc.len() > 50 {
                            format!("{}...", &doc[..50])
                        } else {
                            doc.to_string()
                        };
                        summary.push(format!("{}  {}", indent, snippet));
                    }
                }
            }
        }

        for child in node.children(&mut node.walk()) {
            get_summary(child, source, depth + 1, summary);
        }
    } else if import_types.contains(&node_type) {
        let import_text = source[node.start_byte()..node.end_byte()].trim();
        summary.push(format!("{}[Import] {}", indent, import_text));
    } else {
        for child in node.children(&mut node.walk()) {
            get_summary(child, source, depth, summary);
        }
    }
}
