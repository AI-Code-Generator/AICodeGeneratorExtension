import * as vscode from 'vscode';
import { ChatViewProvider } from './ChatViewProvider';
//import { AICompletionProvider } from './CompletionProvider';
import { config } from './config';
import { indexWorkspaceFiles } from './service/FileIndexer';

export function activate(context: vscode.ExtensionContext) {
    const chatViewProvider = new ChatViewProvider(context.extensionUri, config.serverUrl);
    
    let output = vscode.window.createOutputChannel("AI code assist");
    // Index workspace files when extension activates
    indexWorkspaceFiles().then(files => {
        output.appendLine(`Indexed ${files.length} files in workspace`);
    }).catch(err => {
        output.appendLine('Error indexing workspace:');
    });


    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'aiCodeAssist.chatView',
            chatViewProvider
        )
    );

	// const completionProvider = new AICompletionProvider(config.serverUrl);
    // context.subscriptions.push(
    //     vscode.languages.registerInlineCompletionItemProvider(
    //         { pattern: '**' }, // Register for all file types
    //         completionProvider
    //     )
    // );

	let toggleSuggestions = vscode.commands.registerCommand('ai-code-assist.toggleSuggestions', () => {
        const config = vscode.workspace.getConfiguration('editor');
        const current = config.get('inlineSuggest.enabled');
        config.update('inlineSuggest.enabled', !current, true);
    });

    // Register command to open chat
    let disposable = vscode.commands.registerCommand('ai-code-assist.openChat', () => {
		vscode.commands.executeCommand('aiCodeAssist.chatView.focus');
    });
	
	context.subscriptions.push(toggleSuggestions);
    context.subscriptions.push(disposable);
}

export function deactivate() {}