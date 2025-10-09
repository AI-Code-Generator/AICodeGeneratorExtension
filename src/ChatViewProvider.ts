// src/ChatViewProvider.ts
import * as vscode from 'vscode';
import { similaritySearch } from './service/FileIndexer';
import { ContextGatherer } from './service/ContextGatherer';
import { AgentService } from './service/AgentService';
import { DiffManager } from './service/DiffManager';
import { ThreadManager, Thread, ThreadMetadata } from './service/ThreadManager';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private readonly _queryUrl: string;
    private readonly _embedUrl: string;
    private readonly _enhanceUrl: string;
    private readonly _agentUrl: string;
    private readonly _deleteMessageUrl?: string; // optional; server must implement
    private contextGatherer: ContextGatherer;
    private agentService: AgentService;
    private currentAbortController?: AbortController;
    private isProcessing: boolean = false;
    private currentMode: 'ask' | 'agent' = 'ask'; // Track current mode
    private threadManager: ThreadManager;
    private currentThread: Thread | null = null;
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
        this._deleteMessageUrl = `${baseUrl}/delete-message`;
        this._agentUrl = `${baseUrl}/agent`;
        this.contextGatherer = new ContextGatherer();
        this.agentService = new AgentService();
        this.threadManager = ThreadManager.getInstance(_context, baseUrl);
        
        // Set up terminal command callback
        this.agentService.setTerminalCommandCallback(this.handleTerminalCommandConfirmation.bind(this));
        
        // Initialize threads
        this.initializeThreads();
    }

    private generateId(prefix: string): string {
        try {
            const maybeCrypto = (globalThis as any).crypto;
            if (maybeCrypto?.randomUUID) {
                return `${prefix}_${maybeCrypto.randomUUID()}`;
            }
        } catch (e) {
            // fall back silently
        }
        return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,10)}`;
    }

    private async initializeThreads() {
        try {
            // Load or create initial thread
            const lastThreadId = this._context.globalState.get<string>('currentThreadId');
            if (lastThreadId) {
                this.currentThread = await this.threadManager.getThread(lastThreadId);
            }
            
            // If no thread exists, create a new one
            if (!this.currentThread) {
                this.currentThread = await this.threadManager.createNewThread();
            }
        } catch (error) {
            console.error('Failed to initialize threads:', error);
            // Create a new thread as fallback
            this.currentThread = await this.threadManager.createNewThread();
        }
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

    // Dynamically choose how many similar chunks to retrieve based on project size
    private computeSimilarityLimit(totalFiles: number): number {
        if (totalFiles <= 0) { return 8; }
        if (totalFiles <= 20) { return 8; }       // tiny project
        if (totalFiles <= 50) { return 20; }       // small
        if (totalFiles <= 100) { return 30; }     // medium-small
        if (totalFiles <= 300) { return 40; }     // medium
        if (totalFiles <= 600) { return 50; }     // medium-large
        if (totalFiles <= 1000) { return 60; }    // large
        if (totalFiles <= 2000) { return 70; }    // very large
        return 80; // cap to avoid overloading request size
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
        const agentUrl = this._agentUrl.valueOf();
        webviewView.webview.onDidReceiveMessage(async (data) => {
            if (data.type === 'requestState') {
                // Send current processing state, mode, and history to webview
                this.updateProcessingState();
                this._view?.webview.postMessage({
                    type: 'updateMode',
                    mode: this.currentMode
                });
                await this.sendCurrentThreadToWebview();
                await this.sendThreadListToWebview();
                return;
            }

            if (data.type === 'newThread') {
                await this.createNewThread();
                return;
            }

            if (data.type === 'switchThread') {
                await this.switchThread(data.threadId);
                return;
            }

            if (data.type === 'deleteThread') {
                await this.deleteThread(data.threadId);
                return;
            }
            if (data.type === 'deleteMessage') {
                if (this.currentThread) {
                    const messageId = data.id;
                    const messages = this.currentThread.messages || [];
                    const messageIndex = messages.findIndex(m => m.id === messageId);
            
                    if (messageIndex > -1) {
                        const message = messages[messageIndex];
                        const idsToDelete = [message.id];
            
                        // If the deleted message is a user message, also delete the next assistant message
                        if (message.type === 'user' && messageIndex + 1 < messages.length) {
                            const nextMessage = messages[messageIndex + 1];
                            if (nextMessage.type === 'assistant') {
                                idsToDelete.push(nextMessage.id);
                            }
                        }
            
                        await this.threadManager.deleteMessages(this.currentThread.id, idsToDelete);
                        
                        // Update the webview
                        this._view?.webview.postMessage({ type: 'messageDeleted', ids: idsToDelete });
                    }
                }
                return;
            }

            if (data.type === 'loadThreadList') {
                await this.sendThreadListToWebview();
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
                
                // Add user message to current thread
                const userMsgId = await this.addMessageToCurrentThread('user', data.message);
                
                // Display the user message first
                this._view?.webview.postMessage({
                    type: 'addMessage',
                    message: data.message,
                    sender: 'user',
                    id: userMsgId
                });
                
                // Hide bulk actions when starting new agent task
                this._view?.webview.postMessage({
                    type: 'showBulkActions',
                    show: false
                });
                
                let agentResponse = '';
                let assistantMsgId: string | null = null;
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
                        isFirstUpdate = false;
                    } else {
                        // Update the existing assistant message bubble with full content
                        this._view?.webview.postMessage({
                            type: 'updateMessage',
                            message: agentResponse.trim(),
                            sender: 'assistant'
                        });
                    }
                }).finally(async () => {
                    // Save final agent response to thread
                    if (agentResponse.trim()) {
                        await this.addMessageToCurrentThread('assistant', agentResponse.trim());
                    }
                    
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

                        // Decide similarity retrieval limit adaptively based on project size
                        const totalFiles = workspaceContext.filenames?.length || 0;
                        const adaptiveLimit = this.computeSimilarityLimit(totalFiles);

                        const similarityResults = await similaritySearch(enhancedQuery, adaptiveLimit);

                        // Transform similarity results to a compact metadata + content structure for server
                        const similarity = (similarityResults || []).map(r => ({
                            filePath: r.filePath,
                            startLine: r.startLine,
                            endLine: r.endLine,
                            type: r.chunkType,
                            score: r.score,
                            content: r.content
                        }));

                        // Determine if this is the first message of a new ask conversation
                        const currentMessages = this.currentThread?.messages || [];
                        const isNewAskTask = currentMessages.length === 0;

                        // Add user message to current thread
                        const userMessageId = await this.addMessageToCurrentThread('user', data.message);

                        // Send progress message
                        this._view?.webview.postMessage({
                            type: 'addMessage',
                            message: data.message,
                            sender: 'user',
                            id: userMessageId
                        });

                        // Server expects context: Optional[List[str]]; convert metadata objects to formatted strings
                        const contextStrings = similarity.map(s => {
                            const header = `<Chunk Info> ${s.filePath}: Line${s.startLine}-${s.endLine} [${s.type}] similarity score=${s.score.toFixed(3)}`;
                            // Trim content to avoid huge payloads
                            const trimmed = s.content.length > 800 ? s.content.slice(0, 800) + '...<trimmed>' : s.content;
                            return header + "\n" + trimmed;
                        });

                        // Ensure non-empty query content for model
                        if (!query.trim()) {
                            query = data.message || 'User query not provided';
                        }

                        // Send request to query endpoint
                        const response = await fetch(this._queryUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ 
                                query: query,
                                context: contextStrings,
                                user_ID: "0001",
                                is_new_task: isNewAskTask,
                                message_id: userMessageId
                            }),
                            signal: this.currentAbortController.signal
                        });

                        const jsonResponse: any = await response.json();

                        if (!jsonResponse.error) {
                            // Add AI response to current thread
                            const respId = await this.addMessageToCurrentThread('assistant', jsonResponse.response);
                            
                            // Send response back to webview
                            this._view?.webview.postMessage({
                                type: 'addMessage',
                                message: jsonResponse.response,
                                sender: 'assistant',
                                id: respId
                            });
                        } else {
                            throw new Error('Server request failed');
                        }
                    } catch (error: any) {
                        let errorMessage = '';
                        if (error.name === 'AbortError') {
                            errorMessage = 'Request was stopped by user.';
                        } else {
                            vscode.window.showErrorMessage(`Error: ${error}`);
                            errorMessage = 'Sorry, there was an error processing your request.';
                        }
                        
                        // Add error message to thread
                        const errId = await this.addMessageToCurrentThread('assistant', errorMessage);
                        
                        this._view?.webview.postMessage({
                            type: 'addMessage',
                            message: errorMessage,
                            sender: 'assistant',
                            id: errId
                        });
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

    private async addMessageToCurrentThread(type: 'user' | 'assistant', content: string): Promise<string> {
        if (!this.currentThread) {
            // Create a new thread if none exists
            this.currentThread = await this.threadManager.createNewThread();
        }

        await this.threadManager.addMessageToThread(this.currentThread.id, type, content);
        
        // Reload the thread to get the updated messages
        this.currentThread = await this.threadManager.getThread(this.currentThread.id);
        
        // Return the ID of the last message added
        if (this.currentThread && this.currentThread.messages.length > 0) {
            return this.currentThread.messages[this.currentThread.messages.length - 1].id;
        }
        
        return this.generateId('msg');
    }

    private async createNewThread() {
        try {
            this.currentThread = await this.threadManager.createNewThread();
            
            // Clear the webview
            this._view?.webview.postMessage({ type: 'clearMessages' });
            
            // Send the new thread list
            await this.sendThreadListToWebview();
            
            vscode.window.showInformationMessage('New conversation thread created');
        } catch (error) {
            console.error('Failed to create new thread:', error);
            vscode.window.showErrorMessage('Failed to create new thread');
        }
    }

    private async switchThread(threadId: string) {
        try {
            const thread = await this.threadManager.getThread(threadId);
            if (!thread) {
                vscode.window.showErrorMessage('Thread not found');
                return;
            }

            this.currentThread = thread;
            this.threadManager.setCurrentThreadId(threadId);
            
            // Send thread messages to webview
            await this.sendCurrentThreadToWebview();
            
        } catch (error) {
            console.error('Failed to switch thread:', error);
            vscode.window.showErrorMessage('Failed to switch thread');
        }
    }

    private async deleteThread(threadId: string) {
        try {
            await this.threadManager.deleteThread(threadId);
            
            // If we deleted the current thread, create a new one
            if (this.currentThread && this.currentThread.id === threadId) {
                this.currentThread = await this.threadManager.createNewThread();
                await this.sendCurrentThreadToWebview();
            }
            
            // Update thread list
            await this.sendThreadListToWebview();
            
            vscode.window.showInformationMessage('Thread deleted');
        } catch (error) {
            console.error('Failed to delete thread:', error);
            vscode.window.showErrorMessage('Failed to delete thread');
        }
    }

    private async sendCurrentThreadToWebview() {
        if (!this.currentThread) {
            this._view?.webview.postMessage({
                type: 'loadHistory',
                history: [],
                threadTitle: 'New Conversation'
            });
            return;
        }

        const history = this.currentThread.messages.map(msg => ({
            id: msg.id,
            type: msg.type,
            message: msg.content
        }));

        this._view?.webview.postMessage({
            type: 'loadHistory',
            history: history,
            threadTitle: this.currentThread.title || 'Conversation'
        });
    }

    private async sendThreadListToWebview() {
        try {
            const threads = await this.threadManager.getThreads(
                this.threadManager.getCurrentProjectPath()
            );

            this._view?.webview.postMessage({
                type: 'threadList',
                threads: threads,
                currentThreadId: this.currentThread?.id || null
            });
        } catch (error) {
            console.error('Failed to send thread list:', error);
        }
    }

    private async clearMessages() {
        if (!this.currentThread) {
            return;
        }
        
        // Delete the current thread and create a new one
        await this.threadManager.deleteThread(this.currentThread.id);
        this.currentThread = await this.threadManager.createNewThread();
        
        this._view?.webview.postMessage({ type: 'clearMessages' });
        await this.sendThreadListToWebview();
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
            position: relative;
        }
        .user { 
            background: var(--vscode-input-background);
            margin-left: 20px;
        }
        .assistant { 
            background: var(--vscode-editor-background);
            margin-right: 20px;
        }
        .delete-btn { 
            position: absolute; 
            top: 4px; 
            right: 6px; 
            background: transparent; 
            border: none; 
            cursor: pointer; 
            color: var(--vscode-descriptionForeground); 
            display: none;
            font-size: 14px;
            width: 20px;
            height: 20px;
            border-radius: 3px;
            z-index: 10;
        }
        .message.user:hover .delete-btn { 
            display: inline-block; 
        }
        .delete-btn:hover { 
            color: var(--vscode-errorForeground);
            background: var(--vscode-input-background);
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
        /* Thread History View */
        .thread-history-view {
            display: none;
            height: 100vh;
            overflow-y: auto;
            padding: 20px;
        }
        .thread-history-view.active {
            display: block;
        }
        .thread-history-header {
            margin-bottom: 20px;
        }
        .thread-history-header h2 {
            margin: 0 0 10px 0;
            color: var(--vscode-foreground);
        }
        .thread-history-actions {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
        }
        .new-thread-button {
            padding: 10px 20px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }
        .new-thread-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .thread-list {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .thread-item {
            padding: 15px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s;
            position: relative;
        }
        .thread-item:hover {
            background: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-focusBorder);
        }
        .thread-item-title {
            font-size: 14px;
            font-weight: 500;
            margin-bottom: 6px;
            color: var(--vscode-foreground);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .thread-item-meta {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            display: flex;
            gap: 15px;
        }
        .thread-item-delete {
            position: absolute;
            top: 10px;
            right: 10px;
            background: transparent;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            font-size: 18px;
            opacity: 0;
            transition: opacity 0.2s;
            width: 24px;
            height: 24px;
            border-radius: 3px;
        }
        .thread-item:hover .thread-item-delete {
            opacity: 1;
        }
        .thread-item-delete:hover {
            background: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-errorForeground);
        }
        .empty-threads {
            text-align: center;
            padding: 40px 20px;
            color: var(--vscode-descriptionForeground);
        }
        .empty-threads-icon {
            font-size: 48px;
            margin-bottom: 15px;
        }
        /* Chat View */
        .chat-view {
            display: none;
            height: 100vh;
        }
        .chat-view.active {
            display: flex;
            flex-direction: column;
        }
        .chat-header {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-input-border);
        }
        .back-button {
            padding: 6px 12px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }
        .back-button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .chat-header-title {
            flex: 1;
            font-size: 14px;
            color: var(--vscode-foreground);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
    </style>
</head>
<body>
    <div id="threadHistoryView" class="thread-history-view active">
        <div class="thread-history-header">
            <h2>Conversation History</h2>
        </div>
        <div class="thread-history-actions">
            <button id="newThreadButton" class="new-thread-button">+ New Conversation</button>
        </div>
        <div id="threadList" class="thread-list">
            <div class="empty-threads">
                <div class="empty-threads-icon">💬</div>
                <p>No conversations yet</p>
                <p style="font-size: 12px;">Start a new conversation to begin</p>
            </div>
        </div>
    </div>

    <div id="chatView" class="chat-view">
        <div class="chat-header">
            <button id="backButton" class="back-button">← Back</button>
            <div class="chat-header-title" id="chatHeaderTitle">Conversation</div>
            <div class="mode-selector">
                <div class="mode-buttons">
                    <button id="askButton" class="mode-button active">Ask</button>
                    <button id="agentButton" class="mode-button">Agent</button>
                </div>
            </div>
            <button id="clearButton" class="clear-button" title="Clear this conversation">🗑️ Clear</button>
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
        const backButton = document.getElementById('backButton');
        const newThreadButton = document.getElementById('newThreadButton');
        const threadHistoryView = document.getElementById('threadHistoryView');
        const chatView = document.getElementById('chatView');
        const threadList = document.getElementById('threadList');
        const chatHeaderTitle = document.getElementById('chatHeaderTitle');
        
        let currentMode = 'ask';
        let isProcessing = false;
        let currentThreadId = null;
        let threads = [];

        // View Management
        function showThreadHistory() {
            threadHistoryView.classList.add('active');
            chatView.classList.remove('active');
            vscode.postMessage({ type: 'loadThreadList' });
        }

        function showChat() {
            threadHistoryView.classList.remove('active');
            chatView.classList.add('active');
        }

        // Thread List Management
        function renderThreadList(threadData, currentThread) {
            threads = threadData || [];
            currentThreadId = currentThread;
            
            if (threads.length === 0) {
                threadList.innerHTML = \`
                    <div class="empty-threads">
                        <div class="empty-threads-icon">💬</div>
                        <p>No conversations yet</p>
                        <p style="font-size: 12px;">Start a new conversation to begin</p>
                    </div>
                \`;
                return;
            }

            threadList.innerHTML = '';
            threads.forEach(thread => {
                const threadItem = document.createElement('div');
                threadItem.className = 'thread-item';
                
                const title = document.createElement('div');
                title.className = 'thread-item-title';
                title.textContent = thread.title || 'Untitled Conversation';
                
                const meta = document.createElement('div');
                meta.className = 'thread-item-meta';
                meta.innerHTML = \`
                    <span>\${formatTimestamp(thread.updatedAt)}</span>
                    <span>\${thread.messageCount || 0} messages</span>
                \`;
                
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'thread-item-delete';
                deleteBtn.textContent = '×';
                deleteBtn.title = 'Delete thread';
                deleteBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (confirm('Delete this conversation?')) {
                        vscode.postMessage({ 
                            type: 'deleteThread', 
                            threadId: thread.id 
                        });
                    }
                };
                
                threadItem.appendChild(title);
                threadItem.appendChild(meta);
                threadItem.appendChild(deleteBtn);
                
                threadItem.onclick = () => {
                    vscode.postMessage({ 
                        type: 'switchThread', 
                        threadId: thread.id 
                    });
                    chatHeaderTitle.textContent = thread.title || 'Conversation';
                    showChat();
                };
                
                threadList.appendChild(threadItem);
            });
        }

        function formatTimestamp(timestamp) {
            const now = Date.now();
            const diff = now - timestamp;
            const minutes = Math.floor(diff / 60000);
            const hours = Math.floor(diff / 3600000);
            const days = Math.floor(diff / 86400000);
            
            if (minutes < 1) return 'Just now';
            if (minutes < 60) return \`\${minutes} min ago\`;
            if (hours < 24) return \`\${hours} hour\${hours > 1 ? 's' : ''} ago\`;
            if (days === 1) return 'Yesterday';
            if (days < 7) return \`\${days} days ago\`;
            
            const date = new Date(timestamp);
            return date.toLocaleDateString();
        }

        // Button Event Listeners
        backButton.addEventListener('click', () => {
            showThreadHistory();
        });

        newThreadButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'newThread' });
            chatHeaderTitle.textContent = 'New Conversation';
            showChat();
        });

        // Mode buttons in chat view
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
                    if (message.id) messageDiv.dataset.id = message.id;
                    if (message.sender === 'user') {
                        const del = document.createElement('button');
                        del.textContent = '✕';
                        del.className = 'delete-btn';
                        del.title = 'Delete message';
                        del.addEventListener('click', (e) => {
                            e.stopPropagation();
                            if (messageDiv.dataset.id) {
                                vscode.postMessage({ type: 'deleteMessage', id: messageDiv.dataset.id });
                            }
                        });
                        messageDiv.appendChild(del);
                    }
                    
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
                        // User messages: preserve delete button; add text container
                        const userText = document.createElement('div');
                        userText.className = 'text-content';
                        userText.textContent = message.message;
                        messageDiv.appendChild(userText);
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
                case 'threadList':
                    renderThreadList(message.threads, message.currentThreadId);
                    break;
                case 'loadHistory':
                    chatHeaderTitle.textContent = message.threadTitle || 'Conversation';
                    showChat();
                    loadHistory(message.history);
                    break;
                case 'clearMessages':
                    // Clear all messages from the chat
                    chatMessages.innerHTML = '';
                    break;
                case 'messageDeleted':
                    if (message.ids && Array.isArray(message.ids)) {
                        message.ids.forEach(mid => {
                            const selMulti = '.message[data-id="' + mid + '"]';
                            const node = chatMessages.querySelector(selMulti);
                            if (node) node.remove();
                        });
                    } else if (message.id) {
                        const selSingle = '.message[data-id="' + message.id + '"]';
                        const node = chatMessages.querySelector(selSingle);
                        if (node) node.remove();
                    }
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
                if (historyItem.id) messageDiv.dataset.id = historyItem.id;
                if (historyItem.type === 'user') {
                    const del = document.createElement('button');
                    del.textContent = '✕';
                    del.className = 'delete-btn';
                    del.title = 'Delete message';
                    del.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (messageDiv.dataset.id) {
                            vscode.postMessage({ type: 'deleteMessage', id: messageDiv.dataset.id });
                        }
                    });
                    messageDiv.appendChild(del);
                }
                
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
                    // User message: keep delete button; add text container
                    const userText = document.createElement('div');
                    userText.className = 'text-content';
                    userText.textContent = historyItem.message;
                    messageDiv.appendChild(userText);
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