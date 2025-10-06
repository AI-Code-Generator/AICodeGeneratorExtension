// src/service/AgentService.ts
import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { DiffManager } from './DiffManager';
import { state, initializeEmbedder, embedText, embedQuery } from './FileIndexer';

// The ToolBox holds the set of functions the agent can execute.
class ToolBox {
    private diffManager: DiffManager;
    private terminalCommandCallback?: (command: string) => Promise<boolean>;
    private workingDirectory: string = '';
    private terminal?: vscode.Terminal;
    private captureTimeout?: NodeJS.Timeout;

    constructor() {
        this.diffManager = DiffManager.getInstance();
    }

    public setTerminalCommandCallback(callback: (command: string) => Promise<boolean>) {
        this.terminalCommandCallback = callback;
    }

    public setWorkingDirectory(directory: string) {
        this.workingDirectory = directory;
    }

    public getWorkingDirectory(): string {
        return this.workingDirectory;
    }

    private ensureTerminal(): vscode.Terminal {
        const cwd = this.workingDirectory || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!this.terminal || this.terminal.exitStatus) {
            this.terminal = vscode.window.createTerminal({ name: 'AI Code Assist Agent', cwd });
            // Show terminal immediately to initialize shell integration faster
            this.terminal.show(false);
            console.log('[Terminal] Created new terminal, waiting for shell integration to initialize...');
        } else {
            // If cwd changed after terminal creation, send hidden cd command
            if (cwd) {
                // Use a hidden cd command that doesn't show in terminal
                this.terminal.sendText(`cd "${cwd.replace(/"/g, '\\"')}" > /dev/null 2>&1`);
            }
            // Show terminal but don't steal focus
            this.terminal.show(false);
        }
        return this.terminal;
    }

    // Deleted the ensurePseudoTerminal method - we'll use the regular terminal only

    // Attempt to stop any currently running process in the agent terminal.
    // Strategy: send Ctrl+C a couple times, wait briefly, then dispose and recreate terminal to guarantee a clean state.
    private async killRunningTerminalProcess(): Promise<void> {
        // Clear any pending timeout
        if (this.captureTimeout) {
            clearTimeout(this.captureTimeout);
            this.captureTimeout = undefined;
        }

        // Stop terminal if present
        if (this.terminal) {
            if (!this.terminal.exitStatus) {
                try {
                    // Send Ctrl+C twice to gracefully terminate any running process
                    this.terminal.sendText('\x03', false);  // Ctrl+C without newline
                    await new Promise((r) => setTimeout(r, 300));
                    this.terminal.sendText('\x03', false);
                    await new Promise((r) => setTimeout(r, 300));
                } catch { /* ignore */ }
                try {
                    this.terminal.dispose();
                } catch { /* ignore */ }
            }
            // In all cases, clear the stale reference so a fresh terminal can be created next time
            this.terminal = undefined;
        }
    }

    public async list_files(offset: number = 0, limit: number = 100): Promise<{files: string[], total: number, hasMore: boolean}> {
        let allFiles: string[] = [];
        
        if (this.workingDirectory) {
            // Use fs to list files recursively in the specific directory
            const fs = require('fs');
            const path = require('path');
            
            const getAllFiles = (dirPath: string, arrayOfFiles: string[] = []): string[] => {
                try {
                    const files = fs.readdirSync(dirPath);
                    
                    files.forEach((file: string) => {
                        const fullPath = path.join(dirPath, file);
                        
                        // Skip common directories we don't want to index
                        if (['.git', 'node_modules', '__pycache__', '.vscode', '.pytest_cache', 'venv', '.env'].includes(file)) {
                            return;
                        }
                        
                        if (fs.statSync(fullPath).isDirectory()) {
                            getAllFiles(fullPath, arrayOfFiles);
                        } else {
                            // Return relative path from working directory
                            const relativePath = path.relative(this.workingDirectory, fullPath);
                            arrayOfFiles.push(relativePath);
                        }
                    });
                } catch (error) {
                    console.error(`Error reading directory ${dirPath}:`, error);
                }
                
                return arrayOfFiles;
            };
            
            allFiles = getAllFiles(this.workingDirectory);
        } else {
            // Find all files, ignoring .git, node_modules, and other common exclusions
            const files = await vscode.workspace.findFiles('**/*', '{.git,node_modules,**/__pycache__,.vscode}/**');
            allFiles = files.map(file => vscode.workspace.asRelativePath(file));
        }

        // Sort files for consistent ordering
        allFiles.sort();
        
        // Paginate the results
        const startIndex = offset;
        const endIndex = Math.min(offset + limit, allFiles.length);
        const paginatedFiles = allFiles.slice(startIndex, endIndex);
        
        return {
            files: paginatedFiles,
            total: allFiles.length,
            hasMore: endIndex < allFiles.length
        };
    }

    public async search_files(pattern: string): Promise<string[]> {
        if (this.workingDirectory) {
            const fs = require('fs');
            const path = require('path');
            
            const searchFiles = (dirPath: string, pattern: string, arrayOfFiles: string[] = []): string[] => {
                try {
                    const files = fs.readdirSync(dirPath);
                    
                    files.forEach((file: string) => {
                        const fullPath = path.join(dirPath, file);
                        
                        // Skip common directories we don't want to index
                        if (['.git', 'node_modules', '__pycache__', '.vscode', '.pytest_cache', 'venv', '.env'].includes(file)) {
                            return;
                        }
                        
                        if (fs.statSync(fullPath).isDirectory()) {
                            searchFiles(fullPath, pattern, arrayOfFiles);
                        } else {
                            const relativePath = path.relative(this.workingDirectory, fullPath);
                            // Simple pattern matching - contains the pattern or matches file extension
                            if (relativePath.toLowerCase().includes(pattern.toLowerCase()) || 
                                relativePath.endsWith(pattern)) {
                                arrayOfFiles.push(relativePath);
                            }
                        }
                    });
                } catch (error) {
                    console.error(`Error reading directory ${dirPath}:`, error);
                }
                
                return arrayOfFiles;
            };
            
            return searchFiles(this.workingDirectory, pattern).slice(0, 50); // Limit to 50 results
        } else {
            // Find files using vscode
            const files = await vscode.workspace.findFiles(`**/*${pattern}*`, '{.git,node_modules,**/__pycache__,.vscode}/**');
            return files.map(file => vscode.workspace.asRelativePath(file)).slice(0, 50);
        }
    }

    /**
     * Search for a keyword across the workspace file contents.
     * Returns an array of compact match objects with file path and line snippets.
     * This is different from search_files which matches file NAMES only.
     */
    public async search_text(keyword: string, maxFiles: number = 200, maxMatchesPerFile: number = 5): Promise<Array<{ file: string, matches: Array<{ line: number, text: string }> }>> {
        const results: Array<{ file: string, matches: Array<{ line: number, text: string }> }> = [];

        // Helper to scan a single file content for keyword
        const scanContent = (content: string, file: string) => {
            const lower = content.toLowerCase();
            const idx = lower.indexOf(keyword.toLowerCase());
            if (idx === -1) {
                return; // quick reject
            }

            const lines = content.split('\n');
            const fileMatches: Array<{ line: number, text: string }> = [];
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(keyword.toLowerCase())) {
                    fileMatches.push({ line: i + 1, text: lines[i].slice(0, 500) });
                    if (fileMatches.length >= maxMatchesPerFile) {
                        break;
                    }
                }
            }
            if (fileMatches.length) {
                results.push({ file, matches: fileMatches });
            }
        };

        const EXCLUDES = ['.git', 'node_modules', '__pycache__', '.vscode', '.pytest_cache', 'venv', '.env'];

        if (this.workingDirectory) {
            const fsSync = require('fs');
            const pathMod = require('path');

            const gatherFiles = (dirPath: string, acc: string[] = []) => {
                try {
                    for (const entry of fsSync.readdirSync(dirPath)) {
                        if (EXCLUDES.includes(entry)) {
                            continue;
                        }
                        const full = pathMod.join(dirPath, entry);
                        const stat = fsSync.statSync(full);
                        if (stat.isDirectory()) {
                            gatherFiles(full, acc);
                        } else {
                            acc.push(full);
                            if (acc.length >= maxFiles) {
                                return acc;
                            }
                        }
                    }
                } catch (_) { /* ignore */ }
                return acc;
            };

            const files = gatherFiles(this.workingDirectory, []);
            for (const abs of files) {
                try {
                    // Skip large files (>1MB)
                    const stat = fsSync.statSync(abs);
                    if (stat.size > 1_000_000) {
                        continue;
                    }
                    const content = fsSync.readFileSync(abs, 'utf-8');
                    const rel = pathMod.relative(this.workingDirectory, abs);
                    scanContent(content, rel);
                } catch (_) { /* ignore */ }
            }
        } else {
            // VS Code API path
            const files = await vscode.workspace.findFiles('**/*', '{.git,node_modules,**/__pycache__,.vscode}/**');
            let count = 0;
            for (const uri of files) {
                if (count >= maxFiles) {
                    break;
                }
                try {
                    const doc = await vscode.workspace.fs.readFile(uri);
                    // Limit size to 1MB
                    if (doc.byteLength > 1_000_000) {
                        continue;
                    }
                    const content = Buffer.from(doc).toString('utf-8');
                    const rel = vscode.workspace.asRelativePath(uri);
                    scanContent(content, rel);
                    count++;
                } catch (_) { /* ignore */ }
            }
        }

        return results.slice(0, maxFiles);
    }

    public async read_file(filePath: string): Promise<string> {
        const absolutePath = this.getAbsolutePath(filePath);
        try {
            const content = await fs.readFile(absolutePath, 'utf-8');
            const FILE_SIZE_LIMIT = 15000; // Set a reasonable character limit

            if (content.length > FILE_SIZE_LIMIT) {
                // If file is too long, return a summary and instructions
                return `Error: File '${filePath}' is too long (${content.length} characters). ` +
                       `File content has been truncated. ` +
                       `To find specific content, use the 'search_in_file(filePath, keyword)' tool. ` +
                       `To read the file in chunks, use 'read_file_chunk(filePath, chunkNumber, chunkSize)'.\n\n` +
                       `Start of file:\n${content.substring(0, 4000)}`;
            }
            return content;
        } catch (error) {
            if ((error as any).code === 'ENOENT') {
                return `Error: File not found at path: ${absolutePath}. Working directory: ${this.workingDirectory}`;
            }
            return `Error reading file: ${error}`;
        }
    }

    public async search_in_file(filePath: string, keyword: string): Promise<string> {
        const absolutePath = this.getAbsolutePath(filePath);
        try {
            const content = await fs.readFile(absolutePath, 'utf-8');
            const lines = content.split('\n');
            const matchingLines: string[] = [];
            const CONTEXT_LINES = 5; // How many lines before and after to show

            lines.forEach((line, index) => {
                if (line.toLowerCase().includes(keyword.toLowerCase())) {
                    matchingLines.push(`\n--- Match found on line ${index + 1} ---\n`);
                    const start = Math.max(0, index - CONTEXT_LINES);
                    const end = Math.min(lines.length, index + CONTEXT_LINES + 1);
                    for (let i = start; i < end; i++) {
                        // Add line numbers for context
                        matchingLines.push(`${i + 1}: ${lines[i]}`);
                    }
                }
            });

            if (matchingLines.length === 0) {
                return `Keyword '${keyword}' not found in file '${filePath}'.`;
            }

            // Join the results and cap the total length to prevent explosions
            return matchingLines.join('\n').substring(0, 8000);

        } catch (error) {
            if ((error as any).code === 'ENOENT') {
                return `Error: File not found at path: ${absolutePath}.`;
            }
            return `Error searching in file: ${error}`;
        }
    }

    public async read_file_chunk(filePath: string, chunkNumber: number = 1, chunkSize: number = 8000): Promise<string> {
        const absolutePath = this.getAbsolutePath(filePath);
        try {
            const content = await fs.readFile(absolutePath, 'utf-8');
            const totalChunks = Math.ceil(content.length / chunkSize);

            if (chunkNumber < 1) {
                chunkNumber = 1;
            }

            const start = (chunkNumber - 1) * chunkSize;
            
            if (start > content.length) {
                return `Error: Chunk number ${chunkNumber} is out of bounds. The file only has ${totalChunks} chunks.`;
            }

            const chunkContent = content.substring(start, start + chunkSize);

            return `--- Showing chunk ${chunkNumber} of ${totalChunks} from file '${filePath}' ---\n\n` + chunkContent;

        } catch (error) {
            if ((error as any).code === 'ENOENT') {
                return `Error: File not found at path: ${absolutePath}.`;
            }
            return `Error reading file chunk: ${error}`;
        }
    }

    public async apply_file_change(filePath: string, newContent: string): Promise<string> {
        return await this.diffManager.applyChangeWithDiff(filePath, newContent);
    }

    public async run_terminal_command(command: string): Promise<{ stdout: string, stderr: string }> {
        // Ask for permission
        let allow = false;
        if (this.terminalCommandCallback) {
            allow = await this.terminalCommandCallback(command);
        } else {
            const result = await vscode.window.showInformationMessage(
                `The agent wants to run the following command:\n\n${command}\n\nDo you want to allow it?`,
                { modal: true },
                'Yes',
                'No'
            );
            allow = result === 'Yes';
        }

        if (!allow) {
            return { stdout: '', stderr: 'Command not allowed by user.' };
        }

        // First, ensure any running process is stopped
        await this.killRunningTerminalProcess();
        
        // Create a new terminal or use existing one (recreate if previously closed)
        const term = this.ensureTerminal();
        
        // If terminal was just created, give it more time to initialize shell integration
        if (!term.shellIntegration) {
            console.log('[Terminal] Waiting for shell integration to initialize (new terminal)...');
            // Wait up to 3 seconds, checking every 200ms
            for (let i = 0; i < 15; i++) {
                await new Promise(resolve => setTimeout(resolve, 200));
                if (term.shellIntegration) {
                    console.log(`[Terminal] Shell integration initialized after ${(i + 1) * 200}ms`);
                    break;
                }
            }
            
            if (!term.shellIntegration) {
                console.warn('[Terminal] Shell integration still not available after 3 seconds');
            }
        }
            
        // Make sure we're in the right directory
        if (this.workingDirectory) {
            await new Promise<void>(resolve => {
                term.sendText(`cd "${this.workingDirectory.replace(/"/g, '\\"')}"`, true);
                setTimeout(resolve, 100);
            });
        }
        
        term.show(true); // Show terminal with focus

        return new Promise(async (resolve) => {
            let resolved = false;
            let output = '';
            let currentExecution: vscode.TerminalShellExecution | null = null;
            const disposables: vscode.Disposable[] = [];
            let commandSent = false;
            let shellIntegrationLost = false;
            let lastShellExecutionEvent: vscode.TerminalShellExecutionEndEvent | null = null;
            
            // Cleanup function to dispose all listeners
            const cleanup = () => {
                disposables.forEach(d => d.dispose());
                disposables.length = 0;
            };
            
            // Final resolve function
            const doResolve = (stdout: string, stderr: string) => {
                if (resolved) {
                    return;
                }
                resolved = true;
                cleanup();
                console.log('[Terminal] Resolving with output length:', stdout.length);
                resolve({ stdout, stderr });
            };

            // Detect if command is likely to be long-running (servers, watchers, etc.)
            const isLongRunningCommand = (cmd: string): boolean => {
                const longRunningPatterns = [
                    /npm\s+(run\s+)?(start|dev|serve|watch)/i,
                    /yarn\s+(run\s+)?(start|dev|serve|watch)/i,
                    /ng\s+serve/i,
                    /webpack\s+.*--watch/i,
                    /nodemon/i,
                    /python\s+.*manage\.py\s+runserver/i,
                    /rails\s+server/i,
                    /mvn\s+.*spring-boot:run/i,
                    /gradle\s+.*bootRun/i
                ];
                return longRunningPatterns.some(pattern => pattern.test(cmd));
            };

            // Detect if command is installation/build type (completes but might take time)
            const isInstallCommand = (cmd: string): boolean => {
                const installPatterns = [
                    /npm\s+(install|i|ci)/i,
                    /yarn\s+(install|add)/i,
                    /pip\s+install/i,
                    /mvn\s+(install|package|clean)/i,
                    /gradle\s+(build|assemble)/i,
                    /cargo\s+build/i
                ];
                return installPatterns.some(pattern => pattern.test(cmd));
            };

            const cmdType = isLongRunningCommand(command) ? 'long-running' : 
                           isInstallCommand(command) ? 'install' : 'normal';
            
            // Adaptive timeout based on command type
            const MAX_INACTIVITY_TIME = cmdType === 'install' ? 10000 : // 10 seconds for install
                                       cmdType === 'long-running' ? 300000 : // 5 minutes for servers (keep monitoring)
                                       30000; // 30 seconds for normal commands
            
            let inactivityTimeout: NodeJS.Timeout | null = null;
            let streamEnded = false;
            let streamReadingActive = false;
            let processDetachedMessage = false;

            // Reset inactivity timer
            const resetInactivityTimer = () => {
                if (inactivityTimeout) {
                    clearTimeout(inactivityTimeout);
                }
                
                inactivityTimeout = setTimeout(() => {
                    console.log('[Terminal] Inactivity timeout triggered. streamEnded:', streamEnded, 'shellIntegrationLost:', shellIntegrationLost, 'outputLength:', output.length);
                    
                    // For long-running commands that are still running (stream hasn't ended)
                    // Keep monitoring but don't resolve yet - wait for actual termination
                    if (cmdType === 'long-running' && !streamEnded && !shellIntegrationLost) {
                        console.log('[Terminal] Long-running process still active, continuing to monitor...');
                        // Don't resolve - keep waiting for actual termination (Ctrl+C, exit, etc.)
                        return;
                    }
                    
                    if (streamEnded || shellIntegrationLost) {
                        // Stream ended or shell integration lost - command likely finished
                        doResolve(
                            output || `Command "${command}" completed.`,
                            lastShellExecutionEvent && lastShellExecutionEvent.exitCode !== 0 
                                ? `Exit code: ${lastShellExecutionEvent.exitCode}` 
                                : ''
                        );
                    } else {
                        // Normal timeout behavior
                        doResolve(
                            output + `\n\n[INFO] Command execution timeout (${MAX_INACTIVITY_TIME/1000}s of inactivity). Output captured so far.`,
                            ""
                        );
                    }
                }, MAX_INACTIVITY_TIME);
            };

            // Listen for execution START events to capture subsequent commands in compound commands
            const startListener = vscode.window.onDidStartTerminalShellExecution(event => {
                if (event.terminal !== term || resolved) {
                    return;
                }
                
                const startedCommand = (event.execution as any)?.commandLine?.value || '';
                console.log('[Terminal] Shell execution STARTED:', startedCommand, 'commandSent:', commandSent);
                
                // If we've sent a command and a new execution starts that's different from our original,
                // this might be the second part of a compound command. Attach to its stream!
                if (commandSent && startedCommand && startedCommand !== command) {
                    console.log('[Terminal] Detected subsequent execution in compound command, attaching to stream...');
                    
                    const newStream = event.execution.read();
                    streamReadingActive = true;
                    
                    (async () => {
                        try {
                            for await (const data of newStream) {
                                if (resolved) {
                                    break;
                                }
                                output += data;
                                console.log('[Terminal] Output chunk from subsequent execution:', data.length, 'chars, total:', output.length);
                                resetInactivityTimer();
                            }
                            console.log('[Terminal] Subsequent execution stream ended. Total output:', output.length, 'chars');
                            streamEnded = true;
                            streamReadingActive = false;
                            
                            await new Promise(resolve => setTimeout(resolve, 100));
                            resetInactivityTimer();
                        } catch (error) {
                            console.error('[Terminal] Error reading subsequent execution stream:', error);
                            streamEnded = true;
                            streamReadingActive = false;
                            resetInactivityTimer();
                        }
                    })();
                }
            });
            disposables.push(startListener);

            // Listen for ANY shell execution end event from our terminal
            const endListener = vscode.window.onDidEndTerminalShellExecution(event => {
                if (event.terminal !== term) {
                    return;
                }
                
                // Get the command that finished (if available)
                const finishedCommand = (event.execution as any)?.commandLine?.value || '';
                console.log('[Terminal] Shell execution ended. exitCode:', event.exitCode, 'command:', finishedCommand, 'currentExecution:', !!currentExecution, 'commandSent:', commandSent, 'outputLength:', output.length, 'streamReadingActive:', streamReadingActive);
                console.log('[Terminal] Event execution matches current?', event.execution === currentExecution);
                lastShellExecutionEvent = event;
                
                // Helper function to resolve with delay to allow stream to catch up
                const resolveWithDelay = (delay: number = 0) => {
                    setTimeout(() => {
                        console.log('[Terminal] Resolving after delay. Final output length:', output.length);
                        doResolve(
                            output || `Command "${command}" completed.`,
                            event.exitCode !== 0 ? `Exit code: ${event.exitCode}` : ''
                        );
                    }, delay);
                };
                
                // CRITICAL: Check for partial command completion FIRST (before exact match)
                // For compound commands (e.g., "cd folder && npm start"), shell integration reports
                // separate executions. Ignore the "cd" part if we haven't received output yet.
                const isPartialCommand = finishedCommand.length > 0 && 
                                       command.includes(finishedCommand) && 
                                       finishedCommand !== command &&
                                       output.length === 0 &&
                                       event.exitCode === 0; // Only ignore successful partial commands
                
                if (isPartialCommand && commandSent) {
                    console.log('[Terminal] Ignoring partial command completion:', finishedCommand);
                    return; // Don't resolve yet - wait for the actual command
                }
                
                // If we have a matching execution, resolve
                if (currentExecution && event.execution === currentExecution) {
                    console.log('[Terminal] Exact execution match - resolving');
                    resolveWithDelay(streamReadingActive ? 500 : 0);
                    return;
                }
                
                // If we sent a command but lost shell integration (terminal refresh scenario)
                if (commandSent && shellIntegrationLost) {
                    console.log('[Terminal] Detected command completion after shell integration loss');
                    resolveWithDelay(streamReadingActive ? 500 : 0);
                    return;
                }
                
                // For compound commands where execution objects don't match:
                // If we have output OR the stream has ended, this is likely our command completing
                if (commandSent && (output.length > 0 || streamEnded)) {
                    console.log('[Terminal] Command sent + (have output OR stream ended), treating as completion');
                    resolveWithDelay(streamReadingActive ? 1000 : 500); // Longer delay for compound commands
                    return;
                }
                
                // If we're waiting for a command and stream is still reading, don't resolve yet
                // This handles the case where cd completes but npm is still starting
                if (commandSent && streamReadingActive) {
                    console.log('[Terminal] Stream still active, waiting for output or completion...');
                    return; // Keep waiting
                }
                
                // Last fallback: any execution from our terminal when command was sent
                if (commandSent) {
                    console.log('[Terminal] Command was sent and execution ended (fallback)');
                    resolveWithDelay(500);
                }
            });
            disposables.push(endListener);

            // Monitor shell integration changes (for terminal refresh scenarios)
            const integrationChangeListener = vscode.window.onDidChangeTerminalShellIntegration(async event => {
                if (event.terminal !== term || resolved) {
                    return;
                }
                
                const hadIntegration = !!currentExecution;
                const hasIntegration = !!event.shellIntegration;
                
                console.log('[Terminal] Shell integration changed. had:', hadIntegration, 'has:', hasIntegration, 'commandSent:', commandSent);

                // Detect when shell integration is LOST (terminal refresh during command execution)
                if (hadIntegration && !hasIntegration && commandSent) {
                    console.log('[Terminal] Shell integration LOST during command execution (terminal refresh detected)');
                    shellIntegrationLost = true;
                    streamEnded = true; // Consider stream ended when integration is lost
                    // Reset inactivity timer to wait for completion
                    resetInactivityTimer();
                }
                
                // Shell integration restored - but DON'T re-execute the command!
                if (!hadIntegration && hasIntegration && commandSent && shellIntegrationLost) {
                    console.log('[Terminal] Shell integration restored after refresh - waiting for completion event');
                    // Just wait for the onDidEndTerminalShellExecution event
                }
            });
            disposables.push(integrationChangeListener);

            // Main function to attach to shell integration and capture output
            const attachToShellIntegration = async (): Promise<boolean> => {
                if (!term.shellIntegration || resolved) {
                    return false;
                }

                try {
                    currentExecution = term.shellIntegration.executeCommand(command);
                    commandSent = true;
                    const executionCommand = (currentExecution as any)?.commandLine?.value || 'unknown';
                    console.log('[Terminal] Executing command with shell integration:', command);
                    console.log('[Terminal] Execution object command:', executionCommand);
                    
                    resetInactivityTimer();

                    // Read the output stream
                    const stream = currentExecution.read();
                    streamReadingActive = true;
                    
                    (async () => {
                        try {
                            for await (const data of stream) {
                                if (resolved) {
                                    break;
                                }
                                output += data;
                                console.log('[Terminal] Output chunk received:', data.length, 'chars, total:', output.length);
                                resetInactivityTimer();
                            }
                            console.log('[Terminal] Output stream ended normally. Total output:', output.length, 'chars');
                            streamEnded = true;
                            streamReadingActive = false;
                            
                            // Give a tiny bit more time for any final output to arrive
                            await new Promise(resolve => setTimeout(resolve, 100));
                            
                            // After stream ends, start inactivity timer
                            // If command actually finished, onDidEndTerminalShellExecution will fire
                            // Otherwise, inactivity timer will resolve after grace period
                            resetInactivityTimer();
                        } catch (error) {
                            console.error('[Terminal] Error reading stream:', error);
                            streamEnded = true;
                            streamReadingActive = false;
                            // Still reset timer to handle gracefully
                            resetInactivityTimer();
                        }
                    })();
                    
                    return true;
                } catch (error) {
                    console.warn('[Terminal] Shell integration failed:', error);
                    commandSent = false;
                    return false;
                }
            };

            // Try shell integration immediately if available
            if (term.shellIntegration) {
                if (await attachToShellIntegration()) {
                    return; // Successfully started with shell integration
                }
            }

            // Wait for shell integration to become available (up to 15 seconds for newly created terminals)
            let waitAttempts = 0;
            const maxWaitAttempts = 150; // 150 * 100ms = 15 seconds (longer wait for new terminals)
            
            const waitInterval = setInterval(async () => {
                waitAttempts++;
                
                if (resolved) {
                    clearInterval(waitInterval);
                    return;
                }
                
                if (term.shellIntegration && !commandSent) {
                    clearInterval(waitInterval);
                    console.log('[Terminal] Shell integration became available after', waitAttempts * 100, 'ms');
                    if (await attachToShellIntegration()) {
                        return; // Successfully started
                    }
                }
                
                // Log progress every 2 seconds
                if (waitAttempts % 20 === 0) {
                    console.log(`[Terminal] Still waiting for shell integration... (${waitAttempts * 100}ms elapsed)`);
                }
                
                // Timeout waiting for shell integration
                if (waitAttempts >= maxWaitAttempts) {
                    clearInterval(waitInterval);
                    console.error('[Terminal] Shell integration not available after 15 seconds');
                    console.error('[Terminal] This is unusual - shell integration should be available in a properly configured terminal');
                    
                    // Give up and return error
                    doResolve(
                        `Error: Shell integration not available after 15 seconds. This terminal may not support shell integration. Please check your terminal configuration or try closing and reopening VS Code.`,
                        'Warning: Cannot execute commands without shell integration'
                    );
                }
            }, 100);
        });
    }
    
    public async similar_search(query: string, limit: number = 8): Promise<object[]> {
        if (!state.table) {
            return [{ error: 'Database not initialized' }];
        }

        try {
            await initializeEmbedder();
            const embedding = await embedQuery(query);
            const results = await state.table.vectorSearch(embedding).limit(limit).toArray();
            return results.map(result => ({
                filePath: result.filePath,
                startLine: result.startLine,
                endLine: result.endLine,
                chunkType: result.chunkType,
                content: result.content,
                score: result._distance
            }));
        } catch (error) {
            return [{ error: error }];
        }
    }

    private getAbsolutePath(filePath: string): string {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }
        
        if (this.workingDirectory) {
            return path.join(this.workingDirectory, filePath);
        }
        
        if (vscode.workspace.workspaceFolders) {
            return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, filePath);
        }
        // This is a fallback, but the agent should be working in a workspace.
        return filePath;
    }
}

