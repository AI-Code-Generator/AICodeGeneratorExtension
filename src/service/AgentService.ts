// src/service/AgentService.ts
import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

// The ToolBox holds the set of functions the agent can execute.
class ToolBox {
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

    public async propose_file_change(filePath: string, newContent: string): Promise<boolean> {
        const absolutePath = this.getAbsolutePath(filePath);
        const originalContent = await this.read_file(filePath);

        const originalUri = vscode.Uri.file(absolutePath).with({ scheme: 'file' });
        const newUri = vscode.Uri.file(`${absolutePath}.agent.tmp`).with({ scheme: 'file' });

        await fs.writeFile(newUri.fsPath, newContent);

        await vscode.commands.executeCommand('vscode.diff', originalUri, newUri, `Proposed changes for ${path.basename(filePath)}`);

        const choice = await vscode.window.showInformationMessage(
            `Apply changes to ${path.basename(filePath)}?`,
            { modal: true },
            'Yes',
            'No'
        );

        await fs.unlink(newUri.fsPath);

        if (choice === 'Yes') {
            await fs.writeFile(absolutePath, newContent);
            vscode.window.showInformationMessage(`Applied changes to ${path.basename(filePath)}`);
            return true;
        } else {
            vscode.window.showInformationMessage(`Discarded changes for ${path.basename(filePath)}`);
            return false;
        }
    }

    public async run_terminal_command(command: string): Promise<{ stdout: string, stderr: string }> {
        const allow = await vscode.window.showInformationMessage(
            `The agent wants to run the following command:\n\n${command}\n\nDo you want to allow it?`,
            { modal: true },
            'Yes',
            'No'
        );

        if (allow !== 'Yes') {
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

    constructor() {
    }

    public async processRequest(prompt: string, serverUrl: string, sendUpdate: (update: string) => void) {
        let history: { action: string, result: any }[] = [];
        const maxSteps = 10;

        for (let i = 0; i < maxSteps; i++) {
            sendUpdate(`--- Step ${i + 1} ---`);

            const { tool, args, thought } = await this.getNextActionFromModel(prompt, history, sendUpdate, serverUrl);

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

    private getToolDefinitions() {
        return [
            { name: 'list_files', description: 'List all files in the workspace. Returns an array of relative file paths.' },
            { name: 'read_file', description: 'Read the content of a file at a given relative path.', args: [{ name: 'filePath', type: 'string' }] },
            { name: 'propose_file_change', description: 'Propose a change to a file. Shows a diff to the user who can accept or reject it. Returns true if accepted, false otherwise.', args: [{ name: 'filePath', type: 'string' }, { name: 'newContent', type: 'string' }] },
            { name: 'run_terminal_command', description: 'Run a shell command in the workspace root. Asks for user permission first. Returns stdout and stderr.', args: [{ name: 'command', type: 'string' }] },
            { name: 'finish', description: 'Finishes the task with a message.', args: [{ name: 'message', type: 'string' }] }
        ];
    }

    private async getNextActionFromModel(prompt: string, history: any[], sendUpdate: (update: string) => void, serverUrl: string): Promise<{ tool: string, args: any[], thought: string }> {
        sendUpdate("Asking the model for the next step...");

        const systemPrompt = `
            You are an expert AI programmer agent.
            Your goal is to complete the user's request: "${prompt}"
            You operate in a loop. In each step, you will be given the user's request and a history of your previous actions and their results.
            You must choose one of the following tools to use in this step. Call the tool with the correct arguments.
            Do not ask for clarification.

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
            const response = await fetch(serverUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ 
                    query: fullPrompt,
                    user_ID: "0001"
                })
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
            return {
                thought: "There was an error calling the model.",
                tool: 'finish',
                args: [`Error calling model: ${error.message}`]
            };
        }
    }
}
