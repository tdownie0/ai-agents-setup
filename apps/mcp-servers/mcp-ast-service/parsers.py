from tree_sitter_language_pack import get_language, get_parser

def get_summary(node, source_code, depth=0):
    """Recursively extracts signatures and imports."""
    summary = []
    indent = "  " * depth
    
    # Definitions that might contain nested blocks
    definition_types = [
        'class_definition', 'function_definition', 'method_definition',
        'interface_declaration', 'type_alias_declaration', 'lexical_declaration'
    ]
    
    # Terminal types (don't need to recurse)
    import_types = ['import_statement', 'import_from_statement']

    if node.type in definition_types:
        lines = source_code[node.start_byte:node.end_byte].splitlines()
        signature = lines[0] if lines else ""
        line_no = node.start_point[0] + 1
        summary.append(f"{indent}{signature} # Line {line_no}")
        
        # Look for docstrings in the children
        for child in node.children:
            if child.type == 'block':
                for grandchild in child.children:
                    if grandchild.type == 'expression_statement':
                        doc = source_code[grandchild.start_byte:grandchild.end_byte].strip()
                        doc_snippet = doc.split('\n')[0][:50] + "..." if len(doc) > 50 else doc
                        summary.append(f"{indent}  {doc_snippet}")
                        break
                break
        
        # Recurse into children to find nested definitions
        for child in node.children:
            summary.extend(get_summary(child, source_code, depth + 1))

    elif node.type in import_types:
        import_text = source_code[node.start_byte:node.end_byte].strip()
        summary.append(f"{indent}[Import] {import_text}")

    else:
        # Not an interesting top-level node, keep digging
        for child in node.children:
            summary.extend(get_summary(child, source_code, depth))
            
    return summary

def parse_code(file_content, extension):
    lang_map = {
        '.py': 'python', 
        '.js': 'javascript', 
        '.ts': 'typescript', 
        '.tsx': 'tsx',
        '.go': 'go'
    }
    lang_name = lang_map.get(extension, 'python')
    
    try:
        # tree-sitter-language-pack handles the loading
        parser = get_parser(lang_name)
        tree = parser.parse(bytes(file_content, "utf8"))
        return "\n".join(get_summary(tree.root_node, file_content))

    except Exception as e:
        return f"Parser error for {lang_name}: {str(e)}"
