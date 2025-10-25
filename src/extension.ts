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
import { ThreadManager } from './service/ThreadManager'; // Import ThreadManager

export async function activate(context: vscode.ExtensionContext) {
    let output = vscode.window.createOutputChannel("AI code assist");
    output.appendLine('Activating AI Code Assist (SWE-bench Mode)...');

    // --- 1. INITIALIZE CORE SERVICES ---
    const authManager = AuthManager.getInstance(context);
    // Pass authManager to ThreadManager
    const threadManager = ThreadManager.getInstance(context, config.serverUrl, authManager);
    const diffManager = DiffManager.getInstance();
    const astManager = ASTManager.getInstance();
    const diffCodeLensProvider = new DiffCodeLensProvider();

    // --- 2. REGISTER THE NEW LOGIN COMMAND ---
    // This is how you will log in on the VM
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
            } catch (e:any) {
                vscode.window.showErrorMessage(`AI Code Assist: Failed to store token: ${e.message}`);
            }
        }
    });
    context.subscriptions.push(setTokenCommand);

    // --- 3. INITIALIZE SWE-BENCH COMMUNICATION ---
    // Pass ThreadManager to the agent factory
    await initializeSWEBenchCommunication(context, authManager, threadManager, output);

    // --- 4. INITIALIZE WORKSPACE (AST & VECTOR INDEX) ---
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

    // --- 5. SET UP FILE WATCHERS (for index) ---
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

    // --- 6. REGISTER DIFF/CODELENS COMMANDS ---
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
    threadManager: ThreadManager, // Receive ThreadManager
    output: vscode.OutputChannel
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
            await processSWEBenchTask(context, authManager, threadManager, output); // Pass ThreadManager
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
    threadManager: ThreadManager, // Receive ThreadManager
    output: vscode.OutputChannel
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

        // --- AGENT EXECUTION ---
        // Pass ThreadManager to the agent
        const sweBenchAgent = new SWEBenchAgent(context, authManager, threadManager); 
        const generated_patch = await sweBenchAgent.generatePatch(
            taskData.problem_statement, 
            taskData.repo_path, 
            output
        );
        // --- END AGENT EXECUTION ---

        const result = {
            instance_id: taskData.instance_id,
            patch: generated_patch
        };
        
        await fs.writeFile(RESULT_FILE_PATH, JSON.stringify(result, null, 2), 'utf-8');
        output.appendLine(`[SWE-bench] Finished task: ${taskData.instance_id}`);

    } catch (error) {
        if (error instanceof SyntaxError) {
            output.appendLine(`[SWE-bench] Ignoring malformed task file (likely being written).`);
            return;
        }
        output.appendLine(`[SWE-bench] Error processing task ${instance_id_from_task}: ${error}`);
        
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