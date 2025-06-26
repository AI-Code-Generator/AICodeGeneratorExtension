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

    constructor() {
        this.diffManager = DiffManager.getInstance();
    }

    public setTerminalCommandCallback(callback: (command: string) => Promise<boolean>) {
        this.terminalCommandCallback = callback;
    }
    public async list_files(): Promise<string[]> {
        // Find all files, ignoring .git, node_modules, and other common exclusions
        const files = await vscode.workspace.findFiles('**/*', '{.git,node_modules,**/__pycache__,.vscode}/**');
        return files.map(file => vscode.workspace.asRelativePath(file));
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
        return await this.diffManager.applyChangeWithDiff(filePath, newContent);
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

        return new Promise((resolve) => {
            exec(command, { cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath }, (error, stdout, stderr) => {
                resolve({ stdout, stderr: error ? error.message : stderr });
            });
        });
    }

    private getAbsolutePath(filePath: string): string {
        if (path.isAbsolute(filePath)) {
            return filePath;
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

    public async processRequest(prompt: string, serverUrl: string, sendUpdate: (update: string) => void) {
        this.shouldStop = false;
        let history: { action: string, result: any }[] = [];
        const maxSteps = 10;

        for (let i = 0; i < maxSteps; i++) {
            if (this.shouldStop) {
                sendUpdate("Agent stopped by user.");
                return;
            }

            sendUpdate(`--- Step ${i + 1} ---`);

            const { tool, args, thought } = await this.getNextActionFromModel(prompt, history, sendUpdate, serverUrl);

            if (this.shouldStop) {
                sendUpdate("Agent stopped by user.");
                return;
            }

            if (thought) {
                sendUpdate(`Thought: ${thought}`);
            }

            if (tool === 'finish') {
                sendUpdate(`Agent finished: ${args[0]}`);
                return;
            }

            if (!Object.getOwnPropertyNames(ToolBox.prototype).includes(tool)) {
                const errorMsg = `Error: Model tried to use an unknown tool: ${tool}`;
                sendUpdate(errorMsg);
                history.push({ action: `unknown_tool(${tool})`, result: errorMsg });
                continue;
            }

            sendUpdate(`Action: ${tool}(${args.map((a: any) => JSON.stringify(a)).join(', ')})`);

            try {
                // @ts-ignore
                const result = await this.toolbox[tool](...args);
                const resultString = JSON.stringify(result, null, 2);
                history.push({ action: `${tool}(${args.map((a: any) => JSON.stringify(a)).join(', ')})`, result: resultString });
                sendUpdate(`Result: ${resultString.substring(0, 500)}${resultString.length > 500 ? '...' : ''}`);
            } catch (error: any) {
                const errorMessage = `Error executing tool: ${error.message}`;
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
            { name: 'list_files', description: 'List all files in the workspace. Returns an array of relative file paths.' },
            { name: 'read_file', description: 'Read the content of a file at a given relative path.', args: [{ name: 'filePath', type: 'string' }] },
            { name: 'apply_file_change', description: 'Apply a change to a file immediately without asking user permission. Changes are applied instantly and user sees diffs with accept/reject buttons. Continue with next action immediately. Returns a status message.', args: [{ name: 'filePath', type: 'string' }, { name: 'newContent', type: 'string' }] },
            { name: 'run_terminal_command', description: 'Run a shell command in the workspace root. Asks for user permission first. Returns stdout and stderr.', args: [{ name: 'command', type: 'string' }] },
            { name: 'finish', description: 'Finishes the task with a message.', args: [{ name: 'message', type: 'string' }] }
        ];
    }

    private async getNextActionFromModel(prompt: string, history: any[], sendUpdate: (update: string) => void, serverUrl: string): Promise<{ tool: string, args: any[], thought: string }> {
        sendUpdate("Asking the model for the next step...");

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

            if (!response.ok) {
                const errorText = await response.text();
                return {
                    thought: `The model API call failed with status ${response.status}.`,
                    tool: 'finish',
                    args: [`Model API error: ${errorText}`]
                };
            }

            const jsonResponse = await response.json();

            let modelResponseText = jsonResponse.response;

            const jsonMatch = modelResponseText.match(/```(json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch && jsonMatch[2]) {
                modelResponseText = jsonMatch[2];
            }
            
            const modelOutput = JSON.parse(modelResponseText);
            const toolName = modelOutput.tool_call.name;
            let args = modelOutput.tool_call.args;

            // Convert args from object to array based on tool definition
            if (!Array.isArray(args) && typeof args === 'object' && args !== null) {
                const toolDef = this.getToolDefinitions().find(t => t.name === toolName);
                if (toolDef && toolDef.args) {
                    args = toolDef.args.map((argDef: any) => args[argDef.name]);
                } else {
                    // If no tool definition found or no args defined, convert object values to array
                    args = Object.values(args);
                }
            } else if (!Array.isArray(args)) {
                args = [];
            }

            return {
                thought: modelOutput.thought,
                tool: toolName,
                args: args
            };

        } catch (error: any) {
            this.currentAbortController = undefined;
            if (error.name === 'AbortError') {
                return {
                    thought: "Request was stopped by user.",
                    tool: 'finish',
                    args: ["Request was stopped by user."]
                };
            }
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
