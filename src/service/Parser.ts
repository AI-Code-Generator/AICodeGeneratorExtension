import Parser from 'tree-sitter';
import TreeSitterJavaScript from 'tree-sitter-javascript';
import TreeSitterTypeScript from 'tree-sitter-typescript';
import TreeSitterJava from 'tree-sitter-java';
// import TreeSitterPython from 'tree-sitter-python';
import * as path from 'path';

export interface CodeChunk {
    content: string;
    type: string;
    startLine: number;
    endLine: number;
    // Java-specific metadata
    packageName?: string;
    className?: string;
    methodName?: string;
    annotations?: string[];
    isSpringComponent?: boolean;
}

export class CodeParser {
    private static parsers: Map<string, Parser> = new Map();

    private static initializeParser(fileExtension: string): Parser | null {
        const parser = new Parser();
        
        switch(fileExtension.toLowerCase()) {
            case '.ts':
                parser.setLanguage(TreeSitterTypeScript.typescript as unknown as Parser.Language);
                return parser;
            case '.tsx':
                parser.setLanguage(TreeSitterTypeScript.tsx as unknown as Parser.Language);
                return parser;
            case '.js':
            case '.jsx':
                parser.setLanguage(TreeSitterJavaScript as unknown as Parser.Language);
                return parser;
            case '.java':
                parser.setLanguage(TreeSitterJava as unknown as Parser.Language);
                return parser;
            // case '.py':
            //     parser.setLanguage(TreeSitterPython);
            //     return parser;
            default:
                return null;
        }
        // if (fileExtension.toLowerCase() === '.js' || fileExtension.toLowerCase() === '.jsx') {
        //     parser.setLanguage(TreeSitterJavaScript as unknown as Parser.Language);
        //     return parser;
        // }
        // return null; 
    }

    private static getParser(fileExtension: string): Parser | null {
        if (!this.parsers.has(fileExtension)) {
            const parser = this.initializeParser(fileExtension);
            if (parser) {
                this.parsers.set(fileExtension, parser);
            }
            return parser;
        }
        return this.parsers.get(fileExtension) || null;
    }

    public static parseCode(content: string, filePath: string): CodeChunk[] {
        const ext = path.extname(filePath);
        const parser = this.getParser(ext);
        
        if (!parser) {
            return this.fallbackChunking(content);
        }

        const tree = parser.parse(content);
        const chunks: CodeChunk[] = [];
        const processedRanges = new Set<string>();
        let lastProcessedIndex = 0;

        const significantNodes = [
            // TypeScript/JavaScript nodes
            'function_declaration',
            'method_definition',
            'class_declaration',
            'interface_declaration',
            'export_statement',
            'import_statement',
            'variable_declaration',
            'const_declaration',
            // Java nodes
            'method_declaration',
            'constructor_declaration',
            'field_declaration',
            'local_variable_declaration',
            'enum_declaration',
            'annotation_type_declaration',
            'import_declaration',
            'package_declaration'
        ];

        const addUnprocessedCode = (startIndex: number, endIndex: number) => {
            if (startIndex < endIndex) {
                const raw = content.slice(startIndex, endIndex);
                const code = raw.trim();
                // Skip if the slice is only comments/whitespace
                const isOnlyComments = /^\s*(\/\*[\s\S]*?\*\/|\/\/.*\n?)*\s*$/.test(raw);
                if (code && !isOnlyComments) {
                    const startPos = tree.rootNode.text.slice(0, startIndex).split('\n').length;
                    const endPos = startPos + code.split('\n').length - 1;
                    chunks.push({
                        content: code,
                        type: 'other',
                        startLine: startPos,
                        endLine: endPos
                    });
                }
            }
        };

        const isNodeProcessed = (node: any) => {
            const range = `${node.startIndex}-${node.endIndex}`;
            return processedRanges.has(range);
        };

        const markNodeProcessed = (node: any) => {
            const range = `${node.startIndex}-${node.endIndex}`;
            processedRanges.add(range);
        };

        const visitNode = (node: any) => {
            if (isNodeProcessed(node)) { return; }

            if (significantNodes.includes(node.type)) {
                // Add any unprocessed code before this node
                addUnprocessedCode(lastProcessedIndex, node.startIndex);

                const startPosition = node.startPosition;
                const endPosition = node.endPosition;
                
                // If it's an export statement, mark its children as processed
                if (node.type === 'export_statement') {
                    for (const child of node.children) {
                        markNodeProcessed(child);
                    }
                }

                // For Java: if a declaration is immediately preceded by annotations,
                // mark those annotation nodes as processed to avoid separate chunks.
                if (ext.toLowerCase() === '.java') {
                    let prev = node.previousSibling;
                    while (prev && (prev.type === 'annotation' || prev.type === 'marker_annotation')) {
                        markNodeProcessed(prev);
                        prev = prev.previousSibling;
                    }
                }

                // Get associated comments
                let commentText = '';
                let currentNode = node.previousSibling;
                while (currentNode && currentNode.type.includes('comment')) {
                    commentText = content.slice(currentNode.startIndex, currentNode.endIndex) + '\n' + commentText;
                    currentNode = currentNode.previousSibling;
                }
                
                const nodeContent = content.slice(node.startIndex, node.endIndex);
                const chunk: CodeChunk = {
                    content: commentText + nodeContent,
                    type: node.type,
                    startLine: startPosition.row + 1,
                    endLine: endPosition.row + 1
                };

                // Extract Java-specific metadata
                if (ext.toLowerCase() === '.java') {
                    this.extractJavaMetadata(chunk, node, content, tree);
                }

                chunks.push(chunk);

                markNodeProcessed(node);
                lastProcessedIndex = node.endIndex;
            }
        };

        const traverse = (node: any) => {
            visitNode(node);
            for (let child of node.children) {
                traverse(child);
            }
        };

        traverse(tree.rootNode);

        // Add any remaining unprocessed code at the end
        addUnprocessedCode(lastProcessedIndex, content.length);
        return chunks;
    }

