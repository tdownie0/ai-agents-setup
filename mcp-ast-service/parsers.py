from tree_sitter_language_pack import get_language, get_parser

def get_summary(node, source_code, depth=0):
    """Recursively extracts signatures with actual line numbers."""
    summary = []
    
    # Interested in classes and functions
    interesting_types = ['class_definition', 'function_definition', 'method_definition']
    
    if node.type in interesting_types:
        # Get the signature line
        lines = source_code[node.start_byte:node.end_byte].splitlines()
        signature = lines[0] if lines else ""
        line_no = node.start_point[0] + 1
        indent = "  " * depth
        summary.append(f"{indent}{signature} # Line {line_no}")
        
        # Look for docstrings
        for child in node.children:
            if child.type == 'block':
                for grandchild in child.children:
                    if grandchild.type == 'expression_statement':
                        doc = source_code[grandchild.start_byte:grandchild.end_byte].strip()

                        # Clean up multi-line strings for the summary
                        doc_snippet = doc.split('\n')[0][:50] + "..." if len(doc) > 50 else doc
                        summary.append(f"{indent}  {doc_snippet}")
                        break
                break
        
        # Recurse into the block to find nested methods/functions
        for child in node.children:
            summary.extend(get_summary(child, source_code, depth + 1))
    else:
        # Just keep looking down the tree for definitions
        for child in node.children:
            summary.extend(get_summary(child, source_code, depth))
            
    return summary


def parse_code(file_content, extension):
    # Mapping extensions to tree-sitter languages
    lang_map = {
        '.py': 'python', 

        '.js': 'javascript', 
        '.ts': 'typescript', 
        '.tsx': 'typescript', 
        '.go': 'go'
    }
    lang_name = lang_map.get(extension, 'python')
    
    try:
        language = get_language(lang_name)
        parser = get_parser(lang_name)
        tree = parser.parse(bytes(file_content, "utf8"))
        return "\n".join(get_summary(tree.root_node, file_content))
    except Exception as e:
        return f"Parser error for {lang_name}: {str(e)}"
