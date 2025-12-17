// src/ChatViewProvider.ts
import * as vscode from 'vscode';
import { enhancedSimilaritySearch, EnhancedSearchResult } from './service/FileIndexer';
import { ContextGatherer } from './service/ContextGatherer';
import { AgentService } from './service/AgentService';
import { DiffManager } from './service/DiffManager';
import { ThreadManager, Thread, ThreadMetadata } from './service/ThreadManager';
import { AuthManager } from './service/AuthService'; // Import AuthManager

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private readonly _queryUrl: string;
    private readonly _embedUrl: string;
    private readonly _enhanceUrl: string;
    private readonly _agentUrl: string;
    private readonly _authLoginUrl: string;
    private readonly _authRegisterUrl: string;
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
    private agentResponse: string = '';
    private authManager: AuthManager; // Add AuthManager

    constructor(
        private readonly _extensionUri: vscode.Uri,
        baseUrl: string,
        private readonly _context: vscode.ExtensionContext,
        authManager: AuthManager // Receive AuthManager
    ) {
        this._queryUrl = `${baseUrl}/ask-ai`;
        this._embedUrl = `${baseUrl}/embed`;
        this._enhanceUrl = `${baseUrl}/enhance-query`;
        this._deleteMessageUrl = `${baseUrl}/delete-message`;
        this._agentUrl = `${baseUrl}/agent`;
        this._authLoginUrl = `${baseUrl}/auth/login`; // Auth endpoint
        this._authRegisterUrl = `${baseUrl}/auth/register`; // Auth endpoint

        this.authManager = authManager; // Store AuthManager
        this.contextGatherer = new ContextGatherer();
        this.agentService = new AgentService(_context);
        
        // Pass AuthManager to ThreadManager
        this.threadManager = ThreadManager.getInstance(_context, baseUrl, this.authManager);
        
        // Set up terminal command callback
        this.agentService.setTerminalCommandCallback(this.handleTerminalCommandConfirmation.bind(this));
        
        // Initialize threads (will be deferred until user is logged in)
        // this.initializeThreads(); // We'll do this after login check
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
        // Check for auth first
        const token = await this.authManager.getToken();
        if (!token) {
            this._view?.webview.postMessage({ type: 'showLogin' });
            return;
        }

        try {
            // Load last active thread
            const lastThreadId = this._context.globalState.get<string>('currentThreadId');
            if (lastThreadId) {
                // This will fetch from server, protected by auth
                this.currentThread = await this.threadManager.getThread(lastThreadId);
                if (!this.currentThread) {
                    // Thread wasn't found or didn't belong to this user
                    this._context.globalState.update('currentThreadId', undefined);
                }
            }
            
            // Send logged-in user ID (or email) to webview for display
            const userId = this.authManager.getUserIdFromToken(token);
            this._view?.webview.postMessage({ type: 'loginSuccess', userId: userId });

        } catch (error) {
            console.error('Failed to initialize threads:', error);
            // If auth failed, show login
            if ((error as Error).message.includes('Not authenticated')) {
                 this._view?.webview.postMessage({ type: 'showLogin' });
            }
            this.currentThread = null;
        }
    }

    // ... (getCodeContext, embedCodeContext, enhanceQuery, computeSimilarityLimit remain the same) ...
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
        const token = await this.authManager.getToken();
        if (!token) {
            throw new Error('Not authenticated');
        }

        try {
            const response = await fetch(this._enhanceUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}` // Add auth header
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
            
            // --- NEW AUTH HANDLERS ---
            if (data.type === 'login') {
                try {
                    const formData = new URLSearchParams();
                    formData.append('username', data.email);
                    formData.append('password', data.password);

                    const response = await fetch(this._authLoginUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        body: formData.toString()
                    });

                    if (!response.ok) {
                        const errorData = await response.json().catch(() => ({ detail: 'Login failed' }));
                        throw new Error(errorData.detail);
                    }

                    const result = await response.json();
                    await this.authManager.setToken(result.access_token);
                    
                    // Re-initialize threads and state
                    await this.initializeThreads();
                    
                    await this.sendCurrentThreadToWebview();

                } catch (error: any) {
                    this._view?.webview.postMessage({ type: 'authError', message: error.message });
                }
                return;
            }

            if (data.type === 'register') {
                 try {
                    const formData = new URLSearchParams();
                    formData.append('username', data.email);
                    formData.append('password', data.password);

                    const response = await fetch(this._authRegisterUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        body: formData.toString()
                    });

                    if (!response.ok) {
                        const errorData = await response.json().catch(() => ({ detail: 'Registration failed' }));
                        throw new Error(errorData.detail);
                    }
                    
                    this._view?.webview.postMessage({ type: 'registrationSuccess' });

                } catch (error: any) {
                    this._view?.webview.postMessage({ type: 'authError', message: error.message });
                }
                return;
            }
            
            if (data.type === 'logout') {
                await this.authManager.clearToken();
                this.currentThread = null;
                this._view?.webview.postMessage({ type: 'showLogin' });
                return;
            }

            if (data.type === 'requestState') {
                // This is for a "fresh open" or "reload" of the webview
                const token = await this.authManager.getToken();
                if (!token) {
                    this._view?.webview.postMessage({ type: 'showLogin' });
                    return;
                }
                
                // User is logged in, proceed.
                const userId = this.authManager.getUserIdFromToken(token);
                this._view?.webview.postMessage({ type: 'loginSuccess', userId: userId });

                this.updateProcessingState();
                this._view?.webview.postMessage({
                    type: 'updateMode',
                    mode: this.currentMode
                });

                this.currentThread = null; 
                await this.sendCurrentThreadToWebview();
                return;
            }

            // --- END AUTH HANDLERS ---
            
            // All handlers below this point should be protected
            const token = await this.authManager.getToken();
            if (!token) {
                this._view?.webview.postMessage({ type: 'showLogin' });
                vscode.window.showErrorMessage('You must be logged in to perform this action.');
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
                await this.confirmAndDeleteThread(data.threadId, data.threadTitle);
                return;
            }
            if (data.type === 'deleteMessage') {
                if (this.currentThread) {
                    // Refresh the thread to ensure we have the latest messages
                    // This is important when deleting right after stopping an agent
                    this.currentThread = await this.threadManager.getThread(this.currentThread.id);
                    if (!this.currentThread) {
                        return;
                    }
                    
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
                        
                        // This call is now authenticated
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
                this.clearMessages(); // This is an alias for deleteThread
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
                
                this.agentResponse = '';
                let isFirstUpdate = true;
                let lastStatusLine: string | null = null; // Track the last "waiting" status line
                
                // AgentService.processRequest now needs the auth token
                this.agentService.processRequest(
                    data.message, 
                    agentUrl, 
                    token, // Pass auth token
                    (update) => {
                        // Check if this is a completion update (✅ or ❌) that should replace a waiting update (⏳)
                        const isWaitingUpdate = update.startsWith('⏳');
                        const isCompletionUpdate = update.startsWith('✅') || update.startsWith('❌');
                        
                        if (isWaitingUpdate) {
                            // Store this as the last status line (will be replaced when done)
                            lastStatusLine = update;
                            this.agentResponse += update + '\n';
                        } else if (isCompletionUpdate && lastStatusLine) {
                            // Replace the last waiting line with this completion line
                            const lines = this.agentResponse.trimEnd().split('\n');
                            // Find and replace the last occurrence of the waiting line
                            for (let i = lines.length - 1; i >= 0; i--) {
                                if (lines[i] === lastStatusLine) {
                                    lines[i] = update;
                                    break;
                                }
                            }
                            this.agentResponse = lines.join('\n') + '\n';
                            lastStatusLine = null;
                        } else {
                            // Regular update, just append
                            this.agentResponse += update + '\n';
                            // Don't clear lastStatusLine for "Stopped by user" - it will replace the ⏳
                            if (!update.includes('Stopped by user')) {
                                lastStatusLine = null;
                            }
                        }
                        
                        if (isFirstUpdate) {
                            // Create the initial assistant message bubble
                            this._view?.webview.postMessage({
                                type: 'addMessage',
                                message: this.agentResponse.trim(),
                                sender: 'assistant'
                            });
                            isFirstUpdate = false;
                        } else {
                            // Update the existing assistant message bubble with full content
                            this._view?.webview.postMessage({
                                type: 'updateMessage',
                                message: this.agentResponse.trim(),
                                sender: 'assistant'
                            });
                        }
                    }, 
                    this.currentThread?.id ?? null
                ).finally(async () => {
                    // Clean up any remaining ⏳ (waiting) lines - replace with ❌ (cancelled)
                    // This handles the case when the process was stopped mid-execution
                    let finalResponse = this.agentResponse.trim();
                    finalResponse = finalResponse.split('\n').map(line => {
                        if (line.startsWith('⏳')) {
                            // Replace waiting status with cancelled - extract the action description
                            const action = line.substring(2).trim(); // Remove ⏳ and space
                            return `❌ Cancelled: ${action.replace(/^Running /, '').replace(/^Applying /, '').replace(/^Searching /, '').replace(/^Reading /, '').replace(/^Listing /, '')}`;
                        }
                        return line;
                    }).join('\n');

                    // Get the thought history from the agent service
                    const thoughtHistory = this.agentService.getThoughtsDebug();
                
                    if (thoughtHistory.summarizedArchive || thoughtHistory.recentThoughts.length > 0) {
                        let historyMarkdown = "\n\n---\n### Agent's Thought Process\n";
                
                        if (thoughtHistory.summarizedArchive) {
                            historyMarkdown += `**Previous Thought Summary:**\n\`\`\`\n${thoughtHistory.summarizedArchive}\n\`\`\`\n`;
                        }
                
                        if (thoughtHistory.recentThoughts.length > 0) {
                            historyMarkdown += `**Recent Thoughts:**\n`;
                            thoughtHistory.recentThoughts.forEach((thought, index) => {
                                historyMarkdown += `${index + 1}. ${thought}\n`;
                            });
                        }
                        
                        finalResponse += historyMarkdown;
                    }
                
                    // Save final agent response (with thoughts) to thread - always save if there's any response
                    // This ensures the assistant message gets an ID for deletion purposes
                    if (finalResponse) {
                        const assistantMsgId = await this.addMessageToCurrentThread('assistant', finalResponse);
                        // Update the assistant message in the DOM with its ID so it can be deleted later
                        this._view?.webview.postMessage({
                            type: 'setLastAssistantMessageId',
                            id: assistantMsgId
                        });
                    } else if (!isFirstUpdate) {
                        // If there's no finalResponse but an assistant message bubble was created (isFirstUpdate became false),
                        // we still need to set an ID on it. Save an empty/placeholder message.
                        const assistantMsgId = await this.addMessageToCurrentThread('assistant', '(No response)');
                        this._view?.webview.postMessage({
                            type: 'setLastAssistantMessageId',
                            id: assistantMsgId
                        });
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
                        
                        // Prepare the query with context
                        let query = `${data.message}\n\nLanguage: ${fileLanguage}`;
                        if (selectedCode.trim()) {
                            query += `\nSelected code:\n${selectedCode}`;
                        }

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

                        const similarityResults = await enhancedSimilaritySearch(enhancedQuery, this._context, adaptiveLimit);

                        // Transform enhanced similarity results
                        const similarity = (similarityResults || []).map((r: EnhancedSearchResult) => ({
                            filePath: r.filePath,
                            startLine: r.startLine,
                            endLine: r.endLine,
                            type: r.chunkType,
                            score: r.score,
                            content: r.content,
                            retrievalMode: r.retrievalMode
                        }));

                        // Add user message to current thread
                        const userMessageId = await this.addMessageToCurrentThread('user', data.message);

                        // Send progress message
                        this._view?.webview.postMessage({
                            type: 'addMessage',
                            message: data.message,
                            sender: 'user',
                            id: userMessageId
                        });

                        // Server expects context: Optional[List[str]];
                        const contextStrings = similarity.map(s => {
                            const modeLabel = s.retrievalMode === 'full_file' ? '[FULL FILE]' : '[CHUNK+NEIGHBORS]';
                            const header = `<Context Info> ${s.filePath}: Lines ${s.startLine}-${s.endLine} ${modeLabel} [${s.type}] score=${s.score.toFixed(3)}`;
                            // Allow more content for full files since they provide complete context
                            const contentLimit = s.retrievalMode === 'full_file' ? 2000 : 1200;
                            const trimmed = s.content.length > contentLimit
                                ? s.content.slice(0, contentLimit) + '...<trimmed>'
                                : s.content;
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
                                'Authorization': `Bearer ${token}` // Add auth header
                            },
                            body: JSON.stringify({ 
                                query: query,
                                context: contextStrings,
                                // user_ID is removed
                                thread_id: this.currentThread?.id,
                                message_id: userMessageId
                            }),
                            signal: this.currentAbortController.signal
                        });
                        
                        if (!response.ok) {
                             if (response.status === 401) {
                                throw new Error('Authentication failed. Please log out and log in again.');
                            }
                            const errorData = await response.json().catch(() => ({}));
                            throw new Error(`Server request failed: ${response.statusText} - ${errorData.detail || ''}`);
                        }

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
                            throw new Error(`Server returned an error: ${jsonResponse.error}`);
                        }
                    } catch (error: any) {
                        let errorMessage = '';
                        if (error.name === 'AbortError') {
                            errorMessage = 'Request was stopped by user.';
                        } else {
                            vscode.window.showErrorMessage(`Error: ${error.message}`);
                            errorMessage = `Sorry, there was an error processing your request: ${error.message}`;
                        }
                        
                        // Add error message to thread
                        const errId = await this.addMessageToCurrentThread('assistant', errorMessage);
                        
                        this._view?.webview.postMessage({
                            type: 'addMessage',
                            message: errorMessage,
                            sender: 'assistant',
                            id: errId
                        });

                        if (error.message.includes('Authentication failed')) {
                            this.logout();
                        }
                    } finally {
                        this.isProcessing = false;
                        this.currentAbortController = undefined;
                        this.updateProcessingState();
                    }
                    break;
            }
        });
    }

    public logout() {
        this.authManager.clearToken();
        this.currentThread = null;
        this._view?.webview.postMessage({ type: 'showLogin' });
    }

    private stopCurrentProcess() {
        if (this.currentAbortController) {
            this.currentAbortController.abort();
        }
        if (this.agentService) {
            this.agentService.stop();
        }
        
        // If there's a pending terminal command confirmation, reject it and dismiss the popup
        if (this.pendingTerminalCommandResolve) {
            this.pendingTerminalCommandResolve(false);
            this.pendingTerminalCommandResolve = undefined;
            // Dismiss the terminal command confirmation popup in webview
            this._view?.webview.postMessage({ type: 'dismissTerminalCommandConfirmation' });
        }
        
        // Don't save here - let the .finally() block handle saving to avoid duplicates
        // The agentWasStopped flag is set by calling agentService.stop()
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
            await this.sendThreadListToWebview();
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
            
            await this.sendThreadListToWebview();
            await this.sendCurrentThreadToWebview();
            
            vscode.window.showInformationMessage('New conversation thread created');
        } catch (error: any) {
            console.error('Failed to create new thread:', error);
            vscode.window.showErrorMessage(`Failed to create new thread: ${error.message}`);
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
            
        } catch (error: any) {
            console.error('Failed to switch thread:', error);
            vscode.window.showErrorMessage(`Failed to switch thread: ${error.message}`);
        }
    }

    private async deleteThread(threadId: string) {
        try {
            await this.threadManager.deleteThread(threadId);
            
            if (this.currentThread && this.currentThread.id === threadId) {
                this.currentThread = null;
                this._context.globalState.update('currentThreadId', undefined);
                // Tell webview to go back to history
                this._view?.webview.postMessage({ type: 'showThreadHistory' });
            }
            
            // Refresh the list
            await this.sendThreadListToWebview();
            
            vscode.window.showInformationMessage('Thread deleted');
        } catch (error: any) {
            console.error('Failed to delete thread:', error);
            vscode.window.showErrorMessage(`Failed to delete thread: ${error.message}`);
        }
    }

    private async confirmAndDeleteThread(threadId: string, threadTitle?: string) {
        const title = threadTitle?.trim() ? `"${threadTitle.trim()}"` : 'this conversation';
        const selection = await vscode.window.showWarningMessage(
            `Delete ${title}? This action cannot be undone.`,
            { modal: true },
            'Delete'
        );

        if (selection !== 'Delete') {
            return;
        }

        await this.deleteThread(threadId);
    }

    /**
     * Decides what to show the webview.
     * If a thread is active, sends 'loadHistory' (shows chat).
     * If no thread is active, sends 'showThreadHistory' AND 'threadList' (shows list).
     */
    private async sendCurrentThreadToWebview() {
        if (!this.currentThread) {
            // No active thread, show the history list
            this._view?.webview.postMessage({
                type: 'showThreadHistory'
            });
            // Since we are showing the history, send the list.
            await this.sendThreadListToWebview();
            return;
        }

        // Active thread exists, send its content
        // Strip thought process from messages for display (it's saved for server context but not shown in UI)
        const history = this.currentThread.messages.map(msg => ({
            id: msg.id,
            type: msg.type,
            message: msg.type === 'assistant' ? this.stripThoughtProcess(msg.content) : msg.content
        }));

        this._view?.webview.postMessage({
            type: 'loadHistory',
            history: history,
            threadTitle: this.currentThread.title || 'Conversation'
        });
    }

    /**
     * Strips the "Agent's Thought Process" section from a message for UI display.
     * The thought process is saved to the database for context but hidden from the user.
     */
    private stripThoughtProcess(content: string): string {
        // Find and remove the thought process section (starts with "---\n### Agent's Thought Process")
        const thoughtProcessMarker = /\n*---\n### Agent's Thought Process[\s\S]*$/;
        return content.replace(thoughtProcessMarker, '').trim();
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
        } catch (error: any) {
            console.error('Failed to send thread list:', error);
            // Don't show error to user, just log it
        }
    }

    private async clearMessages() {
        if (!this.currentThread) {
            return;
        }
        
        await this.deleteThread(this.currentThread.id);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const backIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'icons', 'backbutton.svg'));
        const askIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'icons', 'ask.svg'));
        const agentIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'icons', 'agent.svg'));
        const deleteIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'icons', 'delete.svg'));
        const doneIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'icons', 'done.svg'));
        const loadingIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'icons', 'loading.svg'));
        const stoppedIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'icons', 'stopped.svg'));

        // Updated HTML with login/register UI
        return `
        <!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        :root {
            --container-padding: 20px;
            --input-padding-vertical: 12px;
            --input-padding-horizontal: 16px;
            --radius-sm: 6px;
            --radius-md: 8px;
            --radius-lg: 12px;
            --radius-xl: 24px;
        }

        body { 
            font-family: var(--vscode-font-family);
            font-weight: var(--vscode-font-weight);
            font-size: var(--vscode-font-size);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 0; 
            margin: 0;
            overflow: hidden;
            height: 100vh;
        }
        
        /* --- Animations --- */
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        @keyframes slideUp {
            from { transform: translateY(20px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }

        /* --- Global Loader --- */
        .global-loading {
            display: none; /* Hidden by default */
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            font-size: 1.2em;
            color: var(--vscode-descriptionForeground);
            animation: fadeIn 0.3s ease;
        }
        .global-loading.active {
            display: flex;
        }

        /* --- Login View --- */
        .login-view {
            display: none; /* Hidden by default */
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            padding: 20px;
            box-sizing: border-box;
            animation: fadeIn 0.3s ease;
        }
        .login-view.active {
            display: flex;
        }
        .auth-container {
            width: 100%;
            max-width: 320px;
            padding: 30px;
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: var(--radius-md);
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
        }
        .auth-container h2 {
            text-align: center;
            margin-top: 0;
            margin-bottom: 24px;
            color: var(--vscode-foreground);
            font-weight: 600;
        }
        .auth-form-group {
            margin-bottom: 20px;
        }
        .auth-form-group label {
            display: block;
            margin-bottom: 8px;
            font-size: 13px;
            font-weight: 500;
            color: var(--vscode-descriptionForeground);
        }
        .auth-input {
            width: 100%;
            padding: 10px 12px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            color: var(--vscode-input-foreground);
            border-radius: var(--radius-sm);
            box-sizing: border-box;
            transition: border-color 0.2s;
        }
        .auth-input:focus {
            border-color: var(--vscode-focusBorder);
            outline: none;
        }
        .auth-button {
            width: 100%;
            padding: 12px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: var(--radius-sm);
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: background-color 0.2s;
        }
        .auth-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .auth-switch-link {
            margin-top: 20px;
            text-align: center;
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }
        .auth-switch-link a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            cursor: pointer;
            font-weight: 500;
        }
        .auth-switch-link a:hover {
            text-decoration: underline;
        }
        .auth-error {
            color: var(--vscode-errorForeground);
            background: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            padding: 12px;
            border-radius: var(--radius-sm);
            font-size: 13px;
            margin-bottom: 20px;
            display: none;
            text-align: center;
        }

        /* --- Main App Views --- */
        .mode-selector {
            display: flex;
            gap: 8px;
            padding: 4px;
            background: var(--vscode-input-background);
            border-radius: var(--radius-md);
            border: 1px solid var(--vscode-input-border);
        }
        .mode-buttons {
            display: flex;
            gap: 10px;
            position: relative;
        }
        .active-indicator {
            position: absolute;
            background: var(--vscode-button-background);
            border-radius: var(--radius-sm);
            z-index: 1;
            height: 100%;
            top: 0;
            left: 0;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            pointer-events: none;
        }
        .clear-button, .logout-button {
            padding: 6px 12px;
            border: 1px solid transparent;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            border-radius: var(--radius-sm);
            cursor: pointer;
            font-size: 12px;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .clear-button:hover {
            background: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-errorForeground);
        }
        .logout-button:hover {
            background: var(--vscode-list-hoverBackground);
            color: var(--vscode-foreground);
        }
        .mode-button {
            padding: 6px 16px;
            border: none;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            border-radius: var(--radius-sm);
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            transition: color 0.2s;
            position: relative;
            z-index: 2;
        }
        .mode-button:hover {
            color: var(--vscode-foreground);
        }
        .mode-button.active {
            background: transparent;
            color: var(--vscode-button-foreground);
            box-shadow: none;
        }
        
        .message { 
            margin: 16px 0; 
            padding: 12px 16px; 
            border-radius: var(--radius-lg); 
            white-space: pre-wrap;
            position: relative;
            line-height: 1.5;
            max-width: 90%;
            animation: slideUp 0.3s ease-out;
            box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        }
        .user { 
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            margin-left: auto; /* Align right */
            margin-right: 0;
            border-bottom-right-radius: 2px;
            border: 1px solid var(--vscode-button-border, transparent);
        }
        .assistant { 
            background: var(--vscode-editor-inactiveSelectionBackground);
            color: var(--vscode-editor-foreground);
            margin-right: auto; /* Align left */
            margin-left: 0;
            border-bottom-left-radius: 2px;
            border: 1px solid var(--vscode-widget-border);
        }
        .delete-btn { 
            position: absolute; 
            top: -8px; 
            right: -8px; 
            background: var(--vscode-editor-background); 
            border: 1px solid var(--vscode-input-border); 
            cursor: pointer; 
            color: var(--vscode-descriptionForeground); 
            display: none;
            font-size: 12px;
            width: 20px;
            height: 20px;
            border-radius: 50%;
            z-index: 10;
            align-items: center;
            justify-content: center;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .message:hover .delete-btn { 
            display: flex; 
        }
        .delete-btn:hover { 
            color: var(--vscode-errorForeground);
            border-color: var(--vscode-errorForeground);
        }
        
        .input-container {
            position: fixed;
            bottom: 16px;
            left: 16px;
            right: 16px;
            display: flex;
            gap: 10px;
            background: var(--vscode-editor-background);
            padding: 10px;
            z-index: 1000;
            border-radius: var(--radius-xl);
            box-shadow: 0 4px 20px rgba(0,0,0,0.15);
            border: 1px solid var(--vscode-widget-border);
            align-items: flex-start; /* Align to top */
        }
        #messageInput { 
            flex-grow: 1;
            padding: 12px 16px; /* Increased vertical padding to match button height */
            background: transparent;
            border: none;
            color: var(--vscode-input-foreground);
            resize: none; 
            border-radius: var(--radius-xl);
            min-height: 40px; /* Explicit min-height */
            max-height: 150px;
            font-family: inherit;
            font-size: inherit;
            line-height: 1.4;
            box-sizing: border-box; /* Ensure padding is included in height */
            overflow-y: hidden; /* Hide scrollbar initially to prevent height jump */
        }
        #messageInput:focus {
            outline: none;
        }
        #sendButton, #stopButton {
            padding: 0 20px; /* Remove vertical padding, set height explicitly */
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 20px;
            cursor: pointer;
            white-space: nowrap;
            font-weight: 500;
            transition: transform 0.1s, background-color 0.2s;
            display: flex;
            align-items: center;
            height: 40px; /* Match input min-height */
            margin-top: 0; /* Ensure alignment */
        }
        #sendButton:hover, #stopButton:hover {
            background: var(--vscode-button-hoverBackground);
            transform: translateY(-1px);
        }
        #sendButton:active, #stopButton:active {
            transform: translateY(0);
        }
        #stopButton {
            background: var(--vscode-errorForeground);
            color: white;
            display: none;
        }
        #stopButton:hover {
            background: var(--vscode-errorForeground);
            opacity: 0.9;
        }
        
        #chatMessages {
            height: calc(100vh - 80px); /* Adjusted for header */
            overflow-y: auto;
            padding: 20px;
            padding-bottom: 100px; /* Space for input */
            box-sizing: border-box;
            scroll-behavior: smooth;
        }
        
        /* Animated spinner for waiting status */
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .spinner {
            display: inline-block;
            animation: spin 1s linear infinite;
        }
        
        /* Status icons for agent mode */
        .status-icon {
            width: 16px;
            height: 16px;
            display: inline-block;
            vertical-align: middle;
            margin-right: 4px;
        }
        .status-icon-done {
            background-image: url('${doneIconUri}');
            background-size: 14px 14px;
            background-repeat: no-repeat;
            background-position: center;
        }
        .status-icon-loading {
            background-image: url('${loadingIconUri}');
            background-size: 12px 12px;
            background-repeat: no-repeat;
            background-position: center;
            animation: spin 1s linear infinite;
        }
        .status-icon-stopped {
            background-image: url('${stoppedIconUri}');
            background-size: 16px 16px;
            background-repeat: no-repeat;
            background-position: center;
        }
        .loading {
            display: none;
            margin: 10px 0;
            font-style: italic;
            color: var(--vscode-descriptionForeground);
            position: fixed;
            bottom: 85px;
            left: 30px;
            background: var(--vscode-editor-background);
            padding: 6px 12px;
            border-radius: 20px;
            z-index: 999;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            border: 1px solid var(--vscode-widget-border);
            animation: fadeIn 0.2s;
        }
        
        .code-block-container {
            margin: 16px 0;
            background: var(--vscode-textCodeBlock-background);
            border-radius: var(--radius-md);
            overflow: hidden;
            border: 1px solid var(--vscode-widget-border);
        }
        .code-block-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 16px;
            background: rgba(0,0,0,0.05); /* Subtle contrast */
            border-bottom: 1px solid var(--vscode-widget-border);
        }
        .language-label {
            color: var(--vscode-descriptionForeground);
            font-size: 0.85em;
            text-transform: uppercase;
            font-weight: 600;
            letter-spacing: 0.5px;
        }
        .copy-button {
            background: transparent;
            color: var(--vscode-descriptionForeground);
            border: 1px solid transparent;
            padding: 4px 10px;
            border-radius: var(--radius-sm);
            cursor: pointer;
            font-size: 0.85em;
            transition: all 0.2s;
        }
        .copy-button:hover {
            background: var(--vscode-toolbar-hoverBackground);
            color: var(--vscode-foreground);
        }
        .code-content {
            padding: 16px;
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
            margin: 20px 0 12px 0;
            color: var(--vscode-foreground);
            line-height: 1.3;
            font-weight: 600;
        }
        .text-content h1 {
            font-size: 1.6em;
            border-bottom: 1px solid var(--vscode-widget-border);
            padding-bottom: 8px;
        }
        .text-content h2 {
            font-size: 1.4em;
        }
        .text-content h3 {
            font-size: 1.2em;
        }
        .text-content strong {
            font-weight: 600;
            color: var(--vscode-foreground);
        }
        .text-content code {
            background: var(--vscode-textCodeBlock-background);
            color: var(--vscode-textPreformat-foreground);
            padding: 2px 6px;
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.9em;
            border: 1px solid var(--vscode-widget-border);
        }
        .text-content ul, .text-content ol {
            margin: 12px 0;
            padding-left: 24px;
        }
        .text-content li {
            margin: 6px 0;
            line-height: 1.6;
        }
        
        .bulk-actions {
            display: none;
            position: fixed;
            bottom: 90px;
            left: 20px;
            right: 20px;
            margin: 0;
            padding: 20px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: var(--radius-lg);
            text-align: center;
            z-index: 1001; /* Above loading indicator */
            box-shadow: 0 8px 24px rgba(0,0,0,0.2);
            transform: translateY(20px);
            transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease;
            opacity: 0;
        }
        .bulk-actions.show {
            display: block;
            transform: translateY(0);
            opacity: 1;
        }
        .bulk-actions h4 {
            margin: 0 0 16px 0;
            color: var(--vscode-foreground);
            font-size: 15px;
            font-weight: 600;
        }
        .bulk-actions-buttons {
            display: flex;
            gap: 12px;
            justify-content: center;
        }
        .bulk-action-button {
            padding: 10px 20px;
            border: none;
            border-radius: var(--radius-md);
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: transform 0.1s;
        }
        .bulk-action-button:hover {
            transform: translateY(-1px);
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
            opacity: 0.9;
        }
        
        .terminal-command-confirmation {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: var(--radius-lg);
            margin: 16px 0;
            padding: 20px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            animation: slideUp 0.3s ease-out;
        }
        .terminal-command-confirmation h4 {
            margin: 0 0 12px 0;
            color: var(--vscode-foreground);
            font-size: 15px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .terminal-command {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: var(--radius-md);
            padding: 12px;
            margin: 12px 0;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            color: var(--vscode-editor-foreground);
            white-space: pre-wrap;
            word-break: break-all;
        }
        .terminal-command-buttons {
            display: flex;
            gap: 12px;
            justify-content: flex-end;
            margin-top: 20px;
        }
        .terminal-command-button {
            padding: 8px 16px;
            border: none;
            border-radius: var(--radius-sm);
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: opacity 0.2s;
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
            opacity: 0.9;
        }
        
        /* Thread History View */
        .thread-history-view {
            display: none;
            height: 100vh;
            overflow-y: auto;
            padding: 24px;
            box-sizing: border-box;
            animation: fadeIn 0.3s ease;
        }
        .thread-history-view.active {
            display: block;
        }
        .thread-history-header {
            margin-bottom: 24px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .thread-history-header h2 {
            margin: 0;
            color: var(--vscode-foreground);
            font-size: 20px;
            font-weight: 600;
        }
        .thread-history-actions {
            display: flex;
            gap: 12px;
            margin-bottom: 24px;
        }
        .new-thread-button {
            padding: 10px 20px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: var(--radius-xl);
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            width: 100%;
            transition: background-color 0.2s, transform 0.1s;
        }
        .new-thread-button:hover {
            background: var(--vscode-button-hoverBackground);
            transform: translateY(-1px);
        }
        .thread-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .thread-item {
            padding: 16px;
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: var(--radius-md);
            cursor: pointer;
            transition: all 0.2s ease;
            position: relative;
            overflow: hidden;
        }
        .thread-item:hover {
            background: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-focusBorder);
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
        .thread-item-title {
            font-size: 15px;
            font-weight: 600;
            margin-bottom: 8px;
            color: var(--vscode-foreground);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            padding-right: 24px; /* Space for delete button */
        }
        .thread-item-meta {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            display: flex;
            gap: 16px;
            align-items: center;
        }
        .thread-item-delete {
            position: absolute;
            top: 12px;
            right: 12px;
            background: transparent;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            font-size: 18px;
            opacity: 0;
            transition: all 0.2s;
            width: 28px;
            height: 28px;
            border-radius: var(--radius-sm);
            display: flex;
            align-items: center;
            justify-content: center;
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
            padding: 60px 20px;
            color: var(--vscode-descriptionForeground);
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 16px;
        }
        .empty-threads-icon {
            font-size: 48px;
            opacity: 0.5;
        }
        
        /* Loading dots animation */
        .loading-dots::after {
            content: '';
            display: inline-block;
            width: 1.2em;
            text-align: left;
            animation: dots 2s steps(1, end) infinite;
        }
        @keyframes dots {
            0%, 25% { content: ''; }
            25%, 50% { content: '.'; }
            50%, 75% { content: '..'; }
            75%, 100% { content: '...'; }
        }
        
        /* Chat View */
        .chat-view {
            display: none;
            height: 100vh;
            flex-direction: column;
            animation: fadeIn 0.3s ease;
        }
        .chat-view.active {
            display: flex;
        }
        .chat-header {
            display: flex;
            align-items: center;
            gap: 16px;
            padding: 12px 20px;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-widget-border);
            z-index: 10;
        }
        .back-button {
            padding: 8px 12px;
            background: transparent;
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-widget-border);
            border-radius: var(--radius-sm);
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.2s;
        }
        .back-button:hover {
            background: var(--vscode-toolbar-hoverBackground);
            border-color: var(--vscode-focusBorder);
        }
        .chat-header-title {
            flex: 1;
            font-size: 16px;
            font-weight: 600;
            color: var(--vscode-foreground);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .chat-header-actions {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        /* Icon styles - Use CSS mask to allow SVG to inherit text color */
        .back-button img, .clear-button img, .mode-button img {
            width: 16px;
            height: 16px;
            display: block;
        }
        
        /* Icon container for CSS mask technique */
        .icon {
            width: 16px;
            height: 16px;
            display: inline-block;
            background-color: currentColor;
            -webkit-mask-size: contain;
            mask-size: contain;
            -webkit-mask-repeat: no-repeat;
            mask-repeat: no-repeat;
            -webkit-mask-position: center;
            mask-position: center;
        }
        
        .icon-back {
            width: 12px;
            height: 12px;
            -webkit-mask-image: url('${backIconUri}');
            mask-image: url('${backIconUri}');
        }
        
        .icon-ask {
            -webkit-mask-image: url('${askIconUri}');
            mask-image: url('${askIconUri}');
        }
        
        .icon-agent {
            -webkit-mask-image: url('${agentIconUri}');
            mask-image: url('${agentIconUri}');
        }
        
        .icon-delete {
            -webkit-mask-image: url('${deleteIconUri}');
            mask-image: url('${deleteIconUri}');
        }
        
        .back-button, .clear-button {
            padding: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
        }
        
        .mode-button {
            display: flex;
            align-items: center;
            gap: 6px;
        }
    </style>

</head>
<body>

    <div id="globalLoading" class="global-loading active">
        <div>Loading...</div>
    </div>

    <div id="loginView" class="login-view">
        <div id="loginContainer" class="auth-container">
            <h2>Login</h2>
            <div id="loginError" class="auth-error"></div>
            <form id="loginForm">
                <div class="auth-form-group">
                    <label for="loginEmail">Email</label>
                    <input type="email" id="loginEmail" class="auth-input" required>
                </div>
                <div class="auth-form-group">
                    <label for="loginPassword">Password</label>
                    <input type="password" id="loginPassword" class="auth-input" required>
                </div>
                <button type="submit" id="loginButton" class="auth-button">Login</button>
            </form>
            <div class="auth-switch-link">
                Don't have an account? <a id="showRegisterLink">Register</a>
            </div>
        </div>
        
        <div id="registerContainer" class="auth-container" style="display: none;">
            <h2>Register</h2>
            <div id="registerError" class="auth-error"></div>
            <form id="registerForm">
                <div class="auth-form-group">
                    <label for="registerEmail">Email</label>
                    <input type="email" id="registerEmail" class="auth-input" required>
                </div>
                <div class="auth-form-group">
                    <label for="registerPassword">Password</label>
                    <input type="password" id="registerPassword" class="auth-input" required>
                </div>
                <button type="submit" id="registerButton" class="auth-button">Register</button>
            </form>
            <div class="auth-switch-link">
                Already have an account? <a id="showLoginLink">Login</a>
            </div>
        </div>
    </div>

    <div id="threadHistoryView" class="thread-history-view">
        <div class="thread-history-header">
            <h2>Conversation History</h2>
        </div>
        <div class="thread-history-actions">
            <button id="newThreadButton" class="new-thread-button">+ New Conversation</button>
            <button id="logoutButtonHistory" class="logout-button">Logout</button>
        </div>
        <div id="threadList" class="thread-list">
            <div class="empty-threads">
                <div class="empty-threads-icon">💬</div>
                <p><span class="loading-dots">Loading conversations</span></p>
            </div>
        </div>
    </div>

    <div id="chatView" class="chat-view">
        <div class="chat-header">
            <button id="backButton" class="back-button" title="Back">
                <span class="icon icon-back"></span>
                <span>Back</span>
            </button>
            <div class="chat-header-title" id="chatHeaderTitle">Conversation</div>
            <div class="mode-selector">
                <div class="mode-buttons">
                    <div class="active-indicator"></div>
                    <button id="askButton" class="mode-button active" title="Ask Mode">
                        <span class="icon icon-ask"></span>
                        <span>Ask</span>
                    </button>
                    <button id="agentButton" class="mode-button" title="Agent Mode">
                        <span class="icon icon-agent"></span>
                        <span>Agent</span>
                    </button>
                </div>
            </div>
            <div class="chat-header-actions">
                <button id="clearButton" class="clear-button" title="Clear this conversation">
                    <span class="icon icon-delete"></span>
                    <span>Clear</span>
                </button>
                <button id="logoutButtonChat" class="logout-button">Logout</button>
            </div>
        </div>
        <div id="chatMessages"></div>
        <div id="bulkActions" class="bulk-actions">
        <h4>Agent Task Completed - Review Changes</h4>
        <div class="bulk-actions-buttons">
            <button id="acceptAllButton" class="bulk-action-button accept-all-button">✓ Accept All Changes</button>
            <button id="rejectAllButton" class="bulk-action-button reject-all-button">✗ Reject All Changes</button>
        </div>
    </div>
    <div id="loading" class="loading"><span class="loading-dots">Thinking</span></div>
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
        
        // --- Auth Elements ---
        const globalLoading = document.getElementById('globalLoading');
        const loginView = document.getElementById('loginView');
        const loginContainer = document.getElementById('loginContainer');
        const registerContainer = document.getElementById('registerContainer');
        const loginForm = document.getElementById('loginForm');
        const registerForm = document.getElementById('registerForm');
        const loginEmail = document.getElementById('loginEmail');
        const loginPassword = document.getElementById('loginPassword');
        const registerEmail = document.getElementById('registerEmail');
        const registerPassword = document.getElementById('registerPassword');
        const showRegisterLink = document.getElementById('showRegisterLink');
        const showLoginLink = document.getElementById('showLoginLink');
        const loginError = document.getElementById('loginError');
        const registerError = document.getElementById('registerError');

        // --- Chat Elements ---
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
        const logoutButtonHistory = document.getElementById('logoutButtonHistory');
        const logoutButtonChat = document.getElementById('logoutButtonChat');
        const activeIndicator = document.querySelector('.active-indicator');
        
        let currentMode = 'ask';
        let isProcessing = false;
        let currentThreadId = null;
        let threads = [];

        // --- Auth View Management ---
        function showLoginView() {
            globalLoading.classList.remove('active');
            loginView.classList.add('active');
            threadHistoryView.classList.remove('active');
            chatView.classList.remove('active');
            loginContainer.style.display = 'block';
            registerContainer.style.display = 'none';
            loginError.style.display = 'none';
            registerError.style.display = 'none';
        }

        function showRegisterView() {
            globalLoading.classList.remove('active');
            loginView.classList.add('active');
            threadHistoryView.classList.remove('active');
            chatView.classList.remove('active');
            loginContainer.style.display = 'none';
            registerContainer.style.display = 'block';
            loginError.style.display = 'none';
            registerError.style.display = 'none';
        }
        
        function showAuthError(view, message) {
            const errorEl = view === 'login' ? loginError : registerError;
            errorEl.textContent = message;
            errorEl.style.display = 'block';
        }

        // --- Chat View Management ---
        function showThreadHistory() {
            globalLoading.classList.remove('active');
            loginView.classList.remove('active');
            threadHistoryView.classList.add('active');
            chatView.classList.remove('active');
            // When showing, reset to "Loading" in case we are coming from 'Back'
            threadList.innerHTML = \`
                <div class="empty-threads">
                    <div class="empty-threads-icon">💬</div>
                    <p><span class="loading-dots">Loading conversations</span></p>
                </div>
            \`;
        }

        function showChat() {
            globalLoading.classList.remove('active');
            loginView.classList.remove('active');
            threadHistoryView.classList.remove('active');
            chatView.classList.add('active');
            
            // Initialize indicator position when chat view becomes visible
            const activeBtn = currentMode === 'ask' ? askButton : agentButton;
            // Use setTimeout to ensure layout is computed
            setTimeout(() => updateActiveIndicator(activeBtn), 0);
        }
        
        function updateActiveIndicator(targetButton) {
            if (!targetButton || !activeIndicator) return;

            const targetLeft = targetButton.offsetLeft;
            const targetWidth = targetButton.offsetWidth;
            const currentLeft = activeIndicator.offsetLeft;
            const currentWidth = activeIndicator.offsetWidth;

            // If it's the first run (no width/hidden), just set it without animation
            if (currentWidth === 0 || activeIndicator.style.width === '') {
                activeIndicator.style.left = \`\${targetLeft}px\`;
                activeIndicator.style.width = \`\${targetWidth}px\`;
                return;
            }

            // Animate
            const keyframes = [
                { left: \`\${currentLeft}px\`, width: \`\${currentWidth}px\`, transform: 'scale(1)' },
                { left: \`\${(currentLeft + targetLeft) / 2}px\`, width: \`\${(currentWidth + targetWidth) / 2}px\`, transform: 'scale(0.9)' },
                { left: \`\${targetLeft}px\`, width: \`\${targetWidth}px\`, transform: 'scale(1)' }
            ];

            const options = {
                duration: 300,
                easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
                fill: 'forwards'
            };

            const animation = activeIndicator.animate(keyframes, options);
            animation.onfinish = () => {
                activeIndicator.style.left = \`\${targetLeft}px\`;
                activeIndicator.style.width = \`\${targetWidth}px\`;
                activeIndicator.style.transform = '';
            };
        }

        // Thread List Management
        function renderThreadList(threadData, currentThread) {
            threads = threadData || [];
            currentThreadId = currentThread;
            
            // --- FIX FOR PROBLEM #2 ---
            // Only clear the list AFTER we know if it's empty or not.
            // This prevents the "empty" flash.
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

            // Now that we know we have threads, clear the "Loading..."
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
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    vscode.postMessage({ 
                        type: 'deleteThread', 
                        threadId: thread.id,
                        threadTitle: thread.title || 'Conversation'
                    });
                });
                
                threadItem.appendChild(title);
                threadItem.appendChild(meta);
                threadItem.appendChild(deleteBtn);
                
                threadItem.onclick = () => {
                    vscode.postMessage({ 
                        type: 'switchThread', 
                        threadId: thread.id 
                    });
                    chatHeaderTitle.textContent = thread.title || 'Conversation';
                    // showChat(); // Let 'loadHistory' message trigger this
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

        // --- Event Listeners ---
        
        // Auth Listeners
        showRegisterLink.addEventListener('click', (e) => {
            e.preventDefault();
            showRegisterView();
        });

        showLoginLink.addEventListener('click', (e) => {
            e.preventDefault();
            showLoginView();
        });

        loginForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const email = loginEmail.value;
            const password = loginPassword.value;
            loginError.style.display = 'none';
            vscode.postMessage({ type: 'login', email, password });
        });

        registerForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const email = registerEmail.value;
            const password = registerPassword.value;
            registerError.style.display = 'none';
            vscode.postMessage({ type: 'register', email, password });
        });
        
        logoutButtonHistory.addEventListener('click', () => {
             vscode.postMessage({ type: 'logout' });
        });
        logoutButtonChat.addEventListener('click', () => {
             vscode.postMessage({ type: 'logout' });
        });


        // Button Event Listeners
        backButton.addEventListener('click', () => {
            showThreadHistory();
            // When going back, we MUST request a fresh list
            vscode.postMessage({ type: 'loadThreadList' });
        });

        newThreadButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'newThread' });
            chatHeaderTitle.textContent = 'New Conversation';
            // Let the extension send 'loadHistory' to trigger showChat()
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

        // ... (createCodeBlock, processMarkdown, processInlineMarkdown, showTerminalCommandConfirmation remain the same) ...
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
                // Replace status emojis with SVG icons
                .replace(/✅/g, '<span class="status-icon status-icon-done"></span>')
                .replace(/⏳/g, '<span class="status-icon status-icon-loading"></span>')
                .replace(/❌/g, '<span class="status-icon status-icon-stopped"></span>')
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
                // Reset height
                messageInput.style.height = 'auto';
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
            messageInput.style.overflowY = 'hidden'; // Hide scrollbar while calculating height
            const newHeight = Math.min(messageInput.scrollHeight, 150); // Max height 150px
            // Only expand if content exceeds min-height (40px)
            if (newHeight > 40) {
                messageInput.style.height = newHeight + 'px';
            } else {
                messageInput.style.height = '40px';
            }
            // Show scrollbar only when content exceeds max height
            messageInput.style.overflowY = newHeight >= 150 ? 'auto' : 'hidden';
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
                // --- Auth Messages ---
                case 'showLogin':
                    showLoginView();

                    // --- FIX: Clear all internal state to prevent stale data ---
                    threads = [];
                    currentThreadId = null;
                    if (chatMessages) chatMessages.innerHTML = '';
                    if (threadList) {
                         threadList.innerHTML = \`
                            <div class="empty-threads">
                                <div class="empty-threads-icon">💬</div>
                                <p><span class="loading-dots">Loading conversations</span></p>
                            </div>
                         \`;
                    }
                    // --- End of fix ---
                    break;
                case 'loginSuccess':
                    // We are logged in. The extension will now send
                    // either 'showThreadHistory' or 'loadHistory'.
                    // We do nothing here except note that we are logged in.
                    break;
                case 'authError':
                    // Show error in the correct form
                    if (loginContainer.style.display === 'block') {
                        showAuthError('login', message.message);
                    } else {
                        showAuthError('register', message.message);
                    }
                    break;
                case 'registrationSuccess':
                    // Show message and switch to login view
                    registerError.style.display = 'none';
                    loginError.textContent = 'Registration successful! Please log in.';
                    loginError.style.display = 'block';
                    showLoginView();
                    break;

                // --- Chat Messages ---
                case 'showThreadHistory':
                    showThreadHistory();
                    // The extension MUST follow this with a 'threadList' message.
                    // The view will show "Loading conversations..." until it arrives.
                    break;
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
                        updateActiveIndicator(askButton);
                        bulkActions.classList.remove('show');
                        bulkActions.style.display = 'none';
                    } else {
                        agentButton.classList.add('active');
                        askButton.classList.remove('active');
                        updateActiveIndicator(agentButton);
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
                case 'dismissTerminalCommandConfirmation':
                    // Remove any existing terminal command confirmation popup
                    const confirmationPopup = document.querySelector('.terminal-command-confirmation');
                    if (confirmationPopup) {
                        confirmationPopup.remove();
                    }
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
                case 'setLastAssistantMessageId':
                    // Set the data-id on the last assistant message so it can be deleted later
                    const lastAssistantMsg = chatMessages.querySelector('.message.assistant:last-of-type');
                    if (lastAssistantMsg && message.id) {
                        lastAssistantMsg.dataset.id = message.id;
                    }
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
        updateButtonStates();
        
        // Request current processing state from extension
        // This will now trigger the auth check and the extension
        // will decide which view to show.
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