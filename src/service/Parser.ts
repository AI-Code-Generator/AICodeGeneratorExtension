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
    // Conservative char cap to keep inputs within typical embedder limits (~8k tokens)
    private static readonly MAX_CHARS_PER_CHUNK = 4000;

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

            // Group consecutive Java imports into one chunk
            if (ext.toLowerCase() === '.java' && node.type === 'import_declaration') {
                // Identify a run of consecutive import_declaration siblings
                let runStart = node;
                let runEnd = node;

                // Expand forward to include following consecutive import declarations
                let cursor = node.nextSibling;
                while (cursor && cursor.type === 'import_declaration') {
                    runEnd = cursor;
                    cursor = cursor.nextSibling;
                }

                // Add unprocessed code before the first import in the run
                addUnprocessedCode(lastProcessedIndex, runStart.startIndex);

                // Build the combined import block chunk
                const blockStart = runStart.startIndex;
                const blockEnd = runEnd.endIndex;
                const slice = content.slice(blockStart, blockEnd);
                const startPos = tree.rootNode.text.slice(0, blockStart).split('\n').length;
                const endPos = startPos + slice.split('\n').length - 1;

                chunks.push({
                    content: slice.trim(),
                    type: 'import_block',
                    startLine: startPos,
                    endLine: endPos
                });

                // Mark all imports in the run as processed
                let mark = runStart;
                while (true) {
                    markNodeProcessed(mark);
                    if (mark === runEnd) {
                        break;
                    }
                    mark = mark.nextSibling;
                }

                // Update last processed index
                lastProcessedIndex = blockEnd;
                return;
            }

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
    // Enforce max char size per chunk
    return this.applyCharLimit(chunks);
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
        if (!content) { return []; }

        // Pre-compute all newline positions in one pass
        const newlinePositions: number[] = [];
        for (let i = 0; i < content.length; i++) {
            if (content.charCodeAt(i) === 10) { // '\n'
                newlinePositions.push(i);
            }
        }

        const totalLines = newlinePositions.length + 1;
        const linesPerChunk = totalLines > 1000 ? Math.ceil(totalLines / 20) : 50;
        
        const chunks: CodeChunk[] = [];
        let currentLine = 1;
        let chunkStartPos = 0;

        // Now we can jump directly between newlines!
        for (let i = 0; i < newlinePositions.length; i += linesPerChunk) {
            const endLineIndex = Math.min(i + linesPerChunk - 1, newlinePositions.length - 1);
            const chunkEndPos = i + linesPerChunk - 1 < newlinePositions.length 
                ? newlinePositions[endLineIndex] + 1  // Include the newline
                : content.length;                     // Last chunk goes to end

            const chunkContent = content.slice(chunkStartPos, chunkEndPos).trim();
            
            if (chunkContent) {
                const linesInChunk = endLineIndex - i + 1;
                chunks.push({
                    content: chunkContent,
                    type: 'fallback',
                    startLine: currentLine,
                    endLine: currentLine + linesInChunk - 1
                });
                
                currentLine += linesInChunk;
            }

            chunkStartPos = chunkEndPos;
        }

        // Handle final chunk if content doesn't end with newline
        if (chunkStartPos < content.length) {
            const chunkContent = content.slice(chunkStartPos).trim();
            if (chunkContent) {
                chunks.push({
                    content: chunkContent,
                    type: 'fallback',
                    startLine: currentLine,
                    endLine: currentLine
                });
            }
        }

        // Enforce max char size per chunk
        return this.applyCharLimit(chunks);
    }

    // Split oversized chunks on newline boundaries (and mid-line if needed),
    // preserving start/end lines and metadata.
    private static applyCharLimit(chunks: CodeChunk[]): CodeChunk[] {
        const result: CodeChunk[] = [];
        for (const chunk of chunks) {
            if (!chunk.content || chunk.content.length <= this.MAX_CHARS_PER_CHUNK) {
                result.push(chunk);
                continue;
            }

            const lines = chunk.content.split('\n');
            let startLineAbs = chunk.startLine;
            let i = 0;
            while (i < lines.length) {
                let accChars = 0;
                const startIdx = i;
                const pieceLines: string[] = [];

                while (i < lines.length) {
                    const line = lines[i];
                    const extra = pieceLines.length > 0 ? 1 : 0; // account for newline between joined lines
                    if (accChars + extra + line.length <= this.MAX_CHARS_PER_CHUNK) {
                        accChars += extra + line.length;
                        pieceLines.push(line);
                        i++;
                    } else {
                        // If a single line is longer than the cap, split the line itself
                        if (pieceLines.length === 0 && line.length > this.MAX_CHARS_PER_CHUNK) {
                            const segment = line.slice(0, this.MAX_CHARS_PER_CHUNK);
                            // push this segment as its own chunk with same start/end line
                            result.push({
                                content: segment,
                                type: chunk.type,
                                startLine: startLineAbs,
                                endLine: startLineAbs,
                                packageName: chunk.packageName,
                                className: chunk.className,
                                methodName: chunk.methodName,
                                annotations: chunk.annotations,
                                isSpringComponent: chunk.isSpringComponent
                            });
                            // mutate current line to remaining content and continue
                            lines[i] = line.slice(this.MAX_CHARS_PER_CHUNK);
                        } else {
                            break;
                        }
                    }
                }

                if (pieceLines.length > 0) {
                    const piece = pieceLines.join('\n');
                    const pieceStart = startLineAbs;
                    const pieceEnd = pieceStart + (i - startIdx) - 1;
                    result.push({
                        content: piece,
                        type: chunk.type,
                        startLine: pieceStart,
                        endLine: Math.max(pieceStart, pieceEnd),
                        packageName: chunk.packageName,
                        className: chunk.className,
                        methodName: chunk.methodName,
                        annotations: chunk.annotations,
                        isSpringComponent: chunk.isSpringComponent
                    });
                    startLineAbs = pieceEnd + 1;
                }
            }
        }
        return result;
    }
}