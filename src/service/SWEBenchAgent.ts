// src/service/SWEBenchAgent.ts
import * as vscode from 'vscode';
import { AgentService } from './AgentService';
import { config } from '../config';
import { AuthManager } from './AuthService';
import { ThreadManager } from './ThreadManager'; // Import ThreadManager

export class SWEBenchAgent {
    private agentService: AgentService;
    private repositoryPath: string = '';
    private authManager: AuthManager;
    private threadManager: ThreadManager; // Add ThreadManager
    private context: vscode.ExtensionContext;

    constructor(
        context: vscode.ExtensionContext, 
        authManager: AuthManager,
        threadManager: ThreadManager // Receive ThreadManager
    ) {
        this.context = context;
        this.authManager = authManager;
        this.threadManager = threadManager; // Store ThreadManager
        this.agentService = new AgentService(context);
        
        // Auto-approve terminal commands for benchmark mode
        this.agentService.setTerminalCommandCallback(async (command: string) => {
            console.log(`[SWE-bench Agent] Auto-approving terminal command: ${command}`);
            return true; 
        });
    }

    /**
     * Main function to process a SWE-bench problem statement and generate a patch
     */
    public async generatePatch(
        problemStatement: string, 
        repositoryPath: string, // This is passed from extension.ts
        sendUpdate: (update: string) => void // <-- This is the new, correct param
    ): Promise<string> {
        
        this.repositoryPath = repositoryPath;
        this.agentService.setWorkingDirectory(repositoryPath);
        sendUpdate(`[SWE-bench Agent] Set working directory to: ${repositoryPath}`);
        
        sendUpdate(`[SWE-bench Agent] Starting agent with problem: ${problemStatement.substring(0, 100)}...`);
        
        // 1. Get auth token
        const token = await this.authManager.getToken();
        if (!token) {
            const errorMsg = '[SWE-bench Agent] No auth token found. Agent cannot run. Run "AI Code Assist: Set Auth Token" command.';
            sendUpdate(errorMsg);
            throw new Error(errorMsg);
        }

        // 2. Create a new thread for this task
        let threadId: string;
        try {
            // Use the problem statement as the initial message
            const newThread = await this.threadManager.createNewThread(problemStatement); 
            threadId = newThread.id;
            sendUpdate(`[Agent] New thread created: ${threadId}`);
        } catch (e:any) {
            const errorMsg = `[SWE-bench Agent] Failed to create new thread: ${e.message}`;
            sendUpdate(errorMsg);
            throw new Error(errorMsg);
        }
        
        // 3. Start the agent
        sendUpdate(`[SWE-bench Agent] Starting agent processing...`);
        
        try {
            // Await the agent's full execution
            await this.agentService.processRequest(
                problemStatement,
                config.serverUrl + '/agent', // <-- *** CRITICAL FIX: Use the /agent endpoint ***
                token,
                sendUpdate, // Pass the update function directly
                threadId // Pass the new threadId
            );

            // When processRequest resolves, it means the agent called 'finish'
            // or was stopped. Now we extract the patch.
            sendUpdate(`[SWE-bench Agent] Agent completed, extracting patch...`);
            const patch = await this.extractPatchFromWorkspace();
            sendUpdate(`[SWE-bench Agent] Extracted patch: ${patch.length} chars`);
            return patch;

        } catch (error: any) {
            console.error('[SWE-bench Agent] Error during processing:', error);
            sendUpdate(`[SWE-bench Agent] Error during processing: ${error.message}`);
            // If agent fails, return an empty patch
            return ''; 
        }
    }

    private async extractPatchFromWorkspace(): Promise<string> {
        const workingDirectory = this.repositoryPath;
        if (!workingDirectory) {
            console.error('[SWE-bench Agent] Cannot extract patch, working directory not set.');
            return '';
        }

        try {
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);

            console.log(`[SWE-bench Agent] Extracting patch from: ${workingDirectory}`);

            // Stage all changes
            await execAsync('git add .', { cwd: workingDirectory });
            
            // Get the diff of staged changes
            const { stdout: patch, stderr } = await execAsync('git diff --cached', {
                cwd: workingDirectory,
                maxBuffer: 10 * 1024 * 1024 // 10MB buffer
            });

            if (stderr) {
                console.error(`[SWE-bench Agent] Git diff stderr: ${stderr}`);
            }
            
            console.log(`[SWE-bench Agent] Final patch length: ${patch.length} characters.`);
            return patch;

        } catch (error) {
            console.error('[SWE-bench Agent] CRITICAL ERROR extracting patch:', error);
            return '';
        }
    }

    public stop(): void {
        this.agentService.stop();
    }
}