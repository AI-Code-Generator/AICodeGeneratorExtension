import * as vscode from 'vscode';
import * as path from 'path';
import Parser from 'tree-sitter';
import TreeSitterJavaScript from 'tree-sitter-javascript';
import TreeSitterTypeScript from 'tree-sitter-typescript';

export interface ASTNode {
    id: string;
    type: string;
    name?: string;
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
    filePath: string;
    content: string;
    children: string[]; // IDs of child nodes
    parent?: string; // ID of parent node
    exports?: string[]; // What this node exports
    imports?: string[]; // What this node imports
    references?: string[]; // Other nodes this references
}

export interface FileAST {
    filePath: string;
    lastModified: number;
    contentHash: string;
    rootNodes: string[]; // IDs of top-level nodes
    allNodes: Map<string, ASTNode>;
    symbols: Map<string, string[]>; // symbol name -> node IDs
}

export class ASTManager {
    private static instance: ASTManager;
    private fileASTs: Map<string, FileAST> = new Map();
    private parsers: Map<string, Parser> = new Map();
    private globalSymbols: Map<string, Set<string>> = new Map(); // symbol -> file paths
    private fileWatcher: vscode.FileSystemWatcher | null = null;

    private constructor() {}

    public static getInstance(): ASTManager {
        if (!ASTManager.instance) {
            ASTManager.instance = new ASTManager();
        }
        return ASTManager.instance;
    }

    private getParser(fileExtension: string): Parser | null {
        if (!this.parsers.has(fileExtension)) {
            const parser = this.initializeParser(fileExtension);
            if (parser) {
                this.parsers.set(fileExtension, parser);
            }
            return parser;
        }
        return this.parsers.get(fileExtension) || null;
    }

