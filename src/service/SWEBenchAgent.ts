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
        
        this.agentService.setTerminalCommandCallback(async (command: string) => {
            console.log(`[SWE-bench Agent] Auto-approving terminal command: ${command}`);
            return true; // Auto-approve
        });
    }

    /**
     * Main function to process a SWE-bench problem statement and generate a patch
     */
    public async generatePatch(
        problemStatement: string, 
        repositoryPath?: string, 
        outputChannel?: vscode.OutputChannel
    ): Promise<string> {
        
        if (repositoryPath) {
            this.repositoryPath = repositoryPath;
            this.agentService.setWorkingDirectory(repositoryPath);
            console.log(`[SWE-bench Agent] Set working directory to: ${repositoryPath}`);
        }
        
        console.log(`[SWE-bench Agent] Starting agent with problem: ${problemStatement.substring(0, 100)}...`);
        
        return new Promise<string>(async (resolve, reject) => {
            let generatedPatch = '';
            let isFinished = false;

            // 1. Get auth token
            const token = await this.authManager.getToken();
            if (!token) {
                const errorMsg = '[SWE-bench Agent] No auth token found. Agent cannot run. Run "AI Code Assist: Set Auth Token" command.';
                console.error(errorMsg);
                outputChannel?.appendLine(errorMsg);
                reject(new Error(errorMsg));
                return;
            }

            // 2. Create a new thread for this task
            let threadId: string;
            try {
                // Use the problem statement as the initial message
                const newThread = await this.threadManager.createNewThread(problemStatement); 
                threadId = newThread.id;
                console.log(`[SWE-bench Agent] Created new thread for task: ${threadId}`);
                outputChannel?.appendLine(`[Agent] New thread created: ${threadId}`);
            } catch (e:any) {
                const errorMsg = `[SWE-bench Agent] Failed to create new thread: ${e.message}`;
                console.error(errorMsg);
                outputChannel?.appendLine(errorMsg);
                reject(new Error(errorMsg));
                return;
            }
            
            // 3. Setup agent update handler
            const sendUpdate = (update: string) => {
                console.log(`[SWE-bench Agent] ${update}`);
                if (outputChannel) {
                    outputChannel.appendLine(`[Agent] ${update}`);
                }
                
                if (update.startsWith('✅ Done:') || update.includes('Agent stopped')) {
                    console.log(`[SWE-bench Agent] Agent completed, extracting patch...`);
                    isFinished = true;
                    
                    this.extractPatchFromWorkspace()
                        .then(patch => {
                            console.log(`[SWE-bench Agent] Extracted patch: ${patch.length} chars`);
                            generatedPatch = patch;
                            resolve(generatedPatch);
                        })
                        .catch(error => {
                            console.error('[SWE-bench Agent] Error extracting patch:', error);
                            resolve(generatedPatch);
                        });
                } else if (update.includes('Agent stopped after reaching max steps')) {
                    console.log(`[SWE-bench Agent] Agent max steps, extracting patch...`);
                    isFinished = true;
                    
                    this.extractPatchFromWorkspace()
                        .then(patch => {
                            console.log(`[SWE-bench Agent] Max steps - extracted patch: ${patch.length} chars`);
                            generatedPatch = patch;
                            resolve(generatedPatch);
                        })
                        .catch(error => {
                            console.error('[SWE-bench Agent] Error extracting patch after max steps:', error);
                            resolve('');
                        });
                }
            };

            // 4. Start the agent
            console.log(`[SWE-bench Agent] Starting agent processing...`);
            
            this.agentService.processRequest(
                problemStatement,
                config.serverUrl + '/ask-ai',
                token,
                sendUpdate,
                threadId // Pass the new threadId
            ).catch(error => {
                console.error('[SWE-bench Agent] Error during processing:', error);
                if (!isFinished) {
                    reject(error);
                }
            });
        });
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

            await execAsync('git add .', { cwd: workingDirectory });
            
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