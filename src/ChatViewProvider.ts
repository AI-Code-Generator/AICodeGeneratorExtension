// src/ChatViewProvider.ts
import * as vscode from 'vscode';
import { similaritySearch } from './service/FileIndexer';
import { ContextGatherer } from './service/ContextGatherer';
import { AgentService } from './service/AgentService';
import { DiffManager } from './service/DiffManager';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private readonly _queryUrl: string;
    private readonly _embedUrl: string;
    private readonly _enhanceUrl: string;
    private contextGatherer: ContextGatherer;
    private agentService: AgentService;
    private currentAbortController?: AbortController;
    private isProcessing: boolean = false;
    private currentMode: 'ask' | 'agent' = 'ask'; // Track current mode
    private askHistory: Array<{type: 'user' | 'assistant', message: string}> = [];
    private agentHistory: Array<{type: 'user' | 'assistant', message: string}> = [];
    private currentAgentResponseIndex: number = -1; // Track current streaming response
    private saveHistoryTimeout?: NodeJS.Timeout; // Debounce history saves
    private pendingTerminalCommandResolve?: (value: boolean) => void; // For terminal command confirmations

    constructor(
        private readonly _extensionUri: vscode.Uri,
        baseUrl: string,
        private readonly _context: vscode.ExtensionContext
    ) {
        this._queryUrl = `${baseUrl}/ask-ai`;
        this._embedUrl = `${baseUrl}/embed`;
        this._enhanceUrl = `${baseUrl}/enhance-query`;
        this.contextGatherer = new ContextGatherer();
        this.agentService = new AgentService();
        
        // Set up terminal command callback
        this.agentService.setTerminalCommandCallback(this.handleTerminalCommandConfirmation.bind(this));
        
        // Load persisted history
        this.loadHistory();
    }

    private getCodeContext(editor: vscode.TextEditor | undefined, surroundingLines: number = 5): string {
        if (!editor) {
            return '';
        }

        const document = editor.document;
        const cursorPosition = editor.selection.active;
        
        // Calculate the range for surrounding lines
        const startLine = Math.max(0, cursorPosition.line - surroundingLines);
        const endLine = Math.min(document.lineCount - 1, cursorPosition.line + surroundingLines);
        
        // Get the text from the range
        const range = new vscode.Range(
            new vscode.Position(startLine, 0),
            new vscode.Position(endLine, document.lineAt(endLine).text.length)
        );
        
        return document.getText(range);
    }

    private async embedCodeContext(codeContext: string, language: string) {
        if (!codeContext.trim()) {
            return;
        }

        try {
            await fetch(this._embedUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ 
                    text: codeContext,
                    language: language 
                })
            });
        } catch (error) {
            console.error('Failed to embed code context:', error);
            // Don't throw the error - we don't want to interrupt the main flow if embedding fails
        }
    }

    private async enhanceQuery(originalQuery: string, enhancedContext: any): Promise<string> {
        try {
            const response = await fetch(this._enhanceUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    question: originalQuery,
                    context: enhancedContext
                })
            });

            const result = await response.json();
            
            if (!result.error && result.enhancedQuery) {
                return result.enhancedQuery;
            } else {
                console.warn('Query enhancement failed, using original query');
                return originalQuery;
            }
        } catch (error) {
            console.error('Failed to enhance query:', error);
            return originalQuery;
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        setTimeout(() => {
            this.updateProcessingState();
        }, 100);

        // Handle messages from the webview
        const agentUrl = this._queryUrl.valueOf();
        webviewView.webview.onDidReceiveMessage(async (data) => {
            if (data.type === 'requestState') {
                // Send current processing state, mode, and history to webview
                this.updateProcessingState();
                this._view?.webview.postMessage({
                    type: 'updateMode',
                    mode: this.currentMode
                });
                this.sendHistoryToWebview();
                return;
            }

            if (data.type === 'stopProcess') {
                this.stopCurrentProcess();
                return;
            }

            if (data.type === 'acceptAllChanges') {
                vscode.commands.executeCommand('aiCodeAssist.acceptAllChanges');
                return;
            }

            if (data.type === 'rejectAllChanges') {
                vscode.commands.executeCommand('aiCodeAssist.rejectAllChanges');
                return;
            }

            if (data.type === 'changeMode') {
                this.currentMode = data.mode;
                this._view?.webview.postMessage({
                    type: 'updateMode',
                    mode: this.currentMode
                });
                this.sendHistoryToWebview();
                // Save mode change
                this.saveHistory();
                return;
            }

            if (data.type === 'clearMessages') {
                this.clearMessages();
                return;
            }

            if (data.type === 'confirmTerminalCommand') {
                if (this.pendingTerminalCommandResolve) {
                    this.pendingTerminalCommandResolve(data.allow);
                    this.pendingTerminalCommandResolve = undefined;
                }
                return;
            }

            if (data.mode === 'agent') {
                this.currentMode = 'agent'; // Update current mode
                this.isProcessing = true;
                this.updateProcessingState();
                
                // Add user message to agent history
                this.addToHistory('agent', 'user', data.message);
                
                // Display the user message first
                this._view?.webview.postMessage({
                    type: 'addMessage',
                    message: data.message,
                    sender: 'user'
                });
                
                // Hide bulk actions when starting new agent task
                this._view?.webview.postMessage({
                    type: 'showBulkActions',
                    show: false
                });
                
                let agentResponse = '';
                let isFirstUpdate = true;
                this.agentService.processRequest(data.message, agentUrl, (update) => {
                    agentResponse += update + '\n';
                    
                    if (isFirstUpdate) {
                        // Create the initial assistant message bubble
                        this._view?.webview.postMessage({
                            type: 'addMessage',
                            message: agentResponse.trim(),
                            sender: 'assistant'
                        });
                        
                        // Add initial assistant message to history immediately
                        this.addToHistory('agent', 'assistant', agentResponse.trim());
                        this.currentAgentResponseIndex = this.agentHistory.length - 1;
                        isFirstUpdate = false;
                    } else {
                        // Update the existing assistant message bubble with full content
                        this._view?.webview.postMessage({
                            type: 'updateMessage',
                            message: agentResponse.trim(),
                            sender: 'assistant'
                        });
                        
                        // Update the agent response in history
                        if (this.currentAgentResponseIndex >= 0) {
                            this.agentHistory[this.currentAgentResponseIndex].message = agentResponse.trim();
                            this.debouncedSaveHistory();
                        }
                    }
                }).finally(() => {
                    // Ensure final agent response is saved to history
                    if (this.currentAgentResponseIndex >= 0) {
                        this.agentHistory[this.currentAgentResponseIndex].message = agentResponse.trim();
                        this.saveHistory();
                    }
                    this.currentAgentResponseIndex = -1;
                    
                    this.isProcessing = false;
                    this.updateProcessingState();
                    
                    // Show bulk actions only if there are pending changes
                    const diffManager = DiffManager.getInstance();
                    const allChanges = diffManager.getAllPendingChanges();
                    const hasPendingChanges = Array.from(allChanges.values()).some(changes => changes.length > 0);
                    
                    if (hasPendingChanges) {
                        this._view?.webview.postMessage({
                            type: 'showBulkActions',
                            show: true
                        });
                    }
                });
                return;
            }

            switch (data.type) {
                case 'sendMessage':
                    this.currentMode = 'ask'; // Update current mode for regular chat
                    try {
                        this.isProcessing = true;
                        this.updateProcessingState();
                        
                        // Create abort controller for this request
                        this.currentAbortController = new AbortController();
                        
                        const editor = vscode.window.activeTextEditor;
                        const selectedCode = editor?.document.getText(editor.selection) || '';
                        const fileLanguage = editor?.document.languageId || '';
                        
                        // Get code context around cursor
                        const codeContext = this.getCodeContext(editor);
                        
                        // Embed the code context
                        // await this.embedCodeContext(codeContext, fileLanguage);

                        // Prepare the query with context
                        let query = `${data.message}\n\nLanguage: ${fileLanguage}`;
                        if (selectedCode.trim()) {
                            query += `\nSelected code:\n${selectedCode}`;
                        }

                        // const similarity =  await similaritySearch(data.message);

                        // Gather workspace and file context using AST Manager
                        const workspaceContext = this.contextGatherer.gatherWorkspaceContext();
                        const currentFileContext = this.contextGatherer.gatherCurrentFileContext(editor);
                        const relevantSymbols = this.contextGatherer.findRelevantSymbols(data.message);
                        const enhancedContext = {
                            ...workspaceContext,
                            currentFileContext,
                            relevantSymbols,
                            language: fileLanguage,
                            selectedCode: selectedCode.trim() ? selectedCode : undefined
                        };

                        const enhancedQuery = await this.enhanceQuery(
                            data.message,
                            enhancedContext
                        );

                        // Now perform similarity search with enhanced query
                        const similarity = await similaritySearch(enhancedQuery);

                        // Add user message to ask history
                        this.addToHistory('ask', 'user', data.message);

                        // Send progress message
                        this._view?.webview.postMessage({
                            type: 'addMessage',
                            message: data.message,
                            sender: 'user'
                        });

                        // Send request to query endpoint
                        const response = await fetch(this._queryUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ 
                                query: query,
                                context: similarity,
                                user_ID: "0001"
                            }),
                            signal: this.currentAbortController.signal
                        });

                        const jsonResponse: any = await response.json();

                        if (!jsonResponse.error) {
                            // Add AI response to ask history
                            this.addToHistory('ask', 'assistant', jsonResponse.response);
                            
                            // Send response back to webview
                            this._view?.webview.postMessage({
                                type: 'addMessage',
                                message: jsonResponse.response,
                                sender: 'assistant'
                            });
                        } else {
                            throw new Error('Server request failed');
                        }
                    } catch (error: any) {
                        let errorMessage = '';
                        if (error.name === 'AbortError') {
                            errorMessage = 'Request was stopped by user.';
                            this._view?.webview.postMessage({
                                type: 'addMessage',
                                message: errorMessage,
                                sender: 'assistant'
                            });
                        } else {
                            vscode.window.showErrorMessage(`Error: ${error}`);
                            errorMessage = 'Sorry, there was an error processing your request.';
                            this._view?.webview.postMessage({
                                type: 'addMessage',
                                message: errorMessage,
                                sender: 'assistant'
                            });
                        }
                        // Add error message to history
                        this.addToHistory('ask', 'assistant', errorMessage);
                    } finally {
                        this.isProcessing = false;
                        this.currentAbortController = undefined;
                        this.updateProcessingState();
                    }
                    break;
            }
        });
    }

    private stopCurrentProcess() {
        if (this.currentAbortController) {
            this.currentAbortController.abort();
        }
        if (this.agentService) {
            this.agentService.stop();
        }
        this.isProcessing = false;
        this.updateProcessingState();
    }

    private updateProcessingState() {
        this._view?.webview.postMessage({
            type: 'updateProcessingState',
            isProcessing: this.isProcessing
        });
    }

    private addToHistory(mode: 'ask' | 'agent', type: 'user' | 'assistant', message: string) {
        const historyArray = mode === 'ask' ? this.askHistory : this.agentHistory;
        historyArray.push({ type, message });
        // Save history to extension storage
        this.saveHistory();
    }

    private getCurrentHistory(): Array<{type: 'user' | 'assistant', message: string}> {
        return this.currentMode === 'ask' ? this.askHistory : this.agentHistory;
    }

    private sendHistoryToWebview() {
        const history = this.getCurrentHistory();
        this._view?.webview.postMessage({
            type: 'loadHistory',
            history: history
        });
    }

    private async loadHistory() {
        try {
            const askHistoryData = this._context.globalState.get<Array<{type: 'user' | 'assistant', message: string}>>('askHistory');
            const agentHistoryData = this._context.globalState.get<Array<{type: 'user' | 'assistant', message: string}>>('agentHistory');
            const savedMode = this._context.globalState.get<'ask' | 'agent'>('currentMode');
            
            if (askHistoryData) {
                this.askHistory = askHistoryData;
            }
            if (agentHistoryData) {
                this.agentHistory = agentHistoryData;
            }
            if (savedMode) {
                this.currentMode = savedMode;
            }
        } catch (error) {
            console.error('Failed to load chat history:', error);
        }
    }

    private async saveHistory() {
        try {
            await this._context.globalState.update('askHistory', this.askHistory);
            await this._context.globalState.update('agentHistory', this.agentHistory);
            await this._context.globalState.update('currentMode', this.currentMode);
        } catch (error) {
            console.error('Failed to save chat history:', error);
        }
    }

    private debouncedSaveHistory() {
        // Clear existing timeout
        if (this.saveHistoryTimeout) {
            clearTimeout(this.saveHistoryTimeout);
        }
        
        // Set new timeout to save after 500ms of inactivity
        this.saveHistoryTimeout = setTimeout(() => {
            this.saveHistory();
        }, 500);
    }

    private clearMessages() {        
        if (this.currentMode === 'ask') {
            this.askHistory = [];
        } else {
            this.agentHistory = [];
        }

        this.saveHistory();

        this._view?.webview.postMessage({
            type: 'clearMessages'
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `
        <!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { 
            font-family: var(--vscode-font-family); 
            padding: 10px; 
            margin: 0;
        }
        .mode-selector {
            display: flex;
            gap: 10px;
            padding: 10px;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-input-border);
            align-items: center;
            justify-content: space-between;
        }
        .mode-buttons {
            display: flex;
            gap: 10px;
        }
        .clear-button {
            padding: 6px 10px;
            border: 1px solid var(--vscode-errorForeground);
            background: transparent;
            color: var(--vscode-errorForeground);
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            transition: all 0.2s;
        }
        .clear-button:hover {
            background: var(--vscode-errorForeground);
            color: white;
        }
        .mode-button {
            padding: 8px 12px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border-radius: 4px;
            cursor: pointer;
        }
        .mode-button.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .message { 
            margin: 10px 0; 
            padding: 8px; 
            border-radius: 4px; 
            white-space: pre-wrap;
        }
        .user { 
            background: var(--vscode-input-background);
            margin-left: 20px;
        }
        .assistant { 
            background: var(--vscode-editor-background);
            margin-right: 20px;
        }
        .input-container {
            position: fixed;
            bottom: 10px;
            left: 10px;
            right: 10px;
            display: flex;
            gap: 8px;
            background: var(--vscode-editor-background);
            padding: 10px;
            z-index: 1000; /* Below bulk actions */
        }
        #messageInput { 
            flex-grow: 1;
            padding: 8px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            color: var(--vscode-input-foreground);
            resize: vertical;
            border-radius: 4px;
            min-height: 40px;
        }
        #sendButton, #stopButton {
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            white-space: nowrap;
        }
        #sendButton:hover, #stopButton:hover {
            background: var(--vscode-button-hoverBackground);
        }
        #stopButton {
            background: var(--vscode-errorForeground);
            color: white;
            display: none;
        }
        #stopButton:hover {
            background: var(--vscode-errorForeground);
            opacity: 0.8;
        }
        #chatMessages {
            height: calc(100vh - 100px);
            overflow-y: auto;
            padding: 10px;
            margin-bottom: 140px; /* Increased margin for bulk actions + input */
        }
        .loading {
            display: none;
            margin: 10px 0;
            font-style: italic;
            color: var(--vscode-descriptionForeground);
            position: fixed;
            bottom: 145px;
            left: 20px;
            background: var(--vscode-editor-background);
            padding: 5px 10px;
            border-radius: 4px;
            z-index: 1000;
        }
        .code-block-container {
            margin: 12px 0;
            background: var(--vscode-textCodeBlock-background);
            border-radius: 6px;
            overflow: hidden;
            border: 1px solid var(--vscode-input-border);
        }
        .code-block-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 12px;
            background: var(--vscode-textCodeBlock-background);
            border-bottom: 1px solid var(--vscode-input-border);
        }
        .language-label {
            color: var(--vscode-descriptionForeground);
            font-size: 0.9em;
            text-transform: uppercase;
        }
        .copy-button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 4px 8px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 0.9em;
            transition: background-color 0.2s;
        }
        .copy-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .code-content {
            padding: 12px;
            margin: 0;
            overflow-x: auto;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            line-height: 1.5;
            tab-size: 4;
        }
        .text-content {
            margin: 8px 0;
            line-height: 1.6;
        }
        .text-content h1, .text-content h2, .text-content h3 {
            margin: 16px 0 8px 0;
            color: var(--vscode-foreground);
            line-height: 1.3;
        }
        .text-content h1 {
            font-size: 1.5em;
            border-bottom: 1px solid var(--vscode-input-border);
            padding-bottom: 4px;
        }
        .text-content h2 {
            font-size: 1.3em;
        }
        .text-content h3 {
            font-size: 1.1em;
        }
        .text-content strong {
            font-weight: bold;
            color: var(--vscode-foreground);
        }
        .text-content em {
            font-style: italic;
        }
        .text-content code {
            background: var(--vscode-textCodeBlock-background);
            color: var(--vscode-textPreformat-foreground);
            padding: 2px 4px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.9em;
        }
        .text-content ul, .text-content ol {
            margin: 12px 0;
            padding-left: 24px;
        }
        .text-content li {
            margin: 6px 0;
            line-height: 1.5;
        }
        .text-content ul li {
            list-style-type: disc;
        }
        .text-content ol li {
            list-style-type: decimal;
        }
        .text-content p {
            margin: 12px 0;
            line-height: 1.6;
        }
        .text-content p:first-child {
            margin-top: 0;
        }
        .text-content p:last-child {
            margin-bottom: 0;
        }
        .bulk-actions {
            display: none;
            position: fixed;
            bottom: 85px;
            left: 10px;
            right: 10px;
            margin: 0;
            padding: 15px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            text-align: center;
            z-index: 1001; /* Above loading indicator */
            box-shadow: 0 -2px 8px rgba(0,0,0,0.2);
            transform: translateY(100%);
            transition: transform 0.3s ease-in-out, opacity 0.3s ease-in-out;
            opacity: 0;
        }
        .bulk-actions.show {
            display: block;
            transform: translateY(0);
            opacity: 1;
        }
        .bulk-actions h4 {
            margin: 0 0 10px 0;
            color: var(--vscode-foreground);
            font-size: 14px;
        }
        .bulk-actions-buttons {
            display: flex;
            gap: 10px;
            justify-content: center;
        }
        .bulk-action-button {
            padding: 8px 16px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
        }
        .accept-all-button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .accept-all-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .reject-all-button {
            background: var(--vscode-errorForeground);
            color: white;
        }
        .reject-all-button:hover {
            opacity: 0.8;
        }
        .terminal-command-confirmation {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 8px;
            margin: 10px 0;
            padding: 15px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        .terminal-command-confirmation h4 {
            margin: 0 0 10px 0;
            color: var(--vscode-foreground);
            font-size: 14px;
        }
        .terminal-command {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 10px;
            margin: 10px 0;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            color: var(--vscode-editor-foreground);
            white-space: pre-wrap;
            word-break: break-all;
        }
        .terminal-command-buttons {
            display: flex;
            gap: 10px;
            justify-content: flex-end;
            margin-top: 15px;
        }
        .terminal-command-button {
            padding: 8px 16px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
        }
        .allow-command-button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .allow-command-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .deny-command-button {
            background: var(--vscode-errorForeground);
            color: white;
        }
        .deny-command-button:hover {
            opacity: 0.8;
        }
    </style>
</head>
<body>
    <div class="mode-selector">
        <div class="mode-buttons">
            <button id="askButton" class="mode-button active">Ask</button>
            <button id="agentButton" class="mode-button">Agent</button>
        </div>
        <button id="clearButton" class="clear-button" title="Clear all messages">🗑️ Clear</button>
    </div>
    <div id="chatMessages"></div>
    <div id="bulkActions" class="bulk-actions">
        <h4>Agent Task Completed - Review Changes</h4>
        <div class="bulk-actions-buttons">
            <button id="acceptAllButton" class="bulk-action-button accept-all-button">✓ Accept All Changes</button>
            <button id="rejectAllButton" class="bulk-action-button reject-all-button">✗ Reject All Changes</button>
        </div>
    </div>
    <div id="loading" class="loading">Thinking...</div>
    <div class="input-container">
        <textarea 
            id="messageInput" 
            placeholder="Type your message..." 
            rows="1"
        ></textarea>
        <button id="sendButton">Send</button>
        <button id="stopButton">Stop</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');
        const stopButton = document.getElementById('stopButton');
        const chatMessages = document.getElementById('chatMessages');
        const loading = document.getElementById('loading');
        const askButton = document.getElementById('askButton');
        const agentButton = document.getElementById('agentButton');
        const clearButton = document.getElementById('clearButton');
        const bulkActions = document.getElementById('bulkActions');
        const acceptAllButton = document.getElementById('acceptAllButton');
        const rejectAllButton = document.getElementById('rejectAllButton');
        let currentMode = 'ask';
        let isProcessing = false;

        askButton.addEventListener('click', () => {
            if (currentMode !== 'ask') {
                vscode.postMessage({
                    type: 'changeMode',
                    mode: 'ask'
                });
            }
        });

        agentButton.addEventListener('click', () => {
            if (currentMode !== 'agent') {
                vscode.postMessage({
                    type: 'changeMode',
                    mode: 'agent'
                });
            }
        });

        clearButton.addEventListener('click', () => {
            vscode.postMessage({
                type: 'clearMessages'
            });
        });

        // Bulk action button event listeners
        acceptAllButton.addEventListener('click', () => {
            vscode.postMessage({
                type: 'acceptAllChanges'
            });
            // Hide with animation
            bulkActions.classList.remove('show');
            setTimeout(() => {
                bulkActions.style.display = 'none';
            }, 300);
        });

        rejectAllButton.addEventListener('click', () => {
            vscode.postMessage({
                type: 'rejectAllChanges'
            });
            // Hide with animation
            bulkActions.classList.remove('show');
            setTimeout(() => {
                bulkActions.style.display = 'none';
            }, 300);
        });

        // Create a code block with header and copy button
        function createCodeBlock(code, language) {
            const container = document.createElement('div');
            container.className = 'code-block-container';

            // Create header with language and copy button
            const header = document.createElement('div');
            header.className = 'code-block-header';

            const languageLabel = document.createElement('span');
            languageLabel.className = 'language-label';
            languageLabel.textContent = language || 'plaintext';
            header.appendChild(languageLabel);

            const copyButton = document.createElement('button');
            copyButton.className = 'copy-button';
            copyButton.textContent = 'Copy';
            copyButton.onclick = async () => {
                try {
                    await navigator.clipboard.writeText(code);
                    copyButton.textContent = 'Copied!';
                    setTimeout(() => {
                        copyButton.textContent = 'Copy';
                    }, 2000);
                } catch (err) {
                    copyButton.textContent = 'Failed to copy';
                    setTimeout(() => {
                        copyButton.textContent = 'Copy';
                    }, 2000);
                }
            };
            header.appendChild(copyButton);

            // Create code content
            const codeContent = document.createElement('pre');
            codeContent.className = 'code-content';
            codeContent.textContent = code;

            container.appendChild(header);
            container.appendChild(codeContent);
            return container;
        }

        // Process markdown text (excluding code blocks)
        function processMarkdown(text) {
            if (!text || text.trim() === '') {
                return '';
            }
            
            // Normalize line endings and trim
            let processedText = text.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n').trim();
            
            // Split into lines for better processing
            let lines = processedText.split('\\n');
            let htmlLines = [];
            let inList = false;
            let listItems = [];
            let globalNumberCounter = 1; // Track global numbering across all numbered lists
            let currentListStartNumber = 1; // Track the start number for current list
            
            for (let i = 0; i < lines.length; i++) {
                let line = lines[i];
                let trimmedLine = line.trim();
                
                // Check if this is a list item
                let isBulletItem = /^[\\*\\-\\+]\\s+/.test(trimmedLine);
                let isNumberedItem = /^\\d+\\.\\s+/.test(trimmedLine);
                let isListItem = isBulletItem || isNumberedItem;
                
                if (isListItem) {
                    // If we were in a different type of list, close it first
                    if (inList && ((isBulletItem && inList !== 'ul') || (isNumberedItem && inList !== 'ol'))) {
                        if (inList === 'ul') {
                            htmlLines.push('<ul>' + listItems.join('') + '</ul>');
                        } else {
                            // For numbered lists, include start attribute if not starting from 1
                            let olTag = currentListStartNumber === 1 ? '<ol>' : '<ol start="' + currentListStartNumber + '">';
                            htmlLines.push(olTag + listItems.join('') + '</ol>');
                        }
                        listItems = [];
                    }
                    
                    // Extract list item content
                    let itemContent = '';
                    if (isBulletItem) {
                        itemContent = trimmedLine.replace(/^[\\*\\-\\+]\\s+/, '');
                        inList = 'ul';
                    } else {
                        itemContent = trimmedLine.replace(/^\\d+\\.\\s+/, '');
                        if (inList !== 'ol') {
                            // Starting a new numbered list
                            currentListStartNumber = globalNumberCounter;
                        }
                        inList = 'ol';
                        globalNumberCounter++;
                    }
                    
                    itemContent = processInlineMarkdown(itemContent);
                    listItems.push('<li>' + itemContent + '</li>');
                } else {
                    // If we were in a list and now we're not, close the list
                    if (inList) {
                        if (inList === 'ul') {
                            htmlLines.push('<ul>' + listItems.join('') + '</ul>');
                        } else {
                            // For numbered lists, include start attribute if not starting from 1
                            let olTag = currentListStartNumber === 1 ? '<ol>' : '<ol start="' + currentListStartNumber + '">';
                            htmlLines.push(olTag + listItems.join('') + '</ol>');
                        }
                        listItems = [];
                        inList = false;
                    }
                    
                    // Process non-list line
                    if (trimmedLine === '') {
                        // Empty line - will be used for paragraph breaks
                        htmlLines.push('');
                    } else {
                        // Process headers
                        if (/^###\\s+/.test(trimmedLine)) {
                            let headerContent = trimmedLine.replace(/^###\\s+/, '');
                            htmlLines.push('<h3>' + processInlineMarkdown(headerContent) + '</h3>');
                        } else if (/^##\\s+/.test(trimmedLine)) {
                            let headerContent = trimmedLine.replace(/^##\\s+/, '');
                            htmlLines.push('<h2>' + processInlineMarkdown(headerContent) + '</h2>');
                        } else if (/^#\\s+/.test(trimmedLine)) {
                            let headerContent = trimmedLine.replace(/^#\\s+/, '');
                            htmlLines.push('<h1>' + processInlineMarkdown(headerContent) + '</h1>');
                        } else {
                            // Regular text line
                            htmlLines.push(processInlineMarkdown(trimmedLine));
                        }
                    }
                }
            }
            
            // Close any remaining list
            if (inList) {
                if (inList === 'ul') {
                    htmlLines.push('<ul>' + listItems.join('') + '</ul>');
                } else {
                    // For numbered lists, include start attribute if not starting from 1
                    let olTag = currentListStartNumber === 1 ? '<ol>' : '<ol start="' + currentListStartNumber + '">';
                    htmlLines.push(olTag + listItems.join('') + '</ol>');
                }
            }
            
            // Group consecutive non-empty, non-header, non-list text lines into paragraphs
            let finalHtml = [];
            let paragraphLines = [];
            
            for (let i = 0; i < htmlLines.length; i++) {
                let line = htmlLines[i];
                
                if (line === '') {
                    // Empty line - end current paragraph if any
                    if (paragraphLines.length > 0) {
                        finalHtml.push('<p>' + paragraphLines.join('<br>') + '</p>');
                        paragraphLines = [];
                    }
                } else if (line.startsWith('<h') || line.startsWith('<ul>') || line.startsWith('<ol>')) {
                    // Header or list - end current paragraph and add element
                    if (paragraphLines.length > 0) {
                        finalHtml.push('<p>' + paragraphLines.join('<br>') + '</p>');
                        paragraphLines = [];
                    }
                    finalHtml.push(line);
                } else {
                    // Regular text line - add to current paragraph
                    paragraphLines.push(line);
                }
            }
            
            // Add any remaining paragraph
            if (paragraphLines.length > 0) {
                finalHtml.push('<p>' + paragraphLines.join('<br>') + '</p>');
            }
            
            return finalHtml.join('');
        }
        
        // Process inline markdown (bold, italic, code)
        function processInlineMarkdown(text) {
            return text
                // Bold (** or __)
                .replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>')
                .replace(/__(.*?)__/g, '<strong>$1</strong>')
                // Italic (* or _) - but not if it's part of bold
                .replace(/(?<!\\*)\\*([^\\*]+?)\\*(?!\\*)/g, '<em>$1</em>')
                .replace(/(?<!_)_([^_]+?)_(?!_)/g, '<em>$1</em>')
                // Inline code
                .replace(/\`([^\`]+)\`/g, '<code>$1</code>');
        }

        function showTerminalCommandConfirmation(command) {
            const confirmationDiv = document.createElement('div');
            confirmationDiv.className = 'terminal-command-confirmation';
            
            const title = document.createElement('h4');
            title.textContent = '🖥️ Terminal Command Request';
            confirmationDiv.appendChild(title);
            
            const description = document.createElement('p');
            description.textContent = 'The agent wants to run the following command:';
            confirmationDiv.appendChild(description);
            
            const commandDiv = document.createElement('div');
            commandDiv.className = 'terminal-command';
            commandDiv.textContent = command;
            confirmationDiv.appendChild(commandDiv);
            
            const buttonsDiv = document.createElement('div');
            buttonsDiv.className = 'terminal-command-buttons';
            
            const allowButton = document.createElement('button');
            allowButton.className = 'terminal-command-button allow-command-button';
            allowButton.textContent = '✓ Allow';
            allowButton.onclick = () => {
                vscode.postMessage({
                    type: 'confirmTerminalCommand',
                    allow: true
                });
                confirmationDiv.remove();
            };
            
            const denyButton = document.createElement('button');
            denyButton.className = 'terminal-command-button deny-command-button';
            denyButton.textContent = '✗ Deny';
            denyButton.onclick = () => {
                vscode.postMessage({
                    type: 'confirmTerminalCommand',
                    allow: false
                });
                confirmationDiv.remove();
            };
            
            buttonsDiv.appendChild(allowButton);
            buttonsDiv.appendChild(denyButton);
            confirmationDiv.appendChild(buttonsDiv);
            
            // Add to chat messages
            chatMessages.appendChild(confirmationDiv);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        function sendMessage() {
            const message = messageInput.value.trim();
            if (message && !isProcessing) {
                isProcessing = true;
                updateButtonStates();
                loading.style.display = 'block';
                vscode.postMessage({
                    type: 'sendMessage',
                    message: message,
                    mode: currentMode
                });
                messageInput.value = '';
            }
        }

        function stopProcess() {
            if (isProcessing) {
                vscode.postMessage({
                    type: 'stopProcess'
                });
            }
        }

        function updateButtonStates() {
            if (isProcessing) {
                sendButton.style.display = 'none';
                stopButton.style.display = 'block';
            } else {
                sendButton.style.display = 'block';
                stopButton.style.display = 'none';
            }
        }

        // Auto-expand textarea as user types
        messageInput.addEventListener('input', () => {
            messageInput.style.height = 'auto';
            messageInput.style.height = messageInput.scrollHeight + 'px';
        });

        // Handle enter key (send on Enter, new line on Shift+Enter)
        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // Handle button clicks
        sendButton.addEventListener('click', sendMessage);
        stopButton.addEventListener('click', stopProcess);

        // Process incoming messages
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'updateProcessingState':
                    isProcessing = message.isProcessing;
                    updateButtonStates();
                    if (!isProcessing) {
                        loading.style.display = 'none';
                    }
                    break;
                case 'updateMode':
                    currentMode = message.mode;
                    // Update button states based on the mode
                    if (currentMode === 'ask') {
                        askButton.classList.add('active');
                        agentButton.classList.remove('active');
                        bulkActions.classList.remove('show');
                        bulkActions.style.display = 'none';
                    } else {
                        agentButton.classList.add('active');
                        askButton.classList.remove('active');
                    }
                    break;
                case 'showBulkActions':
                    if (currentMode === 'agent' && message.show) {
                        bulkActions.style.display = 'block';
                        // Small delay to ensure the element is rendered before starting animation
                        setTimeout(() => {
                            bulkActions.classList.add('show');
                        }, 10);
                    } else {
                        bulkActions.classList.remove('show');
                        // Hide after animation completes
                        setTimeout(() => {
                            if (!bulkActions.classList.contains('show')) {
                                bulkActions.style.display = 'none';
                            }
                        }, 300);
                    }
                    break;
                case 'showTerminalCommandConfirmation':
                    showTerminalCommandConfirmation(message.command);
                    break;
                case 'addMessage':
                    loading.style.display = 'none';
                    const messageDiv = document.createElement('div');
                    messageDiv.className = 'message ' + message.sender;
                    
                    if (message.sender === 'assistant') {
                        // Split content by code blocks
                        const codeBlockRegex = new RegExp('(' + String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96) + '(?:([a-zA-Z]+)\\\\n)?)([\\\\s\\\\S]*?)' + String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96), 'g');
                        let lastIndex = 0;
                        let match;
                        
                        while ((match = codeBlockRegex.exec(message.message)) !== null) {
                            // Add text before code block (process as markdown)
                            if (match.index > lastIndex) {
                                const textContent = message.message.substring(lastIndex, match.index);
                                const textNode = document.createElement('div');
                                textNode.className = 'text-content';
                                textNode.innerHTML = processMarkdown(textContent);
                                messageDiv.appendChild(textNode);
                            }
                            
                            // Add code block
                            const language = match[2] || 'plaintext';
                            const code = match[3].trim();
                            messageDiv.appendChild(createCodeBlock(code, language));
                            
                            lastIndex = match.index + match[0].length;
                        }
                        
                        // Add remaining text after last code block (process as markdown)
                        if (lastIndex < message.message.length) {
                            const textContent = message.message.substring(lastIndex);
                            const textNode = document.createElement('div');
                            textNode.className = 'text-content';
                            textNode.innerHTML = processMarkdown(textContent);
                            messageDiv.appendChild(textNode);
                        }
                    } else {
                        // User messages are displayed as-is
                        messageDiv.textContent = message.message;
                    }
                    
                    chatMessages.appendChild(messageDiv);
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                    messageInput.focus();
                    
                    // Reset textarea height
                    messageInput.style.height = 'auto';
                    break;
                case 'updateMessage':
                    // Find the last assistant message and update it with new content
                    const lastAssistantMessageToUpdate = chatMessages.querySelector('.message.assistant:last-of-type');
                    if (lastAssistantMessageToUpdate) {
                        // Clear existing content
                        lastAssistantMessageToUpdate.innerHTML = '';
                        
                        // Split content by code blocks and process markdown
                        const codeBlockRegex = new RegExp('(' + String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96) + '(?:([a-zA-Z]+)\\\\n)?)([\\\\s\\\\S]*?)' + String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96), 'g');
                        let lastIndex = 0;
                        let match;
                        
                        while ((match = codeBlockRegex.exec(message.message)) !== null) {
                            // Add text before code block (process as markdown)
                            if (match.index > lastIndex) {
                                const textContent = message.message.substring(lastIndex, match.index);
                                const textNode = document.createElement('div');
                                textNode.className = 'text-content';
                                textNode.innerHTML = processMarkdown(textContent);
                                lastAssistantMessageToUpdate.appendChild(textNode);
                            }
                            
                            // Add code block
                            const language = match[2] || 'plaintext';
                            const code = match[3].trim();
                            lastAssistantMessageToUpdate.appendChild(createCodeBlock(code, language));
                            
                            lastIndex = match.index + match[0].length;
                        }
                        
                        // Add remaining text after last code block (process as markdown)
                        if (lastIndex < message.message.length) {
                            const textContent = message.message.substring(lastIndex);
                            const textNode = document.createElement('div');
                            textNode.className = 'text-content';
                            textNode.innerHTML = processMarkdown(textContent);
                            lastAssistantMessageToUpdate.appendChild(textNode);
                        }
                        
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                    }
                    break;
                case 'appendToMessage':
                    // Find the last assistant message and append to it
                    const lastAssistantMessage = chatMessages.querySelector('.message.assistant:last-of-type');
                    if (lastAssistantMessage) {
                        // Get the accumulated content from the last assistant message
                        let existingContent = '';
                        const textNodes = lastAssistantMessage.querySelectorAll('.text-content');
                        textNodes.forEach(node => {
                            existingContent += node.textContent || '';
                        });
                        
                        // Append the new message
                        const newContent = existingContent + message.message;
                        
                        // Clear existing content and rebuild with proper markdown processing
                        lastAssistantMessage.innerHTML = '';
                        
                        // Split content by code blocks and process markdown
                        const codeBlockRegex = new RegExp('(' + String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96) + '(?:([a-zA-Z]+)\\\\n)?)([\\\\s\\\\S]*?)' + String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96), 'g');
                        let lastIndex = 0;
                        let match;
                        
                        while ((match = codeBlockRegex.exec(newContent)) !== null) {
                            // Add text before code block (process as markdown)
                            if (match.index > lastIndex) {
                                const textContent = newContent.substring(lastIndex, match.index);
                                const textNode = document.createElement('div');
                                textNode.className = 'text-content';
                                textNode.innerHTML = processMarkdown(textContent);
                                lastAssistantMessage.appendChild(textNode);
                            }
                            
                            // Add code block
                            const language = match[2] || 'plaintext';
                            const code = match[3].trim();
                            lastAssistantMessage.appendChild(createCodeBlock(code, language));
                            
                            lastIndex = match.index + match[0].length;
                        }
                        
                        // Add remaining text after last code block (process as markdown)
                        if (lastIndex < newContent.length) {
                            const textContent = newContent.substring(lastIndex);
                            const textNode = document.createElement('div');
                            textNode.className = 'text-content';
                            textNode.innerHTML = processMarkdown(textContent);
                            lastAssistantMessage.appendChild(textNode);
                        }
                        
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                    }
                    break;
                case 'loadHistory':
                    loadHistory(message.history);
                    break;
                case 'clearMessages':
                    // Clear all messages from the chat
                    chatMessages.innerHTML = '';
                    break;
            }
        });

        function loadHistory(history) {
            // Clear current chat messages
            chatMessages.innerHTML = '';
            
            // Load history messages
            for (const historyItem of history) {
                const messageDiv = document.createElement('div');
                messageDiv.className = 'message ' + historyItem.type;
                
                if (historyItem.type === 'assistant') {
                    // Process assistant messages for code blocks
                    const codeBlockRegex = new RegExp('(' + String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96) + '(?:([a-zA-Z]+)\\\\n)?)([\\\\s\\\\S]*?)' + String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96), 'g');
                    let lastIndex = 0;
                    let match;
                    
                    while ((match = codeBlockRegex.exec(historyItem.message)) !== null) {
                        // Add text before code block (process as markdown)
                        if (match.index > lastIndex) {
                            const textContent = historyItem.message.substring(lastIndex, match.index);
                            const textNode = document.createElement('div');
                            textNode.className = 'text-content';
                            textNode.innerHTML = processMarkdown(textContent);
                            messageDiv.appendChild(textNode);
                        }
                        
                        // Add code block
                        const language = match[2] || 'plaintext';
                        const code = match[3].trim();
                        messageDiv.appendChild(createCodeBlock(code, language));
                        
                        lastIndex = match.index + match[0].length;
                    }
                    
                    // Add remaining text after last code block (process as markdown)
                    if (lastIndex < historyItem.message.length) {
                        const textContent = historyItem.message.substring(lastIndex);
                        const textNode = document.createElement('div');
                        textNode.className = 'text-content';
                        textNode.innerHTML = processMarkdown(textContent);
                        messageDiv.appendChild(textNode);
                    }
                } else {
                    // User messages are displayed as-is
                    messageDiv.textContent = historyItem.message;
                }
                
                chatMessages.appendChild(messageDiv);
            }
            
            // Scroll to bottom
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        // Initial setup
        messageInput.focus();
        updateButtonStates();
        
        // Request current processing state from extension
        vscode.postMessage({
            type: 'requestState'
        });
    </script>
</body>
</html>
    `;
    }

    private async handleTerminalCommandConfirmation(command: string): Promise<boolean> {
        return new Promise((resolve) => {
            this.pendingTerminalCommandResolve = resolve;
            
            // Send terminal command confirmation request to webview
            this._view?.webview.postMessage({
                type: 'showTerminalCommandConfirmation',
                command: command
            });
        });
    }
}