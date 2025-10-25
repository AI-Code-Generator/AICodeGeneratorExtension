// src/extension.ts
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
// import { ChatViewProvider } from './ChatViewProvider'; // Not needed for SWE-bench
// import { AICompletionProvider } from './CompletionProvider'; // Not needed for SWE-bench
import { config } from './config';
import { indexWorkspaceFiles, indexSingleFile, deleteSingleFile } from './service/FileIndexer'; // Updated imports
import { ASTManager } from './service/ASTManager';
import { DiffManager } from './service/DiffManager';
import { DiffCodeLensProvider } from './service/DiffCodeLensProvider';
import { SWEBenchAgent } from './service/SWEBenchAgent';
import { AuthManager } from './service/AuthService'; // Import AuthManager
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

export function activate(context: vscode.ExtensionContext) {
    // const chatViewProvider = new ChatViewProvider(context.extensionUri, config.serverUrl, context); // Not needed
    
    let output = vscode.window.createOutputChannel("AI code assist");

    // Initialize AuthManager
    const authManager = AuthManager.getInstance(context);

    // Initialize SWE-bench file-based communication
    initializeSWEBenchCommunication(context, authManager, output); // Pass authManager

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

    // Index workspace files when extension activates
    indexWorkspaceFiles(context.globalStorageUri, context).then(files => { // Pass context
        output.appendLine(`Indexed ${files.length} files in workspace`);
    }).catch(err => {
        output.appendLine(`Error indexing workspace: ${err.message}`);
    });

    // Set up file system watcher
    const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*", false, false, false);
    
    // Handle file changes
    fileWatcher.onDidChange(async (uri) => {
        try {
            await indexSingleFile(uri, context.globalStorageUri, context); // Pass context
            output.appendLine(`Reindexed changed file: ${uri.fsPath}`);
        } catch (err: any) {
            output.appendLine(`Error reindexing file ${uri.fsPath}: ${err.message}`);
        }
    });
    
    // Handle file creation
    fileWatcher.onDidCreate(async (uri) => {
        try {
            await indexSingleFile(uri, context.globalStorageUri, context); // Pass context
            output.appendLine(`Indexed new file: ${uri.fsPath}`);
        } catch (err: any) {
            output.appendLine(`Error indexing new file ${uri.fsPath}: ${err.message}`);
        }
    });
    
    // Handle file deletion
    fileWatcher.onDidDelete(async (uri) => {
        try {
            await deleteSingleFile(uri, context.globalStorageUri); // Use deleteSingleFile
            output.appendLine(`Deleted index for file: ${uri.fsPath}`);
        } catch (err: any) {
             output.appendLine(`Error deleting index for file ${uri.fsPath}: ${err.message}`);
        }
    });

    context.subscriptions.push(fileWatcher);

    /*
    // Chat view is not registered in SWE-bench mode
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'aiCodeAssist.chatView',
            chatViewProvider
        )
    );
    */

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
        vscode.commands.registerCommand('aiCodeAssist.rejectChange', async (changeId: string) => { // Make async
            await diffManager.rejectChange(changeId); // Await
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

	// const completionProvider = new AICompletionProvider(config.serverUrl); // Not needed
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
	
	context.subscriptions.push(toggleSuggestions);
    context.subscriptions.push(disposable);
}

// Define the paths for communication files in a shared location
const IPC_DIR = path.join(require('os').homedir(), '.my-agent-ipc');
const TASK_FILE_PATH = path.join(IPC_DIR, 'ipc-task.json');
const RESULT_FILE_PATH = path.join(IPC_DIR, 'ipc-result.json');

async function initializeSWEBenchCommunication(context: vscode.ExtensionContext, authManager: AuthManager, output: vscode.OutputChannel) {
    output.appendLine('[SWE-bench] Initializing file-based communication system');
    
    try {
        // Ensure the IPC directory exists
        await fs.mkdir(IPC_DIR, { recursive: true });
        
        // Create a file system watcher for the task file
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(IPC_DIR), 'ipc-task.json'),
            false, // Don't ignore creates
            false, // Don't ignore changes  
            true   // Ignore deletes
        );

        const processTask = async (uri: vscode.Uri) => {
            output.appendLine(`[SWE-bench] Detected event in ${uri.fsPath}`);
            await processSWEBenchTask(context, authManager, output);
        };

        watcher.onDidChange(processTask);
        watcher.onDidCreate(processTask);

        context.subscriptions.push(watcher);
        output.appendLine(`[SWE-bench] Watching for tasks in: ${TASK_FILE_PATH}`);
        
        // Process any existing task on activation
        await processSWEBenchTask(context, authManager, output);

    } catch (error) {
        output.appendLine(`[SWE-bench] Error initializing communication: ${error}`);
    }
}

async function processSWEBenchTask(context: vscode.ExtensionContext, authManager: AuthManager, output: vscode.OutputChannel) {
    try {
        const taskContent = await fs.readFile(TASK_FILE_PATH, 'utf-8');
        
        // Skip empty files or files that are being written
        if (!taskContent.trim() || taskContent.trim() === '{}') {
            return;
        }

        const { instance_id, problem_statement, repo_path } = JSON.parse(taskContent);

        // Check if task is valid
        if (!instance_id || !problem_statement || !repo_path) {
            output.appendLine(`[SWE-bench] Invalid task file content. Clearing.`);
            await fs.writeFile(TASK_FILE_PATH, '{}', 'utf-8');
            return;
        }

        // Acknowledge the task by clearing the file
        await fs.writeFile(TASK_FILE_PATH, '{}', 'utf-8');

        output.appendLine(`[SWE-bench] Received task: ${instance_id}`);
        output.appendLine(`[SWE-bench] Processing problem statement for ${instance_id}`);

        // Create and run the SWE-bench agent
        const sweBenchAgent = new SWEBenchAgent(context, authManager); // Pass context and authManager
        const generated_patch = await sweBenchAgent.generatePatch(problem_statement, repo_path, output);

        // Write the result to the output file
        const result = {
            instance_id: instance_id,
            patch: generated_patch
        };
        
        await fs.writeFile(RESULT_FILE_PATH, JSON.stringify(result, null, 2), 'utf-8');
        output.appendLine(`[SWE-bench] Finished task: ${instance_id}`);
        output.appendLine(`[SWE-bench] Generated patch length: ${generated_patch.length} characters`);

    } catch (error) {
        if (error instanceof SyntaxError) {
            // Ignore empty or invalid JSON, as it might be in the process of being written
            return;
        }
        output.appendLine(`[SWE-bench] Error processing task: ${error}`);
        
        // Write an error to the result file
        try {
            const taskContent = await fs.readFile(TASK_FILE_PATH, 'utf-8').catch(() => "{}");
            const instance_id = JSON.parse(taskContent)?.instance_id || 'unknown';

            await fs.writeFile(RESULT_FILE_PATH, JSON.stringify({ 
                error: String(error),
                instance_id: instance_id
            }), 'utf-8');
        } catch (writeError) {
            output.appendLine(`[SWE-bench] Error writing error result: ${writeError}`);
        }
    }
}

export function deactivate() {
    // Clean up diff manager
    const diffManager = DiffManager.getInstance();
    diffManager.dispose();

    // Clean up AST manager
    const astManager = ASTManager.getInstance();
    astManager.dispose();

    // Clean up IPC files
    try {
        fs.writeFile(TASK_FILE_PATH, '{}', 'utf-8');
        fs.writeFile(RESULT_FILE_PATH, '{}', 'utf-8');
    } catch (e) {
        // ignore
    }
}