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
        const maxSteps = 60;

        let currentPrompt = prompt; // Use the full prompt for the first step
        let isFirstStep = true;

        for (let i = 0; i < maxSteps; i++) {
            if (this.shouldStop) {
                sendUpdate("Agent stopped by user.");
                return;
            }

            sendUpdate(`## Step ${i + 1}`);

            const { tool, args, thought } = await this.getNextActionFromModel(currentPrompt, history, sendUpdate, serverUrl);
            sendUpdate(`Step ${i + 1} result - tool: ${tool}, args: ${JSON.stringify(args)}, thought: ${thought}`);

            if (this.shouldStop) {
                sendUpdate("Agent stopped by user.");
                return;
            }

            if (isFirstStep) {
                isFirstStep = false;
                currentPrompt = "Continue with the next step based on the history to complete the original request.";
            }

            if (thought) {
                sendUpdate(`Thought: ${thought}`);
            }

            if (tool === 'finish') {
                sendUpdate(`**Agent finished: ${args[0]}**`);
                return;
            }

            if (tool === 'retry_with_valid_json') {
                const errorMsg = `Model generated invalid JSON. Adding error to history and retrying.`;
                sendUpdate(errorMsg);
                history.push({ action: `invalid_json_response`, result: args[0] });
                continue; // Skip to the next iteration of the loop
            }

            // Check if the tool exists in the toolbox
            const availableTools = this.getToolDefinitions();
            const availableToolNames = availableTools.map(t => t.name);
            sendUpdate(`Available tools: ${availableTools.join(', ')}`);
            sendUpdate(`Checking tool: ${tool}`);
            
            if (!availableToolNames.includes(tool) && !(this.toolbox as any)[tool]) {
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
            { name: 'search_files', description: 'Search for files by pattern/name. More efficient than listing all files when looking for specific files.', args: [{ name: 'pattern', type: 'string' }] },
            { name: 'read_file', description: 'Read the FULL content of a file at a given relative path. CRITICAL: If a file is too long, this tool will fail and instruct you to use search_in_file or read_file_chunk instead.', args: [{ name: 'filePath', type: 'string' }] },
            { name: 'search_in_file', description: 'Search for a specific keyword within a single file (given relative path). This is the most efficient way to find relevant code in long files. Returns the matching lines with surrounding context.', args: [{ name: 'filePath', type: 'string' }, { name: 'keyword', type: 'string' }] },
            { name: 'read_file_chunk', description: 'Read a large file in smaller pieces (chunks) (arg is relative file path). Use this if you need to understand the overall structure of a long file.', args: [{ name: 'filePath', type: 'string' }, { name: 'chunkNumber', type: 'number' }, { name: 'chunkSize', type: 'number' }] },
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
**you are trying to fix SWE-Bench Lite benchmark tasks with the aid of tool calls**
**if you ever try package installing,,, please try one time and if not found, move on to fix the problem by reading logic**
1. You operate autonomously - make file changes immediately without asking permission
2. apply_file_change tool applies changes instantly to files
3. Users see diffs with accept/reject buttons after you make changes
4. NEVER ask "Should I..." or "Would you like me to..." - just do it
5. Complete the entire task by making all necessary changes
6. Only use 'finish' when the task is completely done

IMPORTANT: Use tools efficiently to explore codebase:
- search_files(pattern) to find specific files by name/pattern (e.g., "separable" finds separable.py)
- list_files(offset, limit) for paginated browsing when exploring structure
- list_files(0, 100) gets first 100 files, list_files(100, 100) gets next 100
- The response includes hasMore flag to indicate if there are more files

CRITICAL WORKFLOW FOR READING FILES:
1. Your first step when reading a file should ALWAYS be the 'read_file' tool.
2. If 'read_file' returns a "File is too long" error, your immediate next step MUST be to use the 'search_in_file' tool with a relevant keyword from the problem description. Do NOT use 'read_file_chunk' unless you have a specific reason to read from the beginning.
3. Only use 'read_file_chunk' if you need to browse the file from the start or 'search_in_file' does not yield results.

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

        const HISTORY_CHAR_BUDGET = 8000; 
        let currentChars = 0;
        const truncatedHistory = [];

        // Loop backwards from the most recent entry to the oldest.
        for (let i = history.length - 1; i >= 0; i--) {
            const entry = history[i];

            // Truncate very long individual results to prevent any single entry from dominating.
            let result = entry.result;
            if (typeof result === 'string' && result.length > 2000) {
                result = result.substring(0, 2000) + '... [TRUNCATED - content too long]';
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
        }

        
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
            sendUpdate(`Raw JSON to parse: ${modelResponseText.substring(0, 500)}...`);
            
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
                        sendUpdate(`JSON parsing failed after all attempts: ${firstError.message || firstError}`);
                        sendUpdate(`Full raw response: ${modelResponseText}`);
                        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
                            const extractedJson = modelResponseText.substring(jsonStart, jsonEnd + 1);
                            modelOutput = JSON.parse(extractedJson);
                        } else {
                            throw new Error('Could not find valid JSON boundaries');
                        }
                    } catch (thirdError: any) {
                        const errorMessage = `Failed to parse model response as JSON. The model returned malformed text. Error: ${firstError.message || firstError}. Full response: ${modelResponseText}`;
                        sendUpdate(`[Agent Error] (JSON parsing error) ${errorMessage}`);
                        return {
                            thought: "The last response was not valid JSON. I must correct my output format and try again.",
                            tool: 'retry_with_valid_json',
                            args: [`JSON parsing error: ${errorMessage}`]
                        };
                    }
                }
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
