// src/service/AgentService.ts
import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { DiffManager } from './DiffManager';

// The ToolBox holds the set of functions the agent can execute.
class ToolBox {
    private diffManager: DiffManager;
    private terminalCommandCallback?: (command: string) => Promise<boolean>;
    private workingDirectory: string = '';

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

    public async list_files(): Promise<string[]> {
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
            
            return getAllFiles(this.workingDirectory);
        } else {
            // Find all files, ignoring .git, node_modules, and other common exclusions
            const files = await vscode.workspace.findFiles('**/*', '{.git,node_modules,**/__pycache__,.vscode}/**');
            return files.map(file => vscode.workspace.asRelativePath(file));
        }
    }

    public async read_file(filePath: string): Promise<string> {
        const absolutePath = this.getAbsolutePath(filePath);
        try {
            return await fs.readFile(absolutePath, 'utf-8');
        } catch (error) {
            return `Error reading file: ${error}`;
        }
    }

    public async apply_file_change(filePath: string, newContent: string): Promise<string> {
        console.log(`[ToolBox] apply_file_change called with filePath: ${filePath}, working directory: ${this.workingDirectory}`);
        
        if (this.workingDirectory) {
            // For SWE-bench mode, write files directly without using DiffManager
            const absolutePath = this.getAbsolutePath(filePath);
            const fs = require('fs');
            const path = require('path');
            
            console.log(`[ToolBox] Writing to absolute path: ${absolutePath}`);
            
            try {
                // Ensure directory exists
                const dir = path.dirname(absolutePath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                    console.log(`[ToolBox] Created directory: ${dir}`);
                }
                
                // Write the file directly
                fs.writeFileSync(absolutePath, newContent, 'utf-8');
                console.log(`[ToolBox] Successfully wrote file: ${absolutePath}`);
                return `Successfully wrote file: ${filePath}`;
            } catch (error) {
                console.error(`[ToolBox] Error writing file ${filePath}:`, error);
                return `Error writing file ${filePath}: ${error}`;
            }
        } else {
            // Normal mode - use DiffManager
            console.log(`[ToolBox] Using DiffManager for file: ${filePath}`);
            return await this.diffManager.applyChangeWithDiff(filePath, newContent);
        }
    }

    public async run_terminal_command(command: string): Promise<{ stdout: string, stderr: string }> {
        let allow = false;
        
        if (this.terminalCommandCallback) {
            allow = await this.terminalCommandCallback(command);
        } else {
            // Fallback to popup if no callback is set
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

        const cwd = this.workingDirectory || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        return new Promise((resolve) => {
            exec(command, { cwd }, (error, stdout, stderr) => {
                resolve({ stdout, stderr: error ? error.message : stderr });
            });
        });
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

    constructor() {
    }

    public setTerminalCommandCallback(callback: (command: string) => Promise<boolean>) {
        this.terminalCommandCallback = callback;
        this.toolbox.setTerminalCommandCallback(callback);
    }

    public setWorkingDirectory(directory: string) {
        this.toolbox.setWorkingDirectory(directory);
    }

    public async processRequest(prompt: string, serverUrl: string, sendUpdate: (update: string) => void) {
        console.log(`[AgentService] Starting processRequest with serverUrl: ${serverUrl}`);
        console.log(`[AgentService] Working directory: ${this.toolbox.getWorkingDirectory() || 'Not set'}`);
        console.log(`[AgentService] Prompt length: ${prompt.length} characters`);
        
        this.shouldStop = false;
        let history: { action: string, result: any }[] = [];
        const maxSteps = 200;

        for (let i = 0; i < maxSteps; i++) {
            if (this.shouldStop) {
                console.log(`[AgentService] Agent stopped by user at step ${i + 1}`);
                sendUpdate("Agent stopped by user.");
                return;
            }

            sendUpdate(`## Step ${i + 1}`);
            console.log(`[AgentService] Starting step ${i + 1}/${maxSteps}`);

            const { tool, args, thought } = await this.getNextActionFromModel(prompt, history, sendUpdate, serverUrl);
            console.log(`[AgentService] Step ${i + 1} result - tool: ${tool}, args: ${JSON.stringify(args)}, thought: ${thought}`);

            if (this.shouldStop) {
                console.log(`[AgentService] Agent stopped by user after getting model response at step ${i + 1}`);
                sendUpdate("Agent stopped by user.");
                return;
            }

            if (thought) {
                sendUpdate(`Thought: ${thought}`);
            }

            if (tool === 'finish') {
                console.log(`[AgentService] Agent finished at step ${i + 1} with message: ${args[0]}`);
                sendUpdate(`**Agent finished: ${args[0]}**`);
                return;
            }

            if (!Object.getOwnPropertyNames(ToolBox.prototype).includes(tool)) {
                const errorMsg = `Error: Model tried to use an unknown tool: ${tool}`;
                console.error(`[AgentService] Unknown tool error at step ${i + 1}: ${tool}`);
                sendUpdate(errorMsg);
                history.push({ action: `unknown_tool(${tool})`, result: errorMsg });
                continue;
            }

            sendUpdate(`Action: ${tool}(${args.map((a: any) => JSON.stringify(a)).join(', ')})`);
            console.log(`[AgentService] Executing tool: ${tool} with args:`, args);

            try {
                // @ts-ignore
                const result = await this.toolbox[tool](...args);
                const resultString = JSON.stringify(result, null, 2);
                history.push({ action: `${tool}(${args.map((a: any) => JSON.stringify(a)).join(', ')})`, result: resultString });
                sendUpdate(`Result: ${resultString.substring(0, 500)}${resultString.length > 500 ? '...' : ''}`);
                console.log(`[AgentService] Tool ${tool} result:`, resultString.substring(0, 200));
            } catch (error: any) {
                const errorMessage = `Error executing tool: ${error.message}`;
                console.error(`[AgentService] Tool execution error at step ${i + 1}:`, error);
                history.push({ action: `${tool}(${args.map((a: any) => JSON.stringify(a)).join(', ')})`, result: errorMessage });
                sendUpdate(errorMessage);
            }
        }
        console.log(`[AgentService] Agent stopped after reaching max steps (${maxSteps})`);
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
            { name: 'list_files', description: 'List all files in the workspace. Returns an array of relative file paths.' },
            { name: 'read_file', description: 'Read the content of a file at a given relative path.', args: [{ name: 'filePath', type: 'string' }] },
            { name: 'apply_file_change', description: 'Apply a change to a file immediately without asking user permission. Changes are applied instantly and user sees diffs with accept/reject buttons. Continue with next action immediately. Returns a status message.', args: [{ name: 'filePath', type: 'string' }, { name: 'newContent', type: 'string' }] },
            { name: 'run_terminal_command', description: 'Run a shell command in the workspace root. Asks for user permission first. Returns stdout and stderr.', args: [{ name: 'command', type: 'string' }] },
            { name: 'finish', description: 'Finishes the task with a message.', args: [{ name: 'message', type: 'string' }] }
        ];
    }

    private async getNextActionFromModel(prompt: string, history: any[], sendUpdate: (update: string) => void, serverUrl: string): Promise<{ tool: string, args: any[], thought: string }> {
        sendUpdate("Asking the model for the next step...");
        console.log(`[AgentService] Making request to: ${serverUrl}`);

        const systemPrompt = `
            You are an expert AI programmer agent.
            Your goal is to complete the user's request: "${prompt}"
            
            CRITICAL INSTRUCTIONS:
            1. You operate autonomously - make file changes immediately without asking permission
            2. apply_file_change tool applies changes instantly to files
            3. Users see diffs with accept/reject buttons after you make changes
            4. NEVER ask "Should I..." or "Would you like me to..." - just do it
            5. Complete the entire task by making all necessary changes
            6. Only use 'finish' when the task is completely done
            
            You operate in a loop. In each step, choose the appropriate tool and execute it.
            Do not ask for clarification or permission.

            Tools:
            ${JSON.stringify(this.getToolDefinitions(), null, 2)}

            Respond with a single JSON object with two keys: "thought" and "tool_call".
            "thought" should be a string explaining your reasoning for the chosen action.
            "tool_call" should be an object with two keys: "name" and "args".
            Example response:
            {
                "thought": "I need to see the files in the workspace to understand the project structure.",
                "tool_call": {
                    "name": "list_files",
                    "args": []
                }
            }
        `;

        const fullPrompt = `
            System Prompt: ${systemPrompt}
            User Request: ${prompt}
            History:
            ${JSON.stringify(history, null, 2)}
        `;

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

            let modelResponseText = jsonResponse.response;
            console.log(`[AgentService] Model response length: ${modelResponseText ? modelResponseText.length : 0} characters`);
            console.log(`[AgentService] Model response preview: ${modelResponseText ? modelResponseText.substring(0, 200) : 'No response'}...`);

            const jsonMatch = modelResponseText.match(/```(json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch && jsonMatch[2]) {
                modelResponseText = jsonMatch[2];
                console.log(`[AgentService] Extracted JSON from markdown: ${modelResponseText.substring(0, 200)}...`);
            }
            
            console.log(`[AgentService] Parsing JSON response...`);
            const modelOutput = JSON.parse(modelResponseText);
            console.log(`[AgentService] Parsed model output keys: ${Object.keys(modelOutput)}`);
            
            const toolName = modelOutput.tool_call.name;
            let args = modelOutput.tool_call.args;
            
            console.log(`[AgentService] Tool name: ${toolName}, args type: ${typeof args}`);

            // Convert args from object to array based on tool definition
            if (!Array.isArray(args) && typeof args === 'object' && args !== null) {
                const toolDef = this.getToolDefinitions().find(t => t.name === toolName);
                if (toolDef && toolDef.args) {
                    args = toolDef.args.map((argDef: any) => args[argDef.name]);
                    console.log(`[AgentService] Converted object args to array: ${JSON.stringify(args)}`);
                } else {
                    // If no tool definition found or no args defined, convert object values to array
                    args = Object.values(args);
                    console.log(`[AgentService] Converted object values to array: ${JSON.stringify(args)}`);
                }
            } else if (!Array.isArray(args)) {
                args = [];
                console.log(`[AgentService] No args provided, using empty array`);
            }

            console.log(`[AgentService] Final result - tool: ${toolName}, args: ${JSON.stringify(args)}, thought: ${modelOutput.thought}`);

            return {
                thought: modelOutput.thought,
                tool: toolName,
                args: args
            };

        } catch (error: any) {
            this.currentAbortController = undefined;
            console.error(`[AgentService] Error in getNextActionFromModel:`, error);
            
            if (error.name === 'AbortError') {
                console.log(`[AgentService] Request was aborted`);
                return {
                    thought: "Request was stopped by user.",
                    tool: 'finish',
                    args: ["Request was stopped by user."]
                };
            }
            
            console.error(`[AgentService] Network or parsing error: ${error.message}`);
            return {
                thought: "There was an error calling the model.",
                tool: 'finish',
                args: [`Error calling model: ${error.message}`]
            };
        } finally {
            this.currentAbortController = undefined;
        }
    }
}
