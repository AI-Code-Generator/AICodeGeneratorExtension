import Parser from 'tree-sitter';
import TreeSitterJavaScript from 'tree-sitter-javascript';
import TreeSitterTypeScript from 'tree-sitter-typescript';
// import TreeSitterPython from 'tree-sitter-python';
import * as path from 'path';

export interface CodeChunk {
    content: string;
    type: string;
    startLine: number;
    endLine: number;
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
            'function_declaration',
            'method_definition',
            'class_declaration',
            'interface_declaration',
            'export_statement',
            'import_statement',
            'variable_declaration',
            'const_declaration',
        ];

        const addUnprocessedCode = (startIndex: number, endIndex: number) => {
            if (startIndex < endIndex) {
                const code = content.slice(startIndex, endIndex).trim();
                if (code) {
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

                // Get associated comments
                let commentText = '';
                let currentNode = node.previousSibling;
                while (currentNode && currentNode.type.includes('comment')) {
                    commentText = content.slice(currentNode.startIndex, currentNode.endIndex) + '\n' + commentText;
                    currentNode = currentNode.previousSibling;
                }
                
                const nodeContent = content.slice(node.startIndex, node.endIndex);
                chunks.push({
                    content: commentText + nodeContent,
                    type: node.type,
                    startLine: startPosition.row + 1,
                    endLine: endPosition.row + 1
                });

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

    private static fallbackChunking(content: string): CodeChunk[] {
        const lines = content.split('\n');
        const chunks: CodeChunk[] = [];
        let currentChunk = '';
        let startLine = 1;

        for (let i = 0; i < lines.length; i++) {
            currentChunk += lines[i] + '\n';
            if ((i + 1) % 3 === 0 || i === lines.length - 1) {
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