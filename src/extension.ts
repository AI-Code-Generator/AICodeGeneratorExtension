import * as vscode from 'vscode';
import { ChatViewProvider } from './ChatViewProvider';
//import { AICompletionProvider } from './CompletionProvider';
import { config } from './config';
import { indexWorkspaceFiles, indexSingleFile, deleteSingleFile } from './service/FileIndexer';
import { ASTManager } from './service/ASTManager';
import { DiffManager } from './service/DiffManager';
import { DiffCodeLensProvider } from './service/DiffCodeLensProvider';
import { AuthManager } from './service/AuthService'; // Import AuthManager

export function activate(context: vscode.ExtensionContext) {
    // Initialize AuthManager
    const authManager = AuthManager.getInstance(context);

    // Pass AuthManager to ChatViewProvider
    const chatViewProvider = new ChatViewProvider(context.extensionUri, config.serverUrl, context, authManager);
    
    let output = vscode.window.createOutputChannel("AI code assist");

    // Initialize Diff Manager
    const diffManager = DiffManager.getInstance();
    
    // Initialize CodeLens Provider for diffs
    const diffCodeLensProvider = new DiffCodeLensProvider();

    // Initialize AST Manager
    const astManager = ASTManager.getInstance();
    astManager.initializeWorkspace(context).then(() => {
        output.appendLine('AST Manager initialized successfully');
    }).catch(err => {
        output.appendLine(`Error initializing AST Manager: ${err}`);
    });

    // Index workspace files when extension activates, passing the context
    indexWorkspaceFiles(context.globalStorageUri, context).then(files => {
        output.appendLine(`Indexed ${files.length} files in workspace`);
    }).catch(err => {
        output.appendLine('Error indexing workspace:');
    });

    // Set up file system watcher
    const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*", false, false, false);
    
    // Handle file changes
    fileWatcher.onDidChange(async (uri) => {
        try {
            await indexSingleFile(uri, context.globalStorageUri, context);
            output.appendLine(`Reindexed changed file: ${uri.fsPath}`);
        } catch (err) {
            output.appendLine(`Error reindexing file ${uri.fsPath}: ${err}`);
        }
    });
    
    // Handle file creation
    fileWatcher.onDidCreate(async (uri) => {
        try {
            await indexSingleFile(uri, context.globalStorageUri, context);
            output.appendLine(`Indexed new file: ${uri.fsPath}`);
        } catch (err) {
            output.appendLine(`Error indexing new file ${uri.fsPath}: ${err}`);
        }
    });
    
    // Handle file deletion
    fileWatcher.onDidDelete(async (uri) => {
        try {
            await deleteSingleFile(uri, context.globalStorageUri);
            output.appendLine(`Deleted index for file: ${uri.fsPath}`);
        } catch (err) {
            output.appendLine(`Error deleting index for file ${uri.fsPath}: ${err}`);
        }
    });

    context.subscriptions.push(fileWatcher);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'aiCodeAssist.chatView',
            chatViewProvider,
            {
                webviewOptions: { retainContextWhenHidden: true }
            }
        )
    );

    // Register CodeLens provider for all languages
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { scheme: 'file' },
            diffCodeLensProvider
        )
    );

    // Register commands for accepting/rejecting changes
    context.subscriptions.push(
        vscode.commands.registerCommand('aiCodeAssist.acceptChange', (changeId: string) => {
            diffManager.acceptChange(changeId);
            diffCodeLensProvider.refresh();
            diffManager.forceRefreshDecorations();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('aiCodeAssist.rejectChange', (changeId: string) => {
            diffManager.rejectChange(changeId);
            diffCodeLensProvider.refresh();
            diffManager.forceRefreshDecorations();
        })
    );

    // Register commands for bulk accept/reject all changes
    context.subscriptions.push(
        vscode.commands.registerCommand('aiCodeAssist.acceptAllChanges', () => {
            diffManager.acceptAllChanges();
            diffCodeLensProvider.refresh();
            diffManager.forceRefreshDecorations();
            vscode.window.showInformationMessage('Accepted all AI-generated changes');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('aiCodeAssist.rejectAllChanges', async () => {
            await diffManager.rejectAllChanges();
            diffCodeLensProvider.refresh();
            diffManager.forceRefreshDecorations();
            vscode.window.showInformationMessage('Rejected all AI-generated changes');
        })
    );

	// const completionProvider = new AICompletionProvider(config.serverUrl);
    // context.subscriptions.push(
    //     vscode.languages.registerInlineCompletionItemProvider(
    //         { pattern: '**' }, // Register for all file types
    //         completionProvider
    //     )
    // );

	let toggleSuggestions = vscode.commands.registerCommand('ai-code-assist.toggleSuggestions', () => {
        const config = vscode.workspace.getConfiguration('editor');
        const current = config.get('inlineSuggest.enabled');
        config.update('inlineSuggest.enabled', !current, true);
    });

    // Register command to open chat
    let disposable = vscode.commands.registerCommand('ai-code-assist.openChat', () => {
		vscode.commands.executeCommand('aiCodeAssist.chatView.focus');
    });

    // Register logout command
    let logoutDisposable = vscode.commands.registerCommand('aiCodeAssist.logout', async () => {
        await authManager.clearToken();
        chatViewProvider.logout(); // Notify the webview
        vscode.window.showInformationMessage('You have been logged out.');
    });
	
	context.subscriptions.push(toggleSuggestions);
    context.subscriptions.push(disposable);
    context.subscriptions.push(logoutDisposable); // Add logout command
}

export function deactivate() {
    // Clean up diff manager
    const diffManager = DiffManager.getInstance();
    diffManager.dispose();
}