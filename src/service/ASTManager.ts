import * as vscode from 'vscode';
import * as path from 'path';
import Parser from 'tree-sitter';
import TreeSitterJavaScript from 'tree-sitter-javascript';
import TreeSitterTypeScript from 'tree-sitter-typescript';
import TreeSitterJava from 'tree-sitter-java';

export interface SpringAnnotation {
    name: string; // e.g., "Component", "RestController", "Service"
    attributes?: { [key: string]: string }; // Annotation attributes
    fullName: string; // Full annotation name with package
}

export interface RequestMapping {
    path: string;
    method: string; // GET, POST, PUT, DELETE, etc.
    consumes?: string[];
    produces?: string[];
    params?: string[];
}

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
    // Java-specific properties
    packageName?: string; // Java package declaration
    annotations?: string[]; // Java annotations (e.g., @Component, @RestController)
    modifiers?: string[]; // Access modifiers (public, private, static, etc.)
    extends?: string; // Superclass name
    implements?: string[]; // Implemented interfaces
    // Spring Boot specific
    isSpringComponent?: boolean; // Is this a Spring component/bean
    springAnnotations?: SpringAnnotation[]; // Spring-specific annotations
    requestMappings?: RequestMapping[]; // For REST controllers
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
            case '.java':
                parser.setLanguage(TreeSitterJava as unknown as Parser.Language);
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
        this.fileWatcher = vscode.workspace.createFileSystemWatcher("**/*.{ts,tsx,js,jsx,java}", false, false, false);
        
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

        const excludeDirs = [
            'node_modules', '.git', 'dist', 'build', 'out',
            'target', 'bin', '.gradle', '.mvn', 'gradle/wrapper'
        ];
        const pattern = "**/*.{ts,tsx,js,jsx,java}";
        
        const files = await vscode.workspace.findFiles(pattern, `{${excludeDirs.map(dir => `**/${dir}/**`).join(',')}}`);
        
        for (const file of files) {
            await this.updateFileAST(file);
        }
    }

    public async updateFileAST(fileUri: vscode.Uri): Promise<void> {
        const filePath = fileUri.fsPath;
        const ext = path.extname(filePath);
        
        // Skip unsupported file types
        if (!['.ts', '.tsx', '.js', '.jsx', '.java'].includes(ext.toLowerCase())) {
            return;
        }

        // Skip excluded directories
        const excludeDirs = [
            'node_modules', '.git', 'dist', 'build', 'out',
            'target', 'bin', '.gradle', '.mvn', 'gradle/wrapper'
        ];
        const normalizedPath = filePath.replace(/\\/g, '/');
        if (excludeDirs.some(dir => normalizedPath.includes(`/${dir}/`) || normalizedPath.includes(`\\${dir}\\`))) {
            return;
        }

        // Check if path is actually a file (not a directory)
        try {
            const fs = require('fs');
            const stat = await fs.promises.stat(filePath);
            if (stat.isDirectory()) {
                return;
            }
        } catch (error) {
            // If file doesn't exist or can't be accessed, skip it
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
            // TypeScript/JavaScript constructs
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
            
            // Java constructs
            case 'class_declaration':
            case 'interface_declaration':
            case 'enum_declaration':
            case 'annotation_type_declaration':
                const javaNameChild = node.childForFieldName('name');
                return javaNameChild ? content.slice(javaNameChild.startIndex, javaNameChild.endIndex) : undefined;
            
            case 'method_declaration':
            case 'constructor_declaration':
                const methodNameChild = node.childForFieldName('name');
                return methodNameChild ? content.slice(methodNameChild.startIndex, methodNameChild.endIndex) : undefined;
            
            case 'field_declaration':
                const fieldDeclarator = node.children.find(child => child.type === 'variable_declarator');
                if (fieldDeclarator) {
                    const fieldNameChild = fieldDeclarator.childForFieldName('name');
                    return fieldNameChild ? content.slice(fieldNameChild.startIndex, fieldNameChild.endIndex) : undefined;
                }
                break;
            
            case 'local_variable_declaration':
                const localDeclarator = node.children.find(child => child.type === 'variable_declarator');
                if (localDeclarator) {
                    const localNameChild = localDeclarator.childForFieldName('name');
                    return localNameChild ? content.slice(localNameChild.startIndex, localNameChild.endIndex) : undefined;
                }
                break;
            
            default:
                return undefined;
        }
    }

    private extractSemanticInfo(astNode: ASTNode, node: Parser.SyntaxNode, content: string): void {
        // Extract imports
        if (node.type === 'import_statement' || node.type === 'import_declaration') {
            const importClause = node.childForFieldName('import') || node;
            if (importClause) {
                astNode.imports = this.extractImportNames(importClause, content);
            }
        }

        // Extract exports
        if (node.type === 'export_statement') {
            astNode.exports = this.extractExportNames(node, content);
        }

        // Extract function calls and references
        if (node.type === 'call_expression' || node.type === 'method_invocation') {
            const functionName = node.childForFieldName('function') || node.childForFieldName('name');
            if (functionName) {
                const refName = content.slice(functionName.startIndex, functionName.endIndex);
                astNode.references?.push(refName);
            }
        }

        // Java-specific extractions
        if (astNode.filePath.endsWith('.java')) {
            this.extractJavaSemanticInfo(astNode, node, content);
        }
    }

    private extractJavaSemanticInfo(astNode: ASTNode, node: Parser.SyntaxNode, content: string): void {
        // Extract package declaration
        if (node.type === 'package_declaration') {
            const packageName = node.childForFieldName('name');
            if (packageName) {
                astNode.packageName = content.slice(packageName.startIndex, packageName.endIndex);
            }
        }

        // Extract annotations
        if (node.type === 'annotation' || node.type === 'marker_annotation') {
            const annotationName = node.childForFieldName('name');
            if (annotationName) {
                const name = content.slice(annotationName.startIndex, annotationName.endIndex);
                if (!astNode.annotations) {
                    astNode.annotations = [];
                }
                astNode.annotations.push(name);

                // Check for Spring annotations
                this.processSpringAnnotation(astNode, name, node, content);
            }
        }

        // Extract modifiers (public, private, static, etc.)
        if (node.type === 'modifiers') {
            if (!astNode.modifiers) {
                astNode.modifiers = [];
            }
            for (const child of node.children) {
                if (child.type !== 'annotation' && child.type !== 'marker_annotation') {
                    astNode.modifiers.push(content.slice(child.startIndex, child.endIndex));
                }
            }
        }

        // Extract class inheritance
        if (node.type === 'class_declaration') {
            const superclass = node.childForFieldName('superclass');
            if (superclass) {
                astNode.extends = content.slice(superclass.startIndex, superclass.endIndex);
            }

            const interfaces = node.childForFieldName('interfaces');
            if (interfaces) {
                if (!astNode.implements) {
                    astNode.implements = [];
                }
                for (const child of interfaces.children) {
                    if (child.type === 'type_identifier') {
                        astNode.implements.push(content.slice(child.startIndex, child.endIndex));
                    }
                }
            }
        }
    }

    private processSpringAnnotation(astNode: ASTNode, annotationName: string, node: Parser.SyntaxNode, content: string): void {
        const springAnnotations = [
            'Component', 'Service', 'Repository', 'Controller', 'RestController',
            'Configuration', 'Bean', 'Autowired', 'Value', 'RequestMapping',
            'GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping',
            'Entity', 'Table', 'Column', 'Id', 'GeneratedValue', 'Transactional'
        ];

        if (springAnnotations.includes(annotationName)) {
            astNode.isSpringComponent = true;
            
            if (!astNode.springAnnotations) {
                astNode.springAnnotations = [];
            }
            
            const springAnnotation: SpringAnnotation = {
                name: annotationName,
                fullName: `@${annotationName}`,
                attributes: {}
            };

            // Extract annotation attributes
            const argumentList = node.childForFieldName('arguments');
            if (argumentList) {
                for (const arg of argumentList.children) {
                    if (arg.type === 'element_value_pair') {
                        const key = arg.childForFieldName('key');
                        const value = arg.childForFieldName('value');
                        if (key && value) {
                            const keyStr = content.slice(key.startIndex, key.endIndex);
                            const valueStr = content.slice(value.startIndex, value.endIndex);
                            springAnnotation.attributes![keyStr] = valueStr;
                        }
                    }
                }
            }

            astNode.springAnnotations.push(springAnnotation);

            // Process request mapping annotations
            if (['RequestMapping', 'GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping'].includes(annotationName)) {
                this.processRequestMapping(astNode, annotationName, springAnnotation);
            }
        }
    }

    private processRequestMapping(astNode: ASTNode, annotationType: string, annotation: SpringAnnotation): void {
        if (!astNode.requestMappings) {
            astNode.requestMappings = [];
        }

        const mapping: RequestMapping = {
            path: annotation.attributes?.['value'] || annotation.attributes?.['path'] || '',
            method: this.getHttpMethodFromAnnotation(annotationType),
            consumes: annotation.attributes?.['consumes']?.split(',').map(s => s.trim()) || [],
            produces: annotation.attributes?.['produces']?.split(',').map(s => s.trim()) || [],
            params: annotation.attributes?.['params']?.split(',').map(s => s.trim()) || []
        };

        astNode.requestMappings.push(mapping);
    }

    private getHttpMethodFromAnnotation(annotationType: string): string {
        switch (annotationType) {
            case 'GetMapping': return 'GET';
            case 'PostMapping': return 'POST';
            case 'PutMapping': return 'PUT';
            case 'DeleteMapping': return 'DELETE';
            case 'PatchMapping': return 'PATCH';
            case 'RequestMapping': return 'GET'; // Default
            default: return 'GET';
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

    // Spring Boot specific methods
    public findSpringComponents(): ASTNode[] {
        const results: ASTNode[] = [];
        
        for (const fileAST of this.fileASTs.values()) {
            // Only check Java files
            if (!fileAST.filePath.endsWith('.java')) {
                continue;
            }
            
            for (const node of fileAST.allNodes.values()) {
                if (node.isSpringComponent) {
                    results.push(node);
                }
            }
        }
        
        return results;
    }

    public findControllers(): ASTNode[] {
        return this.findNodesBySpringAnnotation(['Controller', 'RestController']);
    }

    public findServices(): ASTNode[] {
        return this.findNodesBySpringAnnotation(['Service']);
    }

    public findRepositories(): ASTNode[] {
        return this.findNodesBySpringAnnotation(['Repository']);
    }

    public findEntities(): ASTNode[] {
        return this.findNodesBySpringAnnotation(['Entity']);
    }

    public findRequestMappings(): Array<{ node: ASTNode, mapping: RequestMapping }> {
        const results: Array<{ node: ASTNode, mapping: RequestMapping }> = [];
        
        for (const fileAST of this.fileASTs.values()) {
            if (!fileAST.filePath.endsWith('.java')) {
                continue;
            }
            
            for (const node of fileAST.allNodes.values()) {
                if (node.requestMappings && node.requestMappings.length > 0) {
                    for (const mapping of node.requestMappings) {
                        results.push({ node, mapping });
                    }
                }
            }
        }
        
        return results;
    }

    private findNodesBySpringAnnotation(annotationNames: string[]): ASTNode[] {
        const results: ASTNode[] = [];
        
        for (const fileAST of this.fileASTs.values()) {
            if (!fileAST.filePath.endsWith('.java')) {
                continue;
            }
            
            for (const node of fileAST.allNodes.values()) {
                if (node.springAnnotations) {
                    for (const annotation of node.springAnnotations) {
                        if (annotationNames.includes(annotation.name)) {
                            results.push(node);
                            break;
                        }
                    }
                }
            }
        }
        
        return results;
    }

    public getSpringBootConfiguration(): {
        components: number;
        controllers: number;
        services: number;
        repositories: number;
        entities: number;
        endpoints: number;
    } {
        const components = this.findSpringComponents().length;
        const controllers = this.findControllers().length;
        const services = this.findServices().length;
        const repositories = this.findRepositories().length;
        const entities = this.findEntities().length;
        const endpoints = this.findRequestMappings().length;

        return {
            components,
            controllers,
            services,
            repositories,
            entities,
            endpoints
        };
    }

    public findSpringBootMainClass(): ASTNode | undefined {
        for (const fileAST of this.fileASTs.values()) {
            if (!fileAST.filePath.endsWith('.java')) {
                continue;
            }
            
            for (const node of fileAST.allNodes.values()) {
                if (node.springAnnotations) {
                    for (const annotation of node.springAnnotations) {
                        if (annotation.name === 'SpringBootApplication') {
                            return node;
                        }
                    }
                }
            }
        }
        
        return undefined;
    }

    public analyzeSpringBootProject(): {
        mainClass?: ASTNode;
        configuration: ReturnType<ASTManager['getSpringBootConfiguration']>;
        packageStructure: { [packageName: string]: number };
        dependencies: string[];
    } {
        const mainClass = this.findSpringBootMainClass();
        const configuration = this.getSpringBootConfiguration();
        const packageStructure: { [packageName: string]: number } = {};
        const dependencies = new Set<string>();

        for (const fileAST of this.fileASTs.values()) {
            if (!fileAST.filePath.endsWith('.java')) {
                continue;
            }
            
            for (const node of fileAST.allNodes.values()) {
                // Count classes per package
                if (node.packageName && node.type === 'class_declaration') {
                    packageStructure[node.packageName] = (packageStructure[node.packageName] || 0) + 1;
                }
                
                // Collect Spring dependencies
                if (node.imports) {
                    for (const imp of node.imports) {
                        if (imp.startsWith('org.springframework') || imp.startsWith('jakarta.') || imp.startsWith('javax.')) {
                            dependencies.add(imp);
                        }
                    }
                }
            }
        }

        return {
            mainClass,
            configuration,
            packageStructure,
            dependencies: Array.from(dependencies)
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