import { ASTManager } from './ASTManager';
import * as vscode from 'vscode';

export interface CodeContext {
    filenames: string[];
    functionNames: string[];
    classNames: string[];
    interfaceNames: string[];
    variableNames: string[];
    imports: string[];
    exports: string[];
    currentFileContext?: {
        filename: string;
        functions: string[];
        classes: string[];
        interfaces: string[];
    };
}

export class ContextGatherer {
    private astManager: ASTManager;

    constructor() {
        this.astManager = ASTManager.getInstance();
    }

    public gatherWorkspaceContext(): CodeContext {
        const allFiles = this.astManager.getAllFiles();
        const context: CodeContext = {
            filenames: [],
            functionNames: [],
            classNames: [],
            interfaceNames: [],
            variableNames: [],
            imports: [],
            exports: []
        };

        // Extract filenames
        context.filenames = allFiles.map(filepath => {
            const parts = filepath.split(/[/\\]/);
            return parts[parts.length - 1]; // Get just the filename
        });

        // Gather all function names
        const functionNodes = this.astManager.findNodesByType('function_declaration');
        const methodNodes = this.astManager.findNodesByType('method_definition');
        context.functionNames = [
            ...functionNodes.map(node => node.name).filter(name => name),
            ...methodNodes.map(node => node.name).filter(name => name)
        ] as string[];

        // Gather class names
        const classNodes = this.astManager.findNodesByType('class_declaration');
        context.classNames = classNodes.map(node => node.name).filter(name => name) as string[];

        // Gather interface names
        const interfaceNodes = this.astManager.findNodesByType('interface_declaration');
        context.interfaceNames = interfaceNodes.map(node => node.name).filter(name => name) as string[];

        // Gather variable names (limit to avoid too much noise)
        const variableNodes = this.astManager.findNodesByType('variable_declaration');
        const lexicalNodes = this.astManager.findNodesByType('lexical_declaration');
        context.variableNames = [
            ...variableNodes.map(node => node.name).filter(name => name),
            ...lexicalNodes.map(node => node.name).filter(name => name)
        ].slice(0, 50) as string[]; // Limit to first 50 to avoid overwhelming

        // Gather imports and exports from all files
        for (const filepath of allFiles) {
            const importsExports = this.astManager.getImportsAndExports(filepath);
            context.imports.push(...importsExports.imports);
            context.exports.push(...importsExports.exports);
        }

        // Remove duplicates
        context.functionNames = [...new Set(context.functionNames)];
        context.classNames = [...new Set(context.classNames)];
        context.interfaceNames = [...new Set(context.interfaceNames)];
        context.variableNames = [...new Set(context.variableNames)];
        context.imports = [...new Set(context.imports)];
        context.exports = [...new Set(context.exports)];

        return context;
    }

    public gatherCurrentFileContext(editor?: vscode.TextEditor): CodeContext['currentFileContext'] {
        if (!editor) {
            return undefined;
        }

        const filePath = editor.document.uri.fsPath;
        const fileAST = this.astManager.getFileAST(filePath);
        
        if (!fileAST) {
            return undefined;
        }

        const filename = filePath.split(/[/\\]/).pop() || '';
        
        // Get functions in current file
        const functions = this.astManager.findNodesByType('function_declaration', filePath)
            .concat(this.astManager.findNodesByType('method_definition', filePath))
            .map(node => node.name)
            .filter(name => name) as string[];

        // Get classes in current file
        const classes = this.astManager.findNodesByType('class_declaration', filePath)
            .map(node => node.name)
            .filter(name => name) as string[];

        // Get interfaces in current file
        const interfaces = this.astManager.findNodesByType('interface_declaration', filePath)
            .map(node => node.name)
            .filter(name => name) as string[];

        return {
            filename,
            functions: [...new Set(functions)],
            classes: [...new Set(classes)],
            interfaces: [...new Set(interfaces)]
        };
    }

    public findRelevantSymbols(query: string): string[] {
        const words = query.toLowerCase().split(/\s+/);
        const relevantSymbols: string[] = [];

        // Search for symbols that match words in the query
        for (const word of words) {
            // Find function names
            const functionNodes = this.astManager.findNodesByType('function_declaration');
            const methodNodes = this.astManager.findNodesByType('method_definition');
            
            for (const node of [...functionNodes, ...methodNodes]) {
                if (node.name && node.name.toLowerCase().includes(word)) {
                    relevantSymbols.push(node.name);
                }
            }

            // Find class names
            const classNodes = this.astManager.findNodesByType('class_declaration');
            for (const node of classNodes) {
                if (node.name && node.name.toLowerCase().includes(word)) {
                    relevantSymbols.push(node.name);
                }
            }

            // Find interface names
            const interfaceNodes = this.astManager.findNodesByType('interface_declaration');
            for (const node of interfaceNodes) {
                if (node.name && node.name.toLowerCase().includes(word)) {
                    relevantSymbols.push(node.name);
                }
            }
        }

        return [...new Set(relevantSymbols)];
    }
}