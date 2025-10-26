// src/ChatViewProvider.ts
import * as vscode from 'vscode';
import { AuthManager } from './service/AuthService';

/**
 * This is a *simplified* ChatViewProvider for SWE-bench mode.
 * Its only job is to display agent feedback from the running benchmark.
 * It does not handle user messages, "ask" mode, or thread management.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
    private static _instance: ChatViewProvider;
    private _view?: vscode.WebviewView;
    private authManager: AuthManager;
    private agentMessages: string[] = []; // Store messages

    // Make this a singleton
    public static getInstance(
        context?: vscode.ExtensionContext,
        authManager?: AuthManager
    ): ChatViewProvider {
        if (!ChatViewProvider._instance) {
            if (!context || !authManager) {
                throw new Error('ChatViewProvider must be initialized with context and authManager');
            }
            ChatViewProvider._instance = new ChatViewProvider(context.extensionUri, context, authManager);
        }
        return ChatViewProvider._instance;
    }

    private constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext,
        authManager: AuthManager
    ) {
        this.authManager = authManager;
    }

    /**
     * Public method for the extension to log agent updates.
     */
    public logAgentUpdate(message: string) {
        this.agentMessages.push(message);
        this._view?.webview.postMessage({
            type: 'addMessage',
            message: message,
            sender: 'assistant'
        });
    }

    /**
     * Clears all messages from the view.
     */
    public clearMessages() {
        this.agentMessages = [];
        this._view?.webview.postMessage({
            type: 'clearMessages'
        });
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

        webviewView.webview.onDidReceiveMessage(async (data) => {
            if (data.type === 'requestState') {
                const token = await this.authManager.getToken();
                if (!token) {
                    this._view?.webview.postMessage({ type: 'showLogin' });
                } else {
                    const userId = this.authManager.getUserIdFromToken(token);
                    this._view?.webview.postMessage({ type: 'loginSuccess', userId: userId });
                    // Load existing messages
                    this._view?.webview.postMessage({ type: 'loadHistory', history: this.agentMessages });
                }
            }

            if (data.type === 'openSetToken') {
                vscode.commands.executeCommand('aiCodeAssist.setToken');
            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // A simplified HTML for feedback display only
        return `
        <!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { 
            font-family: var(--vscode-font-family); 
            padding: 0; 
            margin: 0;
            overflow: hidden;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        
        /* --- Login View --- */
        .login-view {
            display: none;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            padding: 20px;
            box-sizing: border-box;
            text-align: center;
        }
        .login-view.active {
            display: flex;
        }
        .auth-button {
            padding: 10px 15px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            margin-top: 15px;
        }
        .auth-button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        /* --- Chat View --- */
        .chat-view {
            display: none;
            flex-direction: column;
            height: 100vh;
        }
        .chat-view.active {
            display: flex;
        }
        
        .chat-header {
            padding: 10px;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-input-border);
            text-align: center;
            font-weight: bold;
        }
        
        #chatMessages {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
            box-sizing: border-box;
        }
        
        .message { 
            margin: 10px 0; 
            padding: 8px; 
            border-radius: 4px; 
            white-space: pre-wrap;
            background: var(--vscode-editor-background);
            margin-right: 20px;
        }
    </style>
</head>
<body>

    <div id="loginView" class="login-view">
        <h2>AI Code Assist</h2>
        <p>Please set your Auth Token using the Command Palette to continue.</p>
        <button id="setTokenButton" class="auth-button">Open "Set Token" Command</button>
        <p style="font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 20px;">
            Run "AI Code Assist: Set Auth Token" from the Command Palette (Ctrl+Shift+P).
        </p>
    </div>

    <div id="chatView" class="chat-view">
        <div class="chat-header">
            SWE-bench Agent Feedback
        </div>
        <div id="chatMessages"></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        const loginView = document.getElementById('loginView');
        const chatView = document.getElementById('chatView');
        const setTokenButton = document.getElementById('setTokenButton');
        const chatMessages = document.getElementById('chatMessages');
        
        setTokenButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'openSetToken' });
        });
        
        function showLoginView() {
            loginView.classList.add('active');
            chatView.classList.remove('active');
        }

        function showChatView() {
            loginView.classList.remove('active');
            chatView.classList.add('active');
        }

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'showLogin':
                    showLoginView();
                    break;
                case 'loginSuccess':
                    showChatView();
                    break;
                case 'addMessage':
                    const messageDiv = document.createElement('div');
                    messageDiv.className = 'message ' + message.sender;
                    messageDiv.textContent = message.message;
                    chatMessages.appendChild(messageDiv);
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                    break;
                case 'clearMessages':
                    chatMessages.innerHTML = '';
                    break;
                case 'loadHistory':
                    chatMessages.innerHTML = '';
                    for (const msg of message.history) {
                        const histDiv = document.createElement('div');
                        histDiv.className = 'message assistant';
                        histDiv.textContent = msg;
                        chatMessages.appendChild(histDiv);
                    }
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                    break;
            }
        });
        
        // Request current state
        vscode.postMessage({ type: 'requestState' });
    </script>
</body>
</html>`;
    }
}