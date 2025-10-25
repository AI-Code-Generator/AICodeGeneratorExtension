// src/service/SWEBenchAgent.ts
import * as vscode from 'vscode';
import { AgentService } from './AgentService';
import { config } from '../config';
import { AuthManager } from './AuthService'; // Import AuthManager

export class SWEBenchAgent {
    private agentService: AgentService;
    private repositoryPath: string = '';
    private authManager: AuthManager; // Store AuthManager
    private context: vscode.ExtensionContext; // Store Context

    constructor(context: vscode.ExtensionContext, authManager: AuthManager) {
        this.context = context;
        this.authManager = authManager;
        this.agentService = new AgentService(context); // Instantiate new AgentService
        
        // Set terminal command callback to auto-approve for SWE-bench
        this.agentService.setTerminalCommandCallback(async (command: string) => {
            console.log(`[SWE-bench Agent] Auto-approving terminal command: ${command}`);
            return true; // Auto-approve all commands for benchmarking
        });
    }

    /**
     * Main function to process a SWE-bench problem statement and generate a patch
     */
    public async generatePatch(problemStatement: string, repositoryPath?: string, outputChannel?: vscode.OutputChannel): Promise<string> {
        if (repositoryPath) {
            this.repositoryPath = repositoryPath;
            // Set the working directory for the agent service
            this.agentService.setWorkingDirectory(repositoryPath);
            console.log(`[SWE-bench Agent] Set working directory to: ${repositoryPath}`);
        }
        
        console.log(`[SWE-bench Agent] Starting agent with problem: ${problemStatement.substring(0, 100)}...`);
        
        return new Promise<string>(async (resolve, reject) => { // Make async
            let generatedPatch = '';
            let isFinished = false;

            // Get the auth token before starting
            const token = await this.authManager.getToken();
            if (!token) {
                const errorMsg = '[SWE-bench Agent] No auth token found. Agent cannot run. Please log in via the extension sidebar.';
                console.error(errorMsg);
                outputChannel?.appendLine(errorMsg);
                reject(new Error('No auth token found'));
                return;
            }
            
            // Capture all updates from the agent
            const sendUpdate = (update: string) => {
                console.log(`[SWE-bench Agent] ${update}`);
                if (outputChannel) {
                    outputChannel.appendLine(`[Agent] ${update}`);
                }
                
                // Check if this is a finish message
                if (update.startsWith('✅ Done:') || update.includes('Agent stopped')) {
                    console.log(`[SWE-bench Agent] Agent completed, attempting to extract patch...`);
                    console.log(`[SWE-bench Agent] Working directory: ${this.repositoryPath}`);
                    isFinished = true;
                    
                    // Try to extract the patch from git diff
                    this.extractPatchFromWorkspace()
                        .then(patch => {
                            console.log(`[SWE-bench Agent] Extracted patch with ${patch.length} characters`);
                            if (patch.length > 0) {
                                console.log(`[SWE-bench Agent] Patch preview: ${patch.substring(0, 200)}...`);
                            } else {
                                console.log(`[SWE-bench Agent] No patch generated - this indicates the agent may not have made any file changes`);
                            }
                            generatedPatch = patch;
                            resolve(generatedPatch);
                        })
                        .catch(error => {
                            console.error('[SWE-bench Agent] Error extracting patch:', error);
                            resolve(generatedPatch); // Return whatever we have
                        });
                } else if (update.includes('Agent stopped after reaching max steps')) {
                    console.log(`[SWE-bench Agent] Agent reached max steps, attempting to extract patch...`);
                    isFinished = true;
                    
                    this.extractPatchFromWorkspace()
                        .then(patch => {
                            console.log(`[SWE-bench Agent] Max steps - extracted patch with ${patch.length} characters`);
                            generatedPatch = patch;
                            resolve(generatedPatch);
                        })
                        .catch(error => {
                            console.error('[SWE-bench Agent] Error extracting patch after max steps:', error);
                            resolve('');
                        });
                }
            };

            // Start the agent processing
            console.log(`[SWE-bench Agent] Starting agent processing...`);
            
            this.agentService.processRequest(
                problemStatement,
                config.serverUrl + '/ask-ai',
                token, // Pass the token
                sendUpdate,
                null // Pass null for threadId
            ).catch(error => {
                console.error('[SWE-bench Agent] Error during processing:', error);
                if (!isFinished) {
                    reject(error);
                }
            });
        });
    }

    /**
     * Extract git diff patch from the specified repository path
     */
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

            // 1. Stage all changes, including new files.
            await execAsync('git add .', { cwd: workingDirectory });
            
            // 2. Get the diff of the staged changes. This is the correct command.
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
    /**
     * Stop the current agent processing
     */
    public stop(): void {
        this.agentService.stop();
    }
}