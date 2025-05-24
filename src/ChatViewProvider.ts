// src/ChatViewProvider.ts
import * as vscode from 'vscode';
import { similaritySearch } from './service/FileIndexer';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    // private _view?: vscode.WebviewView;

    // constructor(
    //     private readonly _extensionUri: vscode.Uri,
    //     private readonly _serverUrl: string
    // ) {}

    // public resolveWebviewView(
    //     webviewView: vscode.WebviewView,
    //     context: vscode.WebviewViewResolveContext,
    //     _token: vscode.CancellationToken,
    // ) {
    //     this._view = webviewView;

    //     webviewView.webview.options = {
    //         enableScripts: true,
    //         localResourceRoots: [this._extensionUri]
    //     };

    //     webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    //     // Handle messages from the webview
    //     webviewView.webview.onDidReceiveMessage(async (data) => {
    //         switch (data.type) {
    //             case 'sendMessage':
    //                 try {
    //                     // Get selected code if any
    //                     const editor = vscode.window.activeTextEditor;
    //                     const selectedCode = editor?.document.getText(editor.selection) || '';
    //                     const fileLanguage = editor?.document.languageId || '';

    //                     // Prepare the query with context
    //                     const query = `${data.message}\n\nContext:\nLanguage: ${fileLanguage}\nSelected code:\n${selectedCode}`;

    //                     // Send progress message
    //                     this._view?.webview.postMessage({
    //                         type: 'addMessage',
    //                         message: data.message,
    //                         sender: 'user'
    //                     });

    //                     // Send request to server using native fetch
    //                     const response = await fetch(this._serverUrl, {
    //                         method: 'POST',
    //                         headers: {
    //                             'Content-Type': 'application/json',
    //                         },
    //                         body: JSON.stringify({ query: query })
    //                     });

    //                     const jsonResponse: any = await response.json();

    //                     if (jsonResponse.success) {
    //                         // Send response back to webview
    //                         this._view?.webview.postMessage({
    //                             type: 'addMessage',
    //                             message: jsonResponse.result,
    //                             sender: 'assistant'
    //                         });
    //                     } else {
    //                         throw new Error('Server request failed');
    //                     }
    //                 } catch (error) {
    //                     vscode.window.showErrorMessage(`Error: ${error}`);
    //                     // Show error in chat
    //                     this._view?.webview.postMessage({
    //                         type: 'addMessage',
    //                         message: 'Sorry, there was an error processing your request.',
    //                         sender: 'assistant'
    //                     });
    //                 }
    //                 break;
    //         }
    //     });
    // }

    private _view?: vscode.WebviewView;
    private readonly _queryUrl: string;
    private readonly _embedUrl: string;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        baseUrl: string
    ) {
        this._queryUrl = `${baseUrl}/query`;
        this._embedUrl = `${baseUrl}/embed`;
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

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'sendMessage':
                    try {
                        const editor = vscode.window.activeTextEditor;
                        const selectedCode = editor?.document.getText(editor.selection) || '';
                        const fileLanguage = editor?.document.languageId || '';
                        
                        // Get code context around cursor
                        const codeContext = this.getCodeContext(editor);
                        
                        // Embed the code context
                        await this.embedCodeContext(codeContext, fileLanguage);

                        // Prepare the query with context
                        const query = `${data.message}\n\nContext:\nLanguage: ${fileLanguage}\nSelected code:\n${selectedCode}`;

                        const similarity =  await similaritySearch(data.message);

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
                            body: JSON.stringify({ query: query })
                        });

                        const jsonResponse: any = await response.json();

                        if (jsonResponse.success) {
                            // Send response back to webview
                            this._view?.webview.postMessage({
                                type: 'addMessage',
                                message: jsonResponse.result,
                                sender: 'assistant'
                            });
                        } else {
                            throw new Error('Server request failed');
                        }
                    } catch (error) {
                        vscode.window.showErrorMessage(`Error: ${error}`);
                        this._view?.webview.postMessage({
                            type: 'addMessage',
                            message: 'Sorry, there was an error processing your request.',
                            sender: 'assistant'
                        });
                    }
                    break;
            }
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
        #sendButton {
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            white-space: nowrap;
        }
        #sendButton:hover {
            background: var(--vscode-button-hoverBackground);
        }
        #chatMessages {
            height: calc(100vh - 100px);
            overflow-y: auto;
            padding: 10px;
            margin-bottom: 80px;
        }
        .loading {
            display: none;
            margin: 10px 0;
            font-style: italic;
            color: var(--vscode-descriptionForeground);
            position: fixed;
            bottom: 70px;
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
    </style>
</head>
<body>
    <div id="chatMessages"></div>
    <div id="loading" class="loading">Thinking...</div>
    <div class="input-container">
        <textarea 
            id="messageInput" 
            placeholder="Type your message..." 
            rows="1"
        ></textarea>
        <button id="sendButton">Send</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');
        const chatMessages = document.getElementById('chatMessages');
        const loading = document.getElementById('loading');

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
            if (message) {
                loading.style.display = 'block';
                vscode.postMessage({
                    type: 'sendMessage',
                    message: message
                });
                messageInput.value = '';
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

        // Handle button click
        sendButton.addEventListener('click', sendMessage);

        // Process incoming messages
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
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
            }
        });

        // Initial focus
        messageInput.focus();
    </script>
</body>
</html>
    `;
    }
}