    private initializeParser(fileExtension: string): Parser | null {
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
            default:
                return null;
        }
    }

    private calculateContentHash(content: string): string {
        const crypto = require('crypto');
        return crypto.createHash('md5').update(content).digest('hex');
    }

    public async initializeWorkspace(context: vscode.ExtensionContext): Promise<void> {
        // Set up file watcher
        this.fileWatcher = vscode.workspace.createFileSystemWatcher("**/*.{ts,tsx,js,jsx}", false, false, false);
        
        this.fileWatcher.onDidChange(async (uri) => {
            await this.updateFileAST(uri);
        });
        
        this.fileWatcher.onDidCreate(async (uri) => {
            await this.updateFileAST(uri);
        });
        
        this.fileWatcher.onDidDelete((uri) => {
            this.removeFileAST(uri.fsPath);
        });

        context.subscriptions.push(this.fileWatcher);

        // Index all workspace files
        await this.indexWorkspaceFiles();
    }

    private async indexWorkspaceFiles(): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return;
        }

        const excludeDirs = ['node_modules', '.git', 'dist', 'build', 'out'];
        const pattern = "**/*.{ts,tsx,js,jsx}";
        
        const files = await vscode.workspace.findFiles(pattern, `{${excludeDirs.map(dir => `**/${dir}/**`).join(',')}}`);
        
        for (const file of files) {
            await this.updateFileAST(file);
        }
    }

    public async updateFileAST(fileUri: vscode.Uri): Promise<void> {
        const filePath = fileUri.fsPath;
        const ext = path.extname(filePath);
        
        // Skip unsupported file types
        if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext.toLowerCase())) {
            return;
        }

        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            const content = document.getText();
            const contentHash = this.calculateContentHash(content);
            const lastModified = Date.now();

            // Check if file needs updating
            const existingAST = this.fileASTs.get(filePath);
            if (existingAST && existingAST.contentHash === contentHash) {
                return; // File hasn't changed
            }

            // Remove old symbols from global index
            if (existingAST) {
                this.removeFileFromGlobalSymbols(filePath);
            }

            // Parse the file
            const parser = this.getParser(ext);
            if (!parser) {
                return;
            }

            const tree = parser.parse(content);
            const fileAST = this.buildFileAST(filePath, content, tree, contentHash, lastModified);
            
            // Store the AST
            this.fileASTs.set(filePath, fileAST);
            
            // Update global symbols
            this.addFileToGlobalSymbols(filePath, fileAST);

        } catch (error) {
            console.error(`Error updating AST for ${filePath}:`, error);
        }
    }

    private buildFileAST(filePath: string, content: string, tree: Parser.Tree, contentHash: string, lastModified: number): FileAST {
        const allNodes = new Map<string, ASTNode>();
        const symbols = new Map<string, string[]>();
        const rootNodes: string[] = [];

        const buildNode = (node: Parser.SyntaxNode, parent?: string): string => {
            const nodeId = `${filePath}:${node.startIndex}-${node.endIndex}`;
            const startPos = node.startPosition;
            const endPos = node.endPosition;

            const astNode: ASTNode = {
                id: nodeId,
                type: node.type,
                startLine: startPos.row + 1,
                endLine: endPos.row + 1,
                startColumn: startPos.column,
                endColumn: endPos.column,
                filePath,
                content: content.slice(node.startIndex, node.endIndex),
                children: [],
                parent,
                exports: [],
                imports: [],
                references: []
            };

            // Extract name for named nodes
            astNode.name = this.extractNodeName(node, content);

            // Process children
            for (const child of node.children) {
                const childId = buildNode(child, nodeId);
                astNode.children.push(childId);
            }

            // Extract semantic information
            this.extractSemanticInfo(astNode, node, content);

            // Store in maps
            allNodes.set(nodeId, astNode);
            
            // Add to symbols index
            if (astNode.name) {
                if (!symbols.has(astNode.name)) {
                    symbols.set(astNode.name, []);
                }
                symbols.get(astNode.name)!.push(nodeId);
            }

            return nodeId;
        };

        // Build AST starting from root
        for (const child of tree.rootNode.children) {
            const nodeId = buildNode(child);
            rootNodes.push(nodeId);
        }

        return {
            filePath,
            lastModified,
            contentHash,
            rootNodes,
            allNodes,
            symbols
        };
    }

    private extractNodeName(node: Parser.SyntaxNode, content: string): string | undefined {
        // Extract names based on node type
        switch (node.type) {
            case 'function_declaration':
            case 'class_declaration':
            case 'interface_declaration':
            case 'type_alias_declaration':
                const nameChild = node.childForFieldName('name');
                return nameChild ? content.slice(nameChild.startIndex, nameChild.endIndex) : undefined;
            
            case 'variable_declaration':
            case 'lexical_declaration':
                // Handle variable declarations (const, let, var)
                const declarator = node.children.find(child => child.type === 'variable_declarator');
                if (declarator) {
                    const idChild = declarator.childForFieldName('name');
                    return idChild ? content.slice(idChild.startIndex, idChild.endIndex) : undefined;
                }
                break;
            
            case 'method_definition':
            case 'property_definition':
                const keyChild = node.childForFieldName('name');
                return keyChild ? content.slice(keyChild.startIndex, keyChild.endIndex) : undefined;
            
            default:
                return undefined;
        }
    }

    private extractSemanticInfo(astNode: ASTNode, node: Parser.SyntaxNode, content: string): void {
        // Extract imports
        if (node.type === 'import_statement') {
            const importClause = node.childForFieldName('import');
            if (importClause) {
                astNode.imports = this.extractImportNames(importClause, content);
            }
        }

        // Extract exports
        if (node.type === 'export_statement') {
            astNode.exports = this.extractExportNames(node, content);
        }

        // Extract function calls and references
        if (node.type === 'call_expression') {
            const functionName = node.childForFieldName('function');
            if (functionName) {
                const refName = content.slice(functionName.startIndex, functionName.endIndex);
                astNode.references?.push(refName);
            }
        }
    }

    private extractImportNames(importClause: Parser.SyntaxNode, content: string): string[] {
        const imports: string[] = [];
        
        const traverse = (node: Parser.SyntaxNode) => {
            if (node.type === 'identifier') {
                imports.push(content.slice(node.startIndex, node.endIndex));
            }
            for (const child of node.children) {
                traverse(child);
            }
        };

        traverse(importClause);
        return imports;
    }

    private extractExportNames(exportNode: Parser.SyntaxNode, content: string): string[] {
        const exports: string[] = [];
        
        // Handle different export patterns
        const declaration = exportNode.childForFieldName('declaration');
        if (declaration && declaration.childForFieldName('name')) {
            const nameNode = declaration.childForFieldName('name');
            if (nameNode) {
                exports.push(content.slice(nameNode.startIndex, nameNode.endIndex));
            }
        }

        return exports;
    }

    private addFileToGlobalSymbols(filePath: string, fileAST: FileAST): void {
        for (const [symbolName] of fileAST.symbols) {
            if (!this.globalSymbols.has(symbolName)) {
                this.globalSymbols.set(symbolName, new Set());
            }
            this.globalSymbols.get(symbolName)!.add(filePath);
        }
    }

    private removeFileFromGlobalSymbols(filePath: string): void {
        for (const [symbolName, filePaths] of this.globalSymbols) {
            filePaths.delete(filePath);
            if (filePaths.size === 0) {
                this.globalSymbols.delete(symbolName);
            }
        }
    }

    public removeFileAST(filePath: string): void {
        this.removeFileFromGlobalSymbols(filePath);
        this.fileASTs.delete(filePath);
    }

    // Query methods
    public findSymbol(symbolName: string): ASTNode[] {
        const results: ASTNode[] = [];
        const filePaths = this.globalSymbols.get(symbolName);
        
        if (filePaths) {
            for (const filePath of filePaths) {
                const fileAST = this.fileASTs.get(filePath);
                if (fileAST) {
                    const nodeIds = fileAST.symbols.get(symbolName);
                    if (nodeIds) {
                        for (const nodeId of nodeIds) {
                            const node = fileAST.allNodes.get(nodeId);
                            if (node) {
                                results.push(node);
                            }
                        }
                    }
                }
            }
        }
        
        return results;
    }

    public getFileAST(filePath: string): FileAST | undefined {
        return this.fileASTs.get(filePath);
    }

    public getAllFiles(): string[] {
        return Array.from(this.fileASTs.keys());
    }

    public getNodeById(nodeId: string): ASTNode | undefined {
        for (const fileAST of this.fileASTs.values()) {
            const node = fileAST.allNodes.get(nodeId);
            if (node) {
                return node;
            }
        }
        return undefined;
    }

    public findNodesByType(type: string, filePath?: string): ASTNode[] {
        const results: ASTNode[] = [];
        
        const searchInFile = (fileAST: FileAST) => {
            for (const node of fileAST.allNodes.values()) {
                if (node.type === type) {
                    results.push(node);
                }
            }
        };

        if (filePath) {
            const fileAST = this.fileASTs.get(filePath);
            if (fileAST) {
                searchInFile(fileAST);
            }
        } else {
            for (const fileAST of this.fileASTs.values()) {
                searchInFile(fileAST);
            }
        }

        return results;
    }

    public findReferences(symbolName: string): ASTNode[] {
        const results: ASTNode[] = [];
        
        for (const fileAST of this.fileASTs.values()) {
            for (const node of fileAST.allNodes.values()) {
                if (node.references?.includes(symbolName)) {
                    results.push(node);
                }
            }
        }
        
        return results;
    }

    public getImportsAndExports(filePath: string): { imports: string[], exports: string[] } {
        const fileAST = this.fileASTs.get(filePath);
        if (!fileAST) {
            return { imports: [], exports: [] };
        }

        const imports: string[] = [];
        const exports: string[] = [];

        for (const node of fileAST.allNodes.values()) {
            if (node.imports) {
                imports.push(...node.imports);
            }
            if (node.exports) {
                exports.push(...node.exports);
            }
        }

        return { 
            imports: [...new Set(imports)], 
            exports: [...new Set(exports)] 
        };
    }

    public dispose(): void {
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
        }
        this.fileASTs.clear();
        this.globalSymbols.clear();
        this.parsers.clear();
    }
}