export class AgentService {
    private toolbox = new ToolBox();
    private shouldStop = false;
    private currentAbortController?: AbortController;
    private terminalCommandCallback?: (command: string) => Promise<boolean>;
    private recentThoughts: string[] = []; // last up to 5 raw thoughts
    private summarizedArchive: string = ''; // cumulative summary of ALL prior (evicted) thoughts
    private summarizing: boolean = false;
    private readonly MAX_RECENT_THOUGHTS = 5;
    private pendingSummaryTimeout?: NodeJS.Timeout;

    constructor() {
    }

    public setTerminalCommandCallback(callback: (command: string) => Promise<boolean>) {
        this.terminalCommandCallback = callback;
        this.toolbox.setTerminalCommandCallback(callback);
    }

    public setWorkingDirectory(directory: string) {
        this.toolbox.setWorkingDirectory(directory);
    }

    private async summarizeEvictedThought(evicted: string, remainingRecent: string[], sendUpdate: (u: string)=>void, serverUrl: string) {
        // If this is the first eviction, show it directly as the previous thought summary without calling the endpoint.
        if (!this.summarizedArchive) {
            this.summarizedArchive = `[*] ${evicted}`;
            // Quiet UI: log to console instead of UI
            console.log('[ThoughtSummary] Initialized rolling summary with first evicted thought.');
            return;
        }

        // Debounce rapid consecutive evictions to batch them slightly
        if (this.pendingSummaryTimeout) {
            clearTimeout(this.pendingSummaryTimeout);
        }
        // Append the evicted thought directly without summarizing
        const needsNewline = this.summarizedArchive.length > 0 && !this.summarizedArchive.endsWith('\n');
        this.summarizedArchive += `${needsNewline ? '\n' : ''}[*] ${evicted}`;
        console.log(`[ThoughtSummary] Appended evicted thought. Summary length ${this.summarizedArchive.length}`);
        // If the rolling summary itself grows too large, ask for a shorter version.
        if (this.summarizedArchive.length > 10000) {
            await this.shortenArchiveIfTooLong(sendUpdate, serverUrl);
        }
    }

    private async shortenArchiveIfTooLong(sendUpdate: (u: string)=>void, serverUrl: string) {
        if (this.summarizing) { return; }
        if (!this.summarizedArchive || this.summarizedArchive.length <= 2000) { return; }
        try {
            this.summarizing = true;
            const prompt = `Shorten the following rolling summary to ~1200 characters while preserving all key decisions, constraints, unresolved items, and next actions. Use compact bullets or short paragraphs.\n\n${this.summarizedArchive}`;
            console.log('[ThoughtSummary] Shortening rolling summary (too long).');
            const resp = await fetch(serverUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: prompt, user_ID: '0001' }) });
            if (!resp.ok) {
                console.warn(`[ThoughtSummary] Shorten request failed status ${resp.status}`);
                return;
            }
            const jr = await resp.json();
            let text: string = jr.response || '';
            const match = text.match(/```(?:markdown|text)?\n([\s\S]*?)```/);
            if (match && match[1]) { text = match[1]; }
            this.summarizedArchive = text.trim();
            console.log(`[ThoughtSummary] Shortened summary length ${this.summarizedArchive.length}`);
        } catch (e: any) {
            console.warn(`[ThoughtSummary] Error while shortening: ${e.message}`);
        } finally {
            this.summarizing = false;
        }
    }

    private async summarizeLongThought(rawThought: string, sendUpdate: (u: string)=>void, serverUrl: string) {
        try {
            const prompt = `Summarize the following agent thought into <= 400 characters, preserving concrete next actions, file targets, and decisions. Remove repetition.\n\n${rawThought}`;
            console.log(`[Thoughts] Summarizing the thought output`);
            const resp = await fetch(serverUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: prompt, user_ID: '0001' }) });
            if (!resp.ok) {
                console.warn(`[Thoughts] Thought summarization failed with status ${resp.status}`);
                return;
            }
            const jr = await resp.json();
            let text: string = jr.response || '';
            const match = text.match(/```(?:markdown|text)?\n([\s\S]*?)```/);
            if (match && match[1]) { text = match[1]; }
            const condensed = text.trim();
            return condensed;
        } catch (e: any) {
            console.warn(`[Thoughts] Error summarizing long thought: ${e.message}`);
            return rawThought;
        }
    }

    private async summarizeOriginalPrompt(prompt: string, serverUrl: string): Promise<string> {
        // Define the character limit for the summary and for the fallback truncation.
        const SUMMARY_MAX_LENGTH = 50000;
        
        // Create a fallback response in case the summarization fails.
        const fallbackResponse = prompt.substring(0, SUMMARY_MAX_LENGTH) + 
                                "\n\n... [Original prompt was too long and summarization failed. The prompt has been truncated.] ...";
        
        if (prompt.length > 1000000) { return fallbackResponse; }

        try {
            const summarizationInstruction = `Summarize the following user request into a clear and concise objective for an AI agent. Focus on the primary goal, key constraints, and specific files or functions mentioned. The summary should be a direct command. Maximum ${SUMMARY_MAX_LENGTH} characters.\n\nOriginal Request:\n${prompt}`;
            
            console.log(`[AgentService] Summarizing original prompt.`);
            const resp = await fetch(serverUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: summarizationInstruction, user_ID: '0001' }) });

            if (!resp.ok) {
                console.warn(`[AgentService] Prompt summarization failed with status ${resp.status}. Returning truncated prompt.`);
                return fallbackResponse; // Return truncated prompt on failure
            }

            const jr = await resp.json();
            let text: string = jr.response || '';
            const match = text.match(/```(?:markdown|text)?\n([\s\S]*?)```/);
            if (match && match[1]) { text = match[1]; }

            const condensed = text.trim();
            
            // If the model returns an empty summary, also use the truncated fallback.
            return condensed.length > 0 ? condensed : fallbackResponse;

        } catch (e: any) {
            console.warn(`[AgentService] Error summarizing original prompt: ${e.message}. Returning truncated prompt.`);
            return fallbackResponse; // Return truncated prompt on error
        }
    }

    private normalizeThought(t: string): string {
        return t.replace(/\s+/g, ' ').trim();
    }
    private async recordThought(thought: string | undefined, sendUpdate: (u: string)=>void, serverUrl: string) {
        if (!thought) { return; }
        const norm = this.normalizeThought(thought);
        if (!norm) { return; }
        // If same as the most recent stored thought, skip to avoid repetition noise
        const last = this.recentThoughts[this.recentThoughts.length - 1];
        if (last && this.normalizeThought(last) === norm) {
            // Quiet UI: skip duplicate without notifying UI
            return;
        }
        // If the thought is very long, temporarily truncate for display and kick off an async summarization
        // so the recent list gets a condensed version shortly after.
        let finalThought: any = norm;
        const LONG_THOUGHT_THRESHOLD = 1000;
        const isLong = finalThought.length > LONG_THOUGHT_THRESHOLD;
        if (isLong) {
            finalThought = await this.summarizeLongThought(finalThought, sendUpdate, serverUrl);
        }
        if (this.recentThoughts.length >= this.MAX_RECENT_THOUGHTS) {
            const evicted = this.recentThoughts.shift();
            if (evicted) {
                // Add to rolling summary (not losing content)
                const remaining = this.recentThoughts.slice();
                await this.summarizeEvictedThought(evicted, remaining, sendUpdate, serverUrl);
            }
        }
        this.recentThoughts.push(finalThought);
        // If long, summarize asynchronously and replace the truncated version in-place when ready.
    }

    private buildThoughtSections() {
        const thoughtsSection = this.recentThoughts.length ? `Recent Model Thoughts (most recent last):\n<recentModelThoughts>\n${this.recentThoughts.map((t,i)=>`[${i+1}] ${t}`).join('\n')}\n</recentModelThoughts>` : 'Recent Model Thoughts: \n<recentModelThoughts>(none yet)</recentModelThoughts>';
        const archiveSummarySection = this.summarizedArchive ? `Previous Thought Summary:\n<previousThoughtSummary>\n${this.summarizedArchive}\n</previousThoughtSummary>\n` : '';
        return { thoughtsSection, archiveSummarySection };
    }

    public getThoughtsDebug() {
        return { recentThoughts: this.recentThoughts.slice(), summarizedArchive: this.summarizedArchive };
    }

    public async processRequest(prompt: string, serverUrl: string, sendUpdate: (update: string) => void) {
        // Quiet UI: no initial debug to UI; log minimal info to console
        console.log(`[AgentService] processRequest start. WD=${this.toolbox.getWorkingDirectory() || 'Not set'} promptLen=${prompt.length}`);
        this.shouldStop = false;
        let history: { action: string, result: any }[] = [];
        const maxSteps = 60;
        // Preserve the original user request for all subsequent iterations.
        let originalPrompt = prompt;
        
        const PROMPT_LENGTH_THRESHOLD = 100000;
        if (originalPrompt.length > PROMPT_LENGTH_THRESHOLD) {
            originalPrompt = await this.summarizeOriginalPrompt(originalPrompt, serverUrl);
        }

        let currentInstruction = originalPrompt; // Instruction for the model (first step uses full prompt)
        
        let isFirstStep = true;
        for (let i = 0; i < maxSteps; i++) {
            if (this.shouldStop) {
                sendUpdate("❌ Stopped by user.");
                return;
            }
            if(isFirstStep) {
                this.recentThoughts = [];
                this.summarizedArchive = '';
            }
            console.log(`[Agent] Step ${i + 1}`);
            const { tool, args, thought } = await this.getNextActionFromModel(currentInstruction, originalPrompt, history, sendUpdate, serverUrl);
            await this.recordThought(thought, sendUpdate, serverUrl);
            if (this.shouldStop) {
                sendUpdate("❌ Stopped by user.");
                return;
            }
            if (isFirstStep) {
                isFirstStep = false;
                // After first step, switch to continuation instruction while retaining originalPrompt separately.
                currentInstruction = "Continue with the next step based on the history to complete the original request.";
            }
            if (tool === 'finish') {
                sendUpdate(`✅ Done: ${args[0]}`);
                return;
            }
            if (tool === 'retry_with_valid_json') {
                history.push({ action: `invalid_json_response`, result: args[0] });
                continue; // retry loop
            }
            const availableTools = this.getToolDefinitions();
            const availableToolNames = availableTools.map(t => t.name);
            if (!availableToolNames.includes(tool) && !(this.toolbox as any)[tool]) {
                const errorMsg = `Unknown tool: ${tool}`;
                sendUpdate(`❌ ${errorMsg}`);
                history.push({ action: `unknown_tool(${tool})`, result: errorMsg });
                continue;
            }

            const { startMsg, doneMsg } = this.getToolMessages(tool, args, availableTools);
            if (startMsg) {
                sendUpdate(`⏳ ${startMsg}`);
            }
            try {
                // @ts-ignore
                const result = await this.toolbox[tool](...args);
                const resultString = JSON.stringify(result, null, 2);
                history.push({ action: `${tool}(${args.map((a: any) => JSON.stringify(a)).join(', ')})`, result: resultString });
                if (doneMsg) {
                    sendUpdate(`✅ ${doneMsg}`);
                }
            } catch (error: any) {
                const errorMessage = `Error executing ${tool}: ${error.message}`;
                if (doneMsg) {
                    sendUpdate(`❌ ${doneMsg} — ${error.message}`);
                } else {
                    sendUpdate(`❌ ${errorMessage}`);
                }
                console.warn(`Tool execution error at step ${i + 1}: ${error.message}`);
                console.warn(error.stack);
                history.push({ action: `${tool}(${args.map((a: any) => JSON.stringify(a)).join(', ')})`, result: errorMessage });
            }
        }
        sendUpdate("Agent stopped after reaching max steps.");
    }

    public stop() {
        this.shouldStop = true;
        if (this.currentAbortController) {
            this.currentAbortController.abort();
        }
    }

    private getToolDefinitions() {
        return [
            { name: 'list_files', description: 'List files in the workspace with pagination. Returns an object with files array, total count, and hasMore flag. Use offset and limit for pagination.', args: [{ name: 'offset', type: 'number' }, { name: 'limit', type: 'number' }] },
            { name: 'search_files', description: 'Search for files by NAME or pattern only (does NOT search file contents).', args: [{ name: 'pattern', type: 'string' }] },
            { name: 'search_text', description: 'Search for a keyword across file CONTENTS. Returns file paths with matching line numbers and snippets.', args: [{ name: 'keyword', type: 'string' }, { name: 'maxFiles', type: 'number' }, { name: 'maxMatchesPerFile', type: 'number' }] },
            { name: 'read_file', description: 'Read the FULL content of a file at a given relative path. CRITICAL: If a file is too long, this tool will fail and instruct you to use search_in_file or read_file_chunk instead.', args: [{ name: 'filePath', type: 'string' }] },
            { name: 'search_in_file', description: 'Search for a specific keyword within a single file (given relative path). This is the most efficient way to find relevant code in long files. Returns the matching lines with surrounding context.', args: [{ name: 'filePath', type: 'string' }, { name: 'keyword', type: 'string' }] },
            { name: 'read_file_chunk', description: 'Read a large file in smaller pieces (chunks) (arg is relative file path). Use this if you need to understand the overall structure of a long file.', args: [{ name: 'filePath', type: 'string' }, { name: 'chunkNumber', type: 'number' }, { name: 'chunkSize', type: 'number' }] },
            { name: 'apply_file_change', description: 'Apply a change to a file immediately without asking user permission. Changes are applied instantly and user sees diffs with accept/reject buttons. Continue with next action immediately. Returns a status message.', args: [{ name: 'filePath', type: 'string' }, { name: 'newContent', type: 'string' }] },
            { name: 'run_terminal_command', description: 'Run a shell command in the workspace root. Asks for user permission first. Returns stdout and stderr.', args: [{ name: 'command', type: 'string' }] },
            { name: 'similar_search', description: 'Perform semantic similarity search on the indexed codebase to find relevant code snippets. Useful for understanding code patterns or finding similar implementations. Returns list of matching chunks with metadata and similarity score.', args: [{ name: 'query', type: 'string' }, { name: 'limit', type: 'number' }] },
            { name: 'finish', description: 'Finishes the task with a message.', args: [{ name: 'message', type: 'string' }] }
        ];
    }

    private async getNextActionFromModel(currentInstruction: string, originalPrompt: string, history: any[], sendUpdate: (update: string) => void, serverUrl: string): Promise<{ tool: string, args: any[], thought: string }> {
    console.log("[AgentService] Asking the model for the next step...");
    console.log(`[AgentService] Making request to: ${serverUrl}`);

        const showInstruction = currentInstruction.trim() !== originalPrompt.trim();
        const currentInstructionSection = showInstruction ? currentInstruction: "This is your first iteration.";

        const systemPrompt = `You are an expert AI programmer agent.
Your goal is to complete the user's ORIGINAL request.

CRITICAL INSTRUCTIONS:
1. You operate autonomously - make file changes immediately without asking permission
2. apply_file_change tool applies changes instantly to files
3. Users see diffs with accept/reject buttons after you make changes
4. NEVER ask "Should I..." or "Would you like me to..." - just do it
5. Complete the entire task by making all necessary changes
6. When task is finished always test before calling 'finish' tool
7. Only use 'finish' when the task is completely done

IMPORTANT: Use tools efficiently to explore codebase:
- search_files(pattern) to find specific files by name/pattern (e.g., "separable" finds separable.py)
- list_files(offset, limit) for paginated browsing when exploring structure 
- To list more files, you MUST increment the 'offset' parameter in 'list_files'. DO NOT just increase the 'limit'.
- list_files(0, 100) gets first 100 files, list_files(100, 100) gets next 100
- The response includes hasMore flag to indicate if there are more files

CRITICAL WORKFLOW FOR READING FILES:
1. Your first step when reading a file should ALWAYS be the 'read_file' tool.
2. If 'read_file' returns a "File is too long" error, your immediate next step MUST be to use the 'search_in_file' tool with a relevant keyword from the problem description. Do NOT use 'read_file_chunk' unless you have a specific reason to read from the beginning.
3. Only use 'read_file_chunk' if you need to browse the file from the start or 'search_in_file' does not yield results.

CRITICAL INSTRUCTIONS FOR TESTING THE APPLICATION:
1. Consider the language or framework you are dealing with when testing
2. First check for any compilation errors. To accomplish this you can try compiling or building the application
3. Try running tests if any available. If not found or user denies testing just move on

You operate in a loop. In each step, choose the appropriate tool and execute it.
Do not ask for clarification or permission.

Tools:
${JSON.stringify(this.getToolDefinitions())}

Respond with a single JSON object with two keys: "thought" and "tool_call".
"thought" should be a string explaining your reasoning for the chosen action.
"tool_call" should be an object with two keys: "name" and "args".
Example response:
{
    "thought": "I need to see the files in the workspace to understand the project structure.",
    "tool_call": {
        "name": "list_files",
        "args": {"offset": 0, "limit": 100}
    }
}`;

        const MODEL_TOTAL_CONTEXT_CHARS = 500000; // Approx. 125k tokens
        const HISTORY_CHAR_BUDGET = MODEL_TOTAL_CONTEXT_CHARS - systemPrompt.length - originalPrompt.length;
        let ENTRY_BUDGET = HISTORY_CHAR_BUDGET;
        const FAIR_ENTRY_BUDGET = (HISTORY_CHAR_BUDGET / history.length) * 2;

        let currentChars = 0;
        const truncatedHistory = [];

        // Loop backwards from the most recent entry to the oldest.
        for (let i = history.length - 1; i >= 0; i--) {
            const entry = history[i];

            // Truncate very long individual results to prevent any single entry from dominating.
            let result = entry.result;
            if (typeof result === 'string' && (result.length > ENTRY_BUDGET || result.length > FAIR_ENTRY_BUDGET)) {
                result = result.substring(0, ENTRY_BUDGET) + '... [TRUNCATED - content too long]';
            }

            const sanitizedEntry = { action: entry.action, result: result };
            const entryString = JSON.stringify(sanitizedEntry);

            // Check if adding this next entry would blow our budget.
            if (currentChars + entryString.length > HISTORY_CHAR_BUDGET) {
                // If so, we have enough history and can stop.
                break;
            }

            // Add the entry to the beginning of our new array to maintain the correct order.
            truncatedHistory.unshift(sanitizedEntry);
            currentChars += entryString.length;
            ENTRY_BUDGET -= currentChars;
        }

        const { thoughtsSection, archiveSummarySection } = this.buildThoughtSections();
        // Build an XML-delimited prompt for more reliable parsing
        const fullPrompt = 
`System Prompt:
<systemPrompt>
${systemPrompt}
</systemPrompt>

Original User Request:
<originalUserRequest>
${originalPrompt}
</originalUserRequest>

Current Instruction:
<currentInstruction>
${currentInstructionSection}
</currentInstruction>

${archiveSummarySection}\n${thoughtsSection}

Tool Call History (most recent last):
<toolCallHistory>
${JSON.stringify(truncatedHistory)}
</toolCallHistory>`;

    console.log(`[AgentService] Full prompt length: ${fullPrompt.length}, history: ${history.length} -> ${truncatedHistory.length}`);

        try {
            this.currentAbortController = new AbortController();
            
            console.log(`[AgentService] Making fetch request to: ${serverUrl}`);
            console.log(`[AgentService] Request payload length: ${JSON.stringify({ query: fullPrompt, user_ID: "0001" }).length} characters`);
            
            const response = await fetch(serverUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ 
                    query: fullPrompt,
                    user_ID: "0001"
                }),
                signal: this.currentAbortController.signal
            });

            console.log(`[AgentService] Received response with status: ${response.status}`);

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[AgentService] Server error: ${response.status} - ${errorText}`);
                return {
                    thought: `The model API call failed with status ${response.status}.`,
                    tool: 'finish',
                    args: [`Model API error: ${errorText}`]
                };
            }

            const jsonResponse = await response.json();
            console.log(`[AgentService] Response JSON keys: ${Object.keys(jsonResponse)}`);

            // Check if server returned an error
            if (jsonResponse.error) {
                console.warn(`Server returned error: ${jsonResponse.error}`);
                return {
                    thought: "Server returned an error.",
                    tool: 'finish',
                    args: [`Server error: ${jsonResponse.error}`]
                };
            }

            let modelResponseText = jsonResponse.response;
            console.log(`[AgentService] Model response length: ${modelResponseText ? modelResponseText.length : 0}`);

            // Check if the response field is missing
            if (!modelResponseText) {
                console.warn(`[AgentService] Empty/missing response. Full: ${JSON.stringify(jsonResponse, null, 2)}`);
                return {
                    thought: "Server returned empty or missing response field.",
                    tool: 'finish',
                    args: [`Server returned empty response. Full response: ${JSON.stringify(jsonResponse)}`]
                };
            }

            // Check if the response is wrapped in markdown code blocks
            const jsonMatch = modelResponseText.match(/```(json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch && jsonMatch[2]) {
                console.log(`Found JSON in markdown, extracting...`);
                modelResponseText = jsonMatch[2];
            }
            console.log(`Parsing JSON response...`);
            
            let modelOutput;
            try {
                // First try parsing as-is
                modelOutput = JSON.parse(modelResponseText);
            } catch (firstError: any) {
                try {
                    // Simple approach: find and fix the specific issue with unescaped characters
                    // The most common issue is unescaped newlines and quotes in the "thought" field
                    let fixedJson = modelResponseText;
                    
                    // Look for the pattern: "thought": "some text with unescaped chars"
                    fixedJson = fixedJson.replace(/"thought":\s*"([^"]*(?:\\.[^"]*)*)"(?=\s*[,}])/g, (match: string, content: string) => {
                        // Properly escape the content
                        const escaped = content
                            .replace(/\\/g, '\\\\')  // Escape backslashes first
                            .replace(/"/g, '\\"')    // Escape quotes
                            .replace(/\n/g, '\\n')   // Escape newlines
                            .replace(/\r/g, '\\r')   // Escape carriage returns
                            .replace(/\t/g, '\\t');  // Escape tabs
                        return `"thought": "${escaped}"`;
                    });
                    
                    modelOutput = JSON.parse(fixedJson);
                } catch (secondError: any) {
                    // If still failing, try removing problematic content after the JSON
                    try {
                        // Look for the JSON object boundaries and extract just that
                        const jsonStart = modelResponseText.indexOf('{');
                        const jsonEnd = modelResponseText.lastIndexOf('}');
                        console.warn(`JSON parsing failed after attempts: ${firstError.message || firstError}`);
                        console.warn(`Full raw response: ${modelResponseText}`);
                        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
                            const extractedJson = modelResponseText.substring(jsonStart, jsonEnd + 1);
                            modelOutput = JSON.parse(extractedJson);
                        } else {
                            throw new Error('Could not find valid JSON boundaries');
                        }
                    } catch (thirdError: any) {
                        const errorMessage = `Failed to parse model response as JSON. The model returned malformed text. Error: ${firstError.message || firstError}. Full response: ${modelResponseText}`;
                        console.warn(`[Agent Error] (JSON parsing error) ${errorMessage}`);
                        return {
                            thought: "The last response was not valid JSON. I must correct my output format and try again.",
                            tool: 'retry_with_valid_json',
                            args: [`JSON parsing error: ${errorMessage}`]
                        };
                    }
                }
            }
            console.log(`Parsed model output keys: ${Object.keys(modelOutput)}`);
            
            // Validate model output structure
            if (!modelOutput.tool_call) {
                console.warn(`Model output missing tool_call field`);
                return {
                    thought: modelOutput.thought || "Model response missing tool_call",
                    tool: 'finish',
                    args: [`Invalid model response: missing tool_call field`]
                };
            }
            
            if (!modelOutput.tool_call.name) {
                console.warn(`Model output missing tool_call.name field`);
                return {
                    thought: modelOutput.thought || "Model response missing tool name",
                    tool: 'finish',
                    args: [`Invalid model response: missing tool_call.name field`]
                };
            }
            
            const toolName = modelOutput.tool_call.name;
            let args = modelOutput.tool_call.args;
            console.log(`Tool name: ${toolName}, args type: ${typeof args}`);

            // Convert args from object to array based on tool definition
            if (!Array.isArray(args) && typeof args === 'object' && args !== null) {
                const toolDef = this.getToolDefinitions().find(t => t.name === toolName);
                if (toolDef && toolDef.args) {
                    args = toolDef.args.map((argDef: any) => {
                        const value = args[argDef.name];
                        // Handle optional parameters with defaults
                        if (value === undefined) {
                            if (argDef.name === 'offset') {
                                return 0;
                            }
                            if (argDef.name === 'limit') {
                                return 100;
                            }
                        }
                        return value;
                    });
                    console.log(`Converted object args to array: ${JSON.stringify(args)}`);
                } else {
                    // If no tool definition found or no args defined, convert object values to array
                    args = Object.values(args);
                    console.log(`Converted object values to array: ${JSON.stringify(args)}`);
                }
            } else if (!Array.isArray(args)) {
                args = [];
                console.log(`No args provided, using empty array`);
            }

            console.log(`Final result - tool: ${toolName}, args: ${JSON.stringify(args)}, thought length: ${modelOutput.thought?.length || 0}`);

            return {
                thought: modelOutput.thought,
                tool: toolName,
                args: args
            };

        } catch (error: any) {
            this.currentAbortController = undefined;
            console.warn(`Error in getNextActionFromModel: ${error.message}`);
            
            if (error.name === 'AbortError') {
                console.log(`Request was aborted`);
                return {
                    thought: "Request was stopped by user.",
                    tool: 'finish',
                    args: ["Request was stopped by user."]
                };
            }
            
            console.warn(`Network or parsing error: ${error.message}`);
            return {
                thought: "There was an error calling the model.",
                tool: 'finish',
                args: [`Error calling model: ${error.message}`]
            };
        } finally {
            this.currentAbortController = undefined;
        }
    }

    // Map tool name/args to brief user-facing messages
    private getToolMessages(toolName: string, args: any[], toolDefs: Array<{name: string, args?: Array<{name: string}>}>): { startMsg: string, doneMsg: string } {
        const def = toolDefs.find(t => t.name === toolName);
        let argMap: Record<string, any> = {};
        if (def && Array.isArray(def.args)) {
            argMap = def.args.reduce((acc, defArg, idx) => {
                acc[defArg.name] = args[idx];
                return acc;
            }, {} as Record<string, any>);
        }
        const truncate = (s: any, n = 60) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) + '…' : s) : s);
        switch (toolName) {
            case 'read_file': {
                const fp = argMap.filePath ?? args[0];
                return { startMsg: `Reading file ${fp}`, doneMsg: `Read file ${fp}` };
            }
            case 'read_file_chunk': {
                const fp = argMap.filePath ?? args[0];
                const chunk = argMap.chunkNumber ?? args[1] ?? 1;
                return { startMsg: `Reading chunk ${chunk} of ${fp}`, doneMsg: `Read chunk ${chunk} of ${fp}` };
            }
            case 'search_files': {
                const p = argMap.pattern ?? args[0];
                return { startMsg: `Searching files "${truncate(p)}"`, doneMsg: `Searched files` };
            }
            case 'list_files': {
                const off = argMap.offset ?? args[0];
                const lim = argMap.limit ?? args[1];
                return { startMsg: `Listing files (offset ${off}, limit ${lim})`, doneMsg: `Listed files` };
            }
            case 'search_text': {
                const k = argMap.keyword ?? args[0];
                return { startMsg: `Searching text "${truncate(k)}"`, doneMsg: `Searched text` };
            }
            case 'search_in_file': {
                const fp = argMap.filePath ?? args[0];
                const k = argMap.keyword ?? args[1];
                return { startMsg: `Searching "${truncate(k)}" in ${fp}`, doneMsg: `Searched in ${fp}` };
            }
            case 'apply_file_change': {
                const fp = argMap.filePath ?? args[0];
                return { startMsg: `Applying change to ${fp}`, doneMsg: `Applied change to ${fp}` };
            }
            case 'run_terminal_command': {
                const cmd = args[0];
                return { startMsg: `Running command: ${truncate(cmd)}`, doneMsg: `Ran command` };
            }
            case 'similar_search': {
                const q = argMap.query ?? args[0];
                return { startMsg: `Semantic search "${truncate(q)}"`, doneMsg: `Semantic search done` };
            }
            default:
                return { startMsg: `Running ${toolName}`, doneMsg: `${toolName} done` };
        }
    }
}