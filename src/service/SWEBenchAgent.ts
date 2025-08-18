// src/service/SWEBenchAgent.ts
import * as vscode from 'vscode';
import { AgentService } from './AgentService';
import { config } from '../config';

export class SWEBenchAgent {
    private agentService: AgentService;
    private repositoryPath: string = '';

    constructor() {
        this.agentService = new AgentService();
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
        
        return new Promise<string>((resolve, reject) => {
            let generatedPatch = '';
            let isFinished = false;
            
            // Capture all updates from the agent
            const sendUpdate = (update: string) => {
                console.log(`[SWE-bench Agent] ${update}`);
                if (outputChannel) {
                    outputChannel.appendLine(`[Agent] ${update}`);
                }
                
                // Check if this is a finish message
                if (update.includes('**Agent finished:') || update.includes('Agent stopped')) {
                    console.log(`[SWE-bench Agent] Agent completed, attempting to extract patch...`);
                    console.log(`[SWE-bench Agent] Working directory: ${this.repositoryPath}`);
                    isFinished = true;
                    clearTimeout(processingTimeout);
                    
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
                    clearTimeout(processingTimeout);
                    
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
            
            // Add a shorter timeout for faster debugging
            const processingTimeout = setTimeout(() => {
                if (!isFinished) {
                    console.log('[SWE-bench Agent] Processing timeout reached, stopping agent');
                    this.agentService.stop();
                    // Try to extract whatever changes we have
                    this.extractPatchFromWorkspace()
                        .then(patch => {
                            console.log(`[SWE-bench Agent] Timeout - extracted patch with ${patch.length} characters`);
                            resolve(patch);
                        })
                        .catch(() => resolve(''));
                }
            }, 120000); // 2 minute timeout for testing
            
            this.agentService.processRequest(
                problemStatement,
                config.serverUrl + '/ask-ai',
                sendUpdate
            ).catch(error => {
                console.error('[SWE-bench Agent] Error during processing:', error);
                clearTimeout(processingTimeout);
                if (!isFinished) {
                    reject(error);
                }
            });

            // Set a timeout to prevent hanging
            setTimeout(() => {
                if (!isFinished) {
                    console.log('[SWE-bench Agent] Timeout reached, stopping agent');
                    this.agentService.stop();
                    this.extractPatchFromWorkspace()
                        .then(patch => resolve(patch))
                        .catch(() => resolve(''));
                }
            }, 60000); // 1 minute timeout for testing
        });
    }

    /**
     * Extract git diff patch from the specified repository path
     */
    private async extractPatchFromWorkspace(): Promise<string> {
        const workingDirectory = this.repositoryPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        
        if (!workingDirectory) {
            throw new Error('No working directory found');
        }

        try {
            // Use git command directly since we may not be in the VS Code workspace
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);

            console.log(`[SWE-bench Agent] Extracting patch from: ${workingDirectory}`);

            // Initialize git repo if it doesn't exist
            try {
                await execAsync('git status', { cwd: workingDirectory });
            } catch (statusError) {
                console.log(`[SWE-bench Agent] No git repository found, initializing...`);
                try {
                    await execAsync('git init', { cwd: workingDirectory });
                    await execAsync('git add .', { cwd: workingDirectory });
                    await execAsync('git commit -m "Initial commit"', { cwd: workingDirectory });
                    console.log(`[SWE-bench Agent] Git repository initialized`);
                } catch (initError) {
                    console.log(`[SWE-bench Agent] Failed to initialize git: ${initError}`);
                }
            }

            // First, add all files to git (in case new files were created)
            try {
                await execAsync('git add .', { cwd: workingDirectory });
                console.log(`[SWE-bench Agent] Added all files to git`);
            } catch (addError) {
                console.log(`[SWE-bench Agent] Git add failed (may be normal): ${addError}`);
            }

            // Get git status first to see what changed
            const { stdout: statusOutput } = await execAsync('git status --porcelain', {
                cwd: workingDirectory
            });

            console.log(`[SWE-bench Agent] Git status output: ${statusOutput}`);

            if (!statusOutput.trim()) {
                console.log('[SWE-bench Agent] No changes detected in git status');
                
                // Try to get diff of any uncommitted changes
                try {
                    const { stdout: diffUnstaged } = await execAsync('git diff', {
                        cwd: workingDirectory
                    });
                    
                    const { stdout: diffStaged } = await execAsync('git diff --cached', {
                        cwd: workingDirectory
                    });
                    
                    const combinedDiff = diffUnstaged + diffStaged;
                    console.log(`[SWE-bench Agent] Combined diff length: ${combinedDiff.length}`);
                    return combinedDiff;
                } catch (diffError) {
                    console.log(`[SWE-bench Agent] Failed to get any diff: ${diffError}`);
                    return '';
                }
            }

            // Get the diff of all changes (staged and unstaged)
            let diffOutput = '';
            
            try {
                // Try to get diff against HEAD
                const { stdout: headDiff } = await execAsync('git diff HEAD', {
                    cwd: workingDirectory
                });
                diffOutput = headDiff;
            } catch (headError) {
                console.log(`[SWE-bench Agent] Git diff HEAD failed: ${headError}`);
                
                // Fallback: get diff of staged changes
                try {
                    const { stdout: cachedDiff } = await execAsync('git diff --cached', {
                        cwd: workingDirectory
                    });
                    diffOutput = cachedDiff;
                } catch (cachedError) {
                    console.log(`[SWE-bench Agent] Git diff --cached failed: ${cachedError}`);
                    
                    // Last fallback: get diff of unstaged changes
                    try {
                        const { stdout: unstagedDiff } = await execAsync('git diff', {
                            cwd: workingDirectory
                        });
                        diffOutput = unstagedDiff;
                    } catch (unstagedError) {
                        console.log(`[SWE-bench Agent] All git diff attempts failed`);
                        return '';
                    }
                }
            }

            console.log(`[SWE-bench Agent] Generated patch length: ${diffOutput.length} characters`);
            return diffOutput || '';

        } catch (error) {
            console.error('[SWE-bench Agent] Error extracting patch:', error);
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
