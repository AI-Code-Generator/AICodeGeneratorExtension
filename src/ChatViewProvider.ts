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

    constructor(
        private readonly _extensionUri: vscode.Uri,
        baseUrl: string
    ) {
        this._queryUrl = `${baseUrl}/ask-ai`;
        this._embedUrl = `${baseUrl}/embed`;
        this._enhanceUrl = `${baseUrl}/enhance-query`;
        this.contextGatherer = new ContextGatherer();
        this.agentService = new AgentService();
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
                            message: update,
                            sender: 'assistant'
                        });
                        isFirstUpdate = false;
                    } else {
                        // Append to the existing assistant message bubble
                        this._view?.webview.postMessage({
                            type: 'appendToMessage',
                            message: update,
                            sender: 'assistant'
                        });
                    }
                }).finally(() => {
                    // Add complete agent response to history
                    this.addToHistory('agent', 'assistant', agentResponse.trim());
                    
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
    </style>
</head>
<body>
    <div class="mode-selector">
        <button id="askButton" class="mode-button active">Ask</button>
        <button id="agentButton" class="mode-button">Agent</button>
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
                case 'addMessage':
                    loading.style.display = 'none';
                    const messageDiv = document.createElement('div');
                    messageDiv.className = 'message ' + message.sender;
                    
                    if (message.sender === 'assistant') {
                        // Split content by code blocks
                        const codeBlockRegex = /(\\\`\\\`\\\`(?:([a-zA-Z]+)\\n)?)([\\s\\S]*?)\\\`\\\`\\\`/g;
                        let lastIndex = 0;
                        let match;
                        
                        while ((match = codeBlockRegex.exec(message.message)) !== null) {
                            // Add text before code block
                            if (match.index > lastIndex) {
                                const textNode = document.createElement('div');
                                textNode.className = 'text-content';
                                textNode.textContent = message.message.substring(lastIndex, match.index);
                                messageDiv.appendChild(textNode);
                            }
                            
                            // Add code block
                            const language = match[2] || 'plaintext';
                            const code = match[3].trim();
                            messageDiv.appendChild(createCodeBlock(code, language));
                            
                            lastIndex = match.index + match[0].length;
                        }
                        
                        // Add remaining text after last code block
                        if (lastIndex < message.message.length) {
                            const textNode = document.createElement('div');
                            textNode.className = 'text-content';
                            textNode.textContent = message.message.substring(lastIndex);
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
                case 'appendToMessage':
                    // Find the last assistant message and append to it
                    const lastAssistantMessage = chatMessages.querySelector('.message.assistant:last-of-type');
                    if (lastAssistantMessage) {
                        // Create a new text node for the update
                        const appendNode = document.createElement('div');
                        appendNode.className = 'text-content';
                        appendNode.textContent = message.message;
                        lastAssistantMessage.appendChild(appendNode);
                        
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                    }
                    break;
                case 'loadHistory':
                    loadHistory(message.history);
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
                    const codeBlockRegex = /(\\\`\\\`\\\`(?:([a-zA-Z]+)\\n)?)([\\s\\S]*?)\\\`\\\`\\\`/g;
                    let lastIndex = 0;
                    let match;
                    
                    while ((match = codeBlockRegex.exec(historyItem.message)) !== null) {
                        // Add text before code block
                        if (match.index > lastIndex) {
                            const textNode = document.createElement('div');
                            textNode.className = 'text-content';
                            textNode.textContent = historyItem.message.substring(lastIndex, match.index);
                            messageDiv.appendChild(textNode);
                        }
                        
                        // Add code block
                        const language = match[2] || 'plaintext';
                        const code = match[3].trim();
                        messageDiv.appendChild(createCodeBlock(code, language));
                        
                        lastIndex = match.index + match[0].length;
                    }
                    
                    // Add remaining text after last code block
                    if (lastIndex < historyItem.message.length) {
                        const textNode = document.createElement('div');
                        textNode.className = 'text-content';
                        textNode.textContent = historyItem.message.substring(lastIndex);
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
}