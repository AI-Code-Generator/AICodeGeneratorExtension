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

    public async read_file(filePath: string): Promise<string> {
        const absolutePath = this.getAbsolutePath(filePath);
        try {
            const content = await fs.readFile(absolutePath, 'utf-8');
            return content;
        } catch (error) {
            // If file not found, try to provide helpful error message
            if ((error as any).code === 'ENOENT') {
                return `Error: File not found at path: ${absolutePath}. Working directory: ${this.workingDirectory}`;
            }
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
        sendUpdate(`[AgentService] Starting processRequest with serverUrl: ${serverUrl}`);
        sendUpdate(`[AgentService] Working directory: ${this.toolbox.getWorkingDirectory() || 'Not set'}`);
        sendUpdate(`[AgentService] Prompt length: ${prompt.length} characters`);
        
        this.shouldStop = false;
        let history: { action: string, result: any }[] = [];
        const maxSteps = 200;

        for (let i = 0; i < maxSteps; i++) {
            if (this.shouldStop) {
                sendUpdate("Agent stopped by user.");
                return;
            }

            sendUpdate(`## Step ${i + 1}`);

            const { tool, args, thought } = await this.getNextActionFromModel(prompt, history, sendUpdate, serverUrl);
            sendUpdate(`Step ${i + 1} result - tool: ${tool}, args: ${JSON.stringify(args)}, thought: ${thought}`);

            if (this.shouldStop) {
                sendUpdate("Agent stopped by user.");
                return;
            }

            if (thought) {
                sendUpdate(`Thought: ${thought}`);
            }

            if (tool === 'finish') {
                sendUpdate(`**Agent finished: ${args[0]}**`);
                return;
            }

            // Check if the tool exists in the toolbox
            const availableTools = Object.getOwnPropertyNames(ToolBox.prototype);
            sendUpdate(`Available tools: ${availableTools.join(', ')}`);
            sendUpdate(`Checking tool: ${tool}`);
            
            if (!availableTools.includes(tool) && !(this.toolbox as any)[tool]) {
                const errorMsg = `Error: Model tried to use an unknown tool: ${tool}. Available tools: ${availableTools.join(', ')}`;
                sendUpdate(errorMsg);
                history.push({ action: `unknown_tool(${tool})`, result: errorMsg });
                continue;
            }

            sendUpdate(`Action: ${tool}(${args.map((a: any) => JSON.stringify(a)).join(', ')})`);
            sendUpdate(`Executing tool: ${tool} with args: ${JSON.stringify(args)}`);
            sendUpdate(`Toolbox method exists: ${typeof (this.toolbox as any)[tool]}`);

            try {
                // @ts-ignore
                const result = await this.toolbox[tool](...args);
                let resultString = JSON.stringify(result, null, 2);
                
                sendUpdate(`Tool ${tool} executed successfully`);
                sendUpdate(`Tool ${tool} result length: ${resultString.length}`);
                history.push({ action: `${tool}(${args.map((a: any) => JSON.stringify(a)).join(', ')})`, result: resultString });
                sendUpdate(`Result: ${resultString.substring(0, 500)}${resultString.length > 500 ? '...' : ''}`);
                sendUpdate(`Tool ${tool} result preview: ${resultString.substring(0, 200)}`);
            } catch (error: any) {
                const errorMessage = `Error executing tool: ${error.message}`;
                sendUpdate(`Tool execution error at step ${i + 1}: ${error.message}`);
                sendUpdate(`Error stack: ${error.stack}`);
                history.push({ action: `${tool}(${args.map((a: any) => JSON.stringify(a)).join(', ')})`, result: errorMessage });
                sendUpdate(errorMessage);
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
            { name: 'read_file', description: 'Read the content of a file at a given relative path.', args: [{ name: 'filePath', type: 'string' }] },
            { name: 'apply_file_change', description: 'Apply a change to a file immediately without asking user permission. Changes are applied instantly and user sees diffs with accept/reject buttons. Continue with next action immediately. Returns a status message.', args: [{ name: 'filePath', type: 'string' }, { name: 'newContent', type: 'string' }] },
            { name: 'run_terminal_command', description: 'Run a shell command in the workspace root. Asks for user permission first. Returns stdout and stderr.', args: [{ name: 'command', type: 'string' }] },
            { name: 'finish', description: 'Finishes the task with a message.', args: [{ name: 'message', type: 'string' }] }
        ];
    }

    private async getNextActionFromModel(prompt: string, history: any[], sendUpdate: (update: string) => void, serverUrl: string): Promise<{ tool: string, args: any[], thought: string }> {
        sendUpdate("Asking the model for the next step...");
        sendUpdate(`Making request to: ${serverUrl}`);

        const systemPrompt = `You are an expert AI programmer agent.
Your goal is to complete the user's request: "${prompt}"

CRITICAL INSTRUCTIONS:
1. You operate autonomously - make file changes immediately without asking permission
2. apply_file_change tool applies changes instantly to files
3. Users see diffs with accept/reject buttons after you make changes
4. NEVER ask "Should I..." or "Would you like me to..." - just do it
5. Complete the entire task by making all necessary changes
6. Only use 'finish' when the task is completely done

IMPORTANT: list_files is paginated. Use offset and limit parameters:
- list_files(0, 100) gets first 100 files
- list_files(100, 100) gets next 100 files
- The response includes hasMore flag to indicate if there are more files
- Use this to explore the codebase efficiently instead of loading all files at once

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

        // Truncate history more aggressively to prevent argument list too long errors
        const truncatedHistory = history.slice(-2).map(entry => {
            // Truncate very long results to prevent prompt explosion
            let result = entry.result;
            if (typeof result === 'string' && result.length > 5000) {
                result = result.substring(0, 5000) + '... [TRUNCATED]';
            }
            return {
                action: entry.action,
                result: result
            };
        });
        
        const fullPrompt = `System Prompt: ${systemPrompt}
User Request: ${prompt}
History:
${JSON.stringify(truncatedHistory)}`;

        sendUpdate(`Full prompt length: ${fullPrompt.length} characters`);
        sendUpdate(`History entries: ${history.length}, truncated to: ${truncatedHistory.length}`);

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
            sendUpdate(`Response JSON keys: ${Object.keys(jsonResponse)}`);

            // Check if server returned an error
            if (jsonResponse.error) {
                sendUpdate(`Server returned error: ${jsonResponse.error}`);
                return {
                    thought: "Server returned an error.",
                    tool: 'finish',
                    args: [`Server error: ${jsonResponse.error}`]
                };
            }

            let modelResponseText = jsonResponse.response;
            sendUpdate(`Model response length: ${modelResponseText ? modelResponseText.length : 0} characters`);
            sendUpdate(`Model response preview: ${modelResponseText ? modelResponseText.substring(0, 500) : 'No response'}...`);

            // Check if the response field is missing
            if (!modelResponseText) {
                sendUpdate(`Server response structure: ${JSON.stringify(jsonResponse, null, 2)}`);
                return {
                    thought: "Server returned empty or missing response field.",
                    tool: 'finish',
                    args: [`Server returned empty response. Full response: ${JSON.stringify(jsonResponse)}`]
                };
            }

            // Check if the response is wrapped in markdown code blocks
            const jsonMatch = modelResponseText.match(/```(json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch && jsonMatch[2]) {
                sendUpdate(`Found JSON in markdown, extracting...`);
                modelResponseText = jsonMatch[2];
                sendUpdate(`Extracted JSON from markdown: ${modelResponseText.substring(0, 500)}...`);
            }
            
            sendUpdate(`Parsing JSON response...`);
            sendUpdate(`Raw JSON to parse: ${modelResponseText}`);
            
            let modelOutput;
            try {
                modelOutput = JSON.parse(modelResponseText);
            } catch (parseError: any) {
                sendUpdate(`JSON parsing failed: ${parseError.message || parseError}`);
                sendUpdate(`Raw response that failed to parse: ${modelResponseText}`);
                return {
                    thought: "Failed to parse model response as JSON.",
                    tool: 'finish',
                    args: [`JSON parsing error: ${parseError.message || parseError}`]
                };
            }
            
            sendUpdate(`Parsed model output keys: ${Object.keys(modelOutput)}`);
            sendUpdate(`Model output: ${JSON.stringify(modelOutput, null, 2)}`);
            
            // Validate model output structure
            if (!modelOutput.tool_call) {
                sendUpdate(`Model output missing tool_call field`);
                return {
                    thought: modelOutput.thought || "Model response missing tool_call",
                    tool: 'finish',
                    args: [`Invalid model response: missing tool_call field`]
                };
            }
            
            if (!modelOutput.tool_call.name) {
                sendUpdate(`Model output missing tool_call.name field`);
                return {
                    thought: modelOutput.thought || "Model response missing tool name",
                    tool: 'finish',
                    args: [`Invalid model response: missing tool_call.name field`]
                };
            }
            
            const toolName = modelOutput.tool_call.name;
            let args = modelOutput.tool_call.args;
            
            sendUpdate(`Tool name: ${toolName}, args type: ${typeof args}`);

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
                    sendUpdate(`Converted object args to array: ${JSON.stringify(args)}`);
                } else {
                    // If no tool definition found or no args defined, convert object values to array
                    args = Object.values(args);
                    sendUpdate(`Converted object values to array: ${JSON.stringify(args)}`);
                }
            } else if (!Array.isArray(args)) {
                args = [];
                sendUpdate(`No args provided, using empty array`);
            }

            sendUpdate(`Final result - tool: ${toolName}, args: ${JSON.stringify(args)}, thought: ${modelOutput.thought}`);

            return {
                thought: modelOutput.thought,
                tool: toolName,
                args: args
            };

        } catch (error: any) {
            this.currentAbortController = undefined;
            sendUpdate(`Error in getNextActionFromModel: ${error.message}`);
            
            if (error.name === 'AbortError') {
                sendUpdate(`Request was aborted`);
                return {
                    thought: "Request was stopped by user.",
                    tool: 'finish',
                    args: ["Request was stopped by user."]
                };
            }
            
            sendUpdate(`Network or parsing error: ${error.message}`);
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