    private static extractJavaMetadata(chunk: CodeChunk, node: any, content: string, tree: any): void {
        // Extract package name from the file
        const packageNode = this.findPackageDeclaration(tree.rootNode, content);
        if (packageNode) {
            chunk.packageName = packageNode;
        }

        // Extract class name if this node is within a class
        const className = this.findContainingClass(node, content);
        if (className) {
            chunk.className = className;
        }

        // Extract method name if this is a method
        if (node.type === 'method_declaration' || node.type === 'constructor_declaration') {
            const methodName = this.extractNodeName(node, content);
            if (methodName) {
                chunk.methodName = methodName;
            }
        }

        // Extract annotations
        const annotations = this.extractAnnotations(node, content);
        if (annotations.length > 0) {
            chunk.annotations = annotations;
            
            // Check if it's a Spring component
            const springAnnotations = [
                'Component', 'Service', 'Repository', 'Controller', 'RestController',
                'Configuration', 'Bean', 'Entity', 'SpringBootApplication'
            ];
            
            chunk.isSpringComponent = annotations.some(ann => 
                springAnnotations.some(spring => ann.includes(spring))
            );
        }
    }

    private static findPackageDeclaration(rootNode: any, content: string): string | undefined {
        for (const child of rootNode.children) {
            if (child.type === 'package_declaration') {
                const nameChild = child.childForFieldName('name');
                if (nameChild) {
                    return content.slice(nameChild.startIndex, nameChild.endIndex);
                }
            }
        }
        return undefined;
    }

    private static findContainingClass(node: any, content: string): string | undefined {
        let current = node.parent;
        while (current) {
            if (current.type === 'class_declaration') {
                const nameChild = current.childForFieldName('name');
                if (nameChild) {
                    return content.slice(nameChild.startIndex, nameChild.endIndex);
                }
            }
            current = current.parent;
        }
        return undefined;
    }

    private static extractNodeName(node: any, content: string): string | undefined {
        const nameChild = node.childForFieldName('name');
        if (nameChild) {
            return content.slice(nameChild.startIndex, nameChild.endIndex);
        }
        return undefined;
    }

    private static extractAnnotations(node: any, content: string): string[] {
        const annotations: string[] = [];
        
        // Check for annotations on this node
        const modifiers = node.childForFieldName('modifiers');
        if (modifiers) {
            for (const child of modifiers.children) {
                if (child.type === 'annotation' || child.type === 'marker_annotation') {
                    const annotationContent = content.slice(child.startIndex, child.endIndex);
                    annotations.push(annotationContent);
                }
            }
        }

        // For standalone annotation nodes
        if (node.type === 'annotation' || node.type === 'marker_annotation') {
            const annotationContent = content.slice(node.startIndex, node.endIndex);
            annotations.push(annotationContent);
        }

        return annotations;
    }

    private static fallbackChunking(content: string): CodeChunk[] {
        const lines = content.split('\n');
        const chunks: CodeChunk[] = [];
        let currentChunk = '';
        let startLine = 1;

        for (let i = 0; i < lines.length; i++) {
            currentChunk += lines[i] + '\n';
            if ((i + 1) % 50 === 0 || i === lines.length - 1) {
                chunks.push({
                    content: currentChunk.trim(),
                    type: 'fallback',
                    startLine: startLine,
                    endLine: i + 1
                });
                currentChunk = '';
                startLine = i + 2;
            }
        }

        return chunks;
    }
}