// src/extension.ts
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from './config';
import { indexWorkspaceFiles, indexSingleFile, deleteSingleFile } from './service/FileIndexer';
import { ASTManager } from './service/ASTManager';
import { DiffManager } from './service/DiffManager';
import { DiffCodeLensProvider } from './service/DiffCodeLensProvider';
import { SWEBenchAgent } from './service/SWEBenchAgent';
import { AuthManager } from './service/AuthService';
import { ThreadManager } from './service/ThreadManager';
import { ChatViewProvider } from './ChatViewProvider'; // <-- IMPORT THE UI

export async function activate(context: vscode.ExtensionContext) {
    let output = vscode.window.createOutputChannel("AI code assist");
    output.appendLine('Activating AI Code Assist (SWE-bench Mode)...');

    // --- 1. INITIALIZE CORE SERVICES ---
    const authManager = AuthManager.getInstance(context);
    const threadManager = ThreadManager.getInstance(context, config.serverUrl, authManager);
    const diffManager = DiffManager.getInstance();
    const astManager = ASTManager.getInstance();
    const diffCodeLensProvider = new DiffCodeLensProvider();

    // --- 2. INITIALIZE CHAT UI PROVIDER (NEW) ---
    // Get the singleton instance of the ChatViewProvider
    const chatViewProvider = ChatViewProvider.getInstance(context, authManager);
    
    // Register the Chat View
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'aiCodeAssist.chatView',
            chatViewProvider,
            {
                webviewOptions: { retainContextWhenHidden: true }
            }
        )
    );

    // Register command to open chat (from your feature branch)
    context.subscriptions.push(
        vscode.commands.registerCommand('ai-code-assist.openChat', () => {
            vscode.commands.executeCommand('aiCodeAssist.chatView.focus');
        })
    );

    // --- 3. REGISTER THE LOGIN COMMAND ---
    let setTokenCommand = vscode.commands.registerCommand('aiCodeAssist.setToken', async () => {
        const token = await vscode.window.showInputBox({
            prompt: 'Enter your AI Code Assist Auth Token',
            password: true,
            ignoreFocusOut: true,
        });
        if (token) {
            try {
                await authManager.setToken(token);
                const userId = authManager.getUserIdFromToken(token);
                vscode.window.showInformationMessage(`AI Code Assist: Logged in as ${userId}`);
                // Refresh the chat view to show it's logged in
                chatViewProvider.resolveWebviewView(
                    vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'webview') as any, 
                    {} as any, 
                    {} as any
                );
            } catch (e:any) {
                vscode.window.showErrorMessage(`AI Code Assist: Failed to store token: ${e.message}`);
            }
        }
    });
    context.subscriptions.push(setTokenCommand);

    // --- 4. INITIALIZE SWE-BENCH COMMUNICATION ---
    // Pass the ChatViewProvider instance so the agent can log to it
    await initializeSWEBenchCommunication(context, authManager, threadManager, output, chatViewProvider);

    // --- 5. INITIALIZE WORKSPACE (AST & VECTOR INDEX) ---
    try {
        await astManager.initializeWorkspace(context);
        output.appendLine('AST Manager initialized successfully');
    } catch (err) {
        output.appendLine(`Error initializing AST Manager: ${err}`);
    }

    try {
        const files = await indexWorkspaceFiles(context.globalStorageUri, context);
        output.appendLine(`Indexed ${files.length} files in workspace`);
    } catch (err:any) {
        output.appendLine(`Error indexing workspace: ${err.message}`);
    }

    // --- 6. SET UP FILE WATCHERS (for index) ---
    const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*", false, false, false);
    
    fileWatcher.onDidChange(async (uri) => {
        try {
            await indexSingleFile(uri, context.globalStorageUri, context);
            output.appendLine(`Reindexed changed file: ${uri.fsPath}`);
        } catch (err:any) {
            output.appendLine(`Error reindexing file ${uri.fsPath}: ${err.message}`);
        }
    });
    
    fileWatcher.onDidCreate(async (uri) => {
        try {
            await indexSingleFile(uri, context.globalStorageUri, context);
            output.appendLine(`Indexed new file: ${uri.fsPath}`);
        } catch (err:any) {
            output.appendLine(`Error indexing new file ${uri.fsPath}: ${err.message}`);
        }
    });
    
    fileWatcher.onDidDelete(async (uri) => {
        try {
            await deleteSingleFile(uri, context.globalStorageUri);
            output.appendLine(`Deleted index for file: ${uri.fsPath}`);
        } catch (err:any) {
             output.appendLine(`Error deleting index for file ${uri.fsPath}: ${err.message}`);
        }
    });
    context.subscriptions.push(fileWatcher);

    // --- 7. REGISTER DIFF/CODELENS COMMANDS ---
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ scheme: 'file' }, diffCodeLensProvider)
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('aiCodeAssist.acceptChange', (changeId: string) => {
            diffManager.acceptChange(changeId);
            diffCodeLensProvider.refresh();
            diffManager.forceRefreshDecorations();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('aiCodeAssist.rejectChange', async (changeId: string) => {
            await diffManager.rejectChange(changeId);
            diffCodeLensProvider.refresh();
            diffManager.forceRefreshDecorations();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('aiCodeAssist.acceptAllChanges', () => {
            diffManager.acceptAllChanges();
            diffCodeLensProvider.refresh();
            diffManager.forceRefreshDecorations();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('aiCodeAssist.rejectAllChanges', async () => {
            await diffManager.rejectAllChanges();
            diffCodeLensProvider.refresh();
            diffManager.forceRefreshDecorations();
        })
    );

    output.appendLine('AI Code Assist activated.');
}

// --- SWE-BENCH IPC LOGIC ---

const IPC_DIR = path.join(require('os').homedir(), '.my-agent-ipc');
const TASK_FILE_PATH = path.join(IPC_DIR, 'ipc-task.json');
const RESULT_FILE_PATH = path.join(IPC_DIR, 'ipc-result.json');

async function initializeSWEBenchCommunication(
    context: vscode.ExtensionContext, 
    authManager: AuthManager, 
    threadManager: ThreadManager,
    output: vscode.OutputChannel,
    chatViewProvider: ChatViewProvider // <-- RECEIVE CHAT VIEW
) {
    output.appendLine('[SWE-bench] Initializing file-based communication system');
    
    try {
        await fs.mkdir(IPC_DIR, { recursive: true });
        await fs.writeFile(TASK_FILE_PATH, '{}', 'utf-8'); // Clear task file

        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(IPC_DIR), 'ipc-task.json'),
            false, false, true
        );

        const processTask = async (uri: vscode.Uri) => {
            output.appendLine(`[SWE-bench] Detected event in ${uri.fsPath}`);
            // Pass ChatViewProvider to the task processor
            await processSWEBenchTask(context, authManager, threadManager, output, chatViewProvider);
        };

        watcher.onDidChange(processTask);
        watcher.onDidCreate(processTask);
        context.subscriptions.push(watcher);
        
        output.appendLine(`[SWE-bench] Watching for tasks in: ${TASK_FILE_PATH}`);
        
    } catch (error) {
        output.appendLine(`[SWE-bench] Error initializing communication: ${error}`);
    }
}

async function processSWEBenchTask(
    context: vscode.ExtensionContext, 
    authManager: AuthManager, 
    threadManager: ThreadManager,
    output: vscode.OutputChannel,
    chatViewProvider: ChatViewProvider // <-- RECEIVE CHAT VIEW
) {
    let instance_id_from_task = 'unknown';
    try {
        const taskContent = await fs.readFile(TASK_FILE_PATH, 'utf-8');
        
        if (!taskContent.trim() || taskContent.trim() === '{}') {
            output.appendLine(`[SWE-bench] Task file empty, skipping.`);
            return;
        }

        const taskData = JSON.parse(taskContent);
        instance_id_from_task = taskData.instance_id || 'unknown';

        if (!taskData.instance_id || !taskData.problem_statement || !taskData.repo_path) {
            output.appendLine(`[SWE-bench] Invalid task file content. Clearing.`);
            await fs.writeFile(TASK_FILE_PATH, '{}', 'utf-8');
            return;
        }

        await fs.writeFile(TASK_FILE_PATH, '{}', 'utf-8'); // Acknowledge task
        output.appendLine(`[SWE-bench] Received task: ${taskData.instance_id}`);
        
        // --- NEW: Clear UI and create update function ---
        chatViewProvider.clearMessages();
        vscode.commands.executeCommand('aiCodeAssist.chatView.focus');
        
        const sendUpdate = (message: string) => {
            output.appendLine(message); // Log to original output channel
            chatViewProvider.logAgentUpdate(message); // Log to new Chat UI
        };
        // --- END NEW ---

        sendUpdate(`[SWE-bench] Starting task: ${taskData.instance_id}`);

        // --- AGENT EXECUTION ---
        const sweBenchAgent = new SWEBenchAgent(context, authManager, threadManager); 
        
        // *** IMPORTANT ***
        // You MUST update your SWEBenchAgent.ts file.
        // The 'generatePatch' method must now accept 'sendUpdate' as its third argument
        // and pass it to 'agentService.processRequest'.
        //
        // Example change in SWEBenchAgent.ts:
        // public async generatePatch(prompt: string, repo_path: string, sendUpdate: (update: string) => void) {
        //     ...
        //     await agentService.processRequest(prompt, ..., token, sendUpdate, ...);
        //     ...
        // }
        const generated_patch = await sweBenchAgent.generatePatch(
            taskData.problem_statement, 
            taskData.repo_path, 
            sendUpdate // <-- PASS 'sendUpdate' INSTEAD OF 'output'
        );
        // --- END AGENT EXECUTION ---

        const result = {
            instance_id: taskData.instance_id,
            patch: generated_patch
        };
        
        await fs.writeFile(RESULT_FILE_PATH, JSON.stringify(result, null, 2), 'utf-8');
        sendUpdate(`[SWE-bench] Finished task: ${taskData.instance_id}`);

    } catch (error: any) {
        if (error instanceof SyntaxError) {
            output.appendLine(`[SWE-bench] Ignoring malformed task file (likely being written).`);
            return;
        }
        const errorMsg = `[SWE-bench] Error processing task ${instance_id_from_task}: ${error}`;
        output.appendLine(errorMsg);
        if(chatViewProvider) {
            chatViewProvider.logAgentUpdate(errorMsg);
        }
        
        try {
            await fs.writeFile(RESULT_FILE_PATH, JSON.stringify({ 
                error: String(error),
                instance_id: instance_id_from_task
            }), 'utf-8');
        } catch (writeError) {
            output.appendLine(`[SWE-bench] Error writing error result: ${writeError}`);
        }
    }
}

export function deactivate() {
    DiffManager.getInstance().dispose();
    ASTManager.getInstance().dispose();

    try {
        fs.writeFile(TASK_FILE_PATH, '{}', 'utf-8');
        fs.writeFile(RESULT_FILE_PATH, '{}', 'utf-8');
    } catch (e) { /* ignore */ }
}