// // src/CompletionProvider.ts
// import * as vscode from 'vscode';

// export class AICompletionProvider implements vscode.InlineCompletionItemProvider {
//     private lastRequestTime: number = 0;
//     private debounceTimeout: NodeJS.Timeout | null = null;
//     private lastContext: string = '';
//     private readonly THROTTLE_MS = 1000; // Minimum time between requests
//     private readonly DEBOUNCE_MS = 500;  // Wait time after last keystroke

//     constructor(private readonly serverUrl: string) {}

//     private getCodeContext(document: vscode.TextDocument, position: vscode.Position): string {
//         // Get 5 lines before
//         const startLine = Math.max(0, position.line - 5);
//         const beforeText = document.getText(new vscode.Range(
//             new vscode.Position(startLine, 0),
//             position
//         ));

//         // Get 5 lines after
//         const endLine = Math.min(document.lineCount - 1, position.line + 5);
//         const afterText = document.getText(new vscode.Range(
//             position,
//             new vscode.Position(endLine, document.lineAt(endLine).text.length)
//         ));

//         return beforeText + afterText;
//     }

//     private shouldSkipRequest(context: string): boolean {
//         const now = Date.now();
        
//         // Skip if the context hasn't changed
//         if (context === this.lastContext) {
//             return true;
//         }

//         // Skip if we're within the throttle window
//         if (now - this.lastRequestTime < this.THROTTLE_MS) {
//             return true;
//         }

//         return false;
//     }

//     private async embedContext(context: string, language: string) {
//         // Skip if we should throttle or context hasn't changed
//         if (this.shouldSkipRequest(context)) {
//             return;
//         }

//         try {
//             this.lastContext = context;
//             this.lastRequestTime = Date.now();
            
//             await fetch(`${this.serverUrl}/embed`, {
//                 method: 'POST',
//                 headers: { 'Content-Type': 'application/json' },
//                 body: JSON.stringify({ 
//                     text: context,
//                     language: language 
//                 })
//             });
//         } catch (error) {
//             console.error('Failed to embed context:', error);
//         }
//     }

//     private debounce(fn: () => Promise<vscode.InlineCompletionItem[]>): Promise<vscode.InlineCompletionItem[]> {
//         return new Promise((resolve) => {
//             if (this.debounceTimeout) {
//                 clearTimeout(this.debounceTimeout);
//             }

//             this.debounceTimeout = setTimeout(async () => {
//                 const result = await fn();
//                 resolve(result);
//             }, this.DEBOUNCE_MS);
//         });
//     }

//     async provideInlineCompletionItems(
//         document: vscode.TextDocument,
//         position: vscode.Position,
//         context: vscode.InlineCompletionContext
//     ): Promise<vscode.InlineCompletionItem[]> {
//         // Return empty if triggered by explicit request (e.g., keyboard shortcut)
//         if (context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke) {
//             return [];
//         }

//         return this.debounce(async () => {
//             const codeContext = this.getCodeContext(document, position);
//             const language = document.languageId;

//             // Skip if we should throttle
//             if (this.shouldSkipRequest(codeContext)) {
//                 return [];
//             }

//             // Embed the context
//             await this.embedContext(codeContext, language);

//             try {
//                 // Get the current line up to the cursor
//                 const linePrefix = document.lineAt(position).text.substring(0, position.character);
                
//                 // Update request timestamp
//                 this.lastRequestTime = Date.now();

//                 // Get suggestions from the server
//                 const response = await fetch(`${this.serverUrl}/query`, {
//                     method: 'POST',
//                     headers: { 'Content-Type': 'application/json' },
//                     body: JSON.stringify({ 
//                         query: "Complete this code: " + linePrefix,
//                         context: codeContext,
//                         language: language
//                     })
//                 });

//                 const result: any = await response.json();
//                 if (result.success && result.result) {
//                     // Clean the suggestion
//                     //const suggestion = result.result.replace(/```[\s\S]*?```/g, '').trim();
//                     const suggestion = result;
//                     return [
//                         new vscode.InlineCompletionItem(
//                             suggestion,
//                             new vscode.Range(position, position)
//                         )
//                     ];
//                 }
//             } catch (error) {
//                 console.error('Error getting completion:', error);
//             }

//             return [];
//         });
//     }
// }

// import * as vscode from 'vscode';

// export class AICompletionProvider implements vscode.InlineCompletionItemProvider {
//     private lastRequestTime: number = 0;
//     private debounceTimeout: NodeJS.Timeout | null = null;
//     private lastContext: string = '';
//     private readonly THROTTLE_MS = 1000; // Minimum time between requests
//     private readonly DEBOUNCE_MS = 500;  // Wait time after last keystroke

//     constructor(private readonly serverUrl: string) {}

//     private getCodeContext(document: vscode.TextDocument, position: vscode.Position): string {
//         // Get 5 lines before
//         const startLine = Math.max(0, position.line - 5);
//         const beforeText = document.getText(new vscode.Range(
//             new vscode.Position(startLine, 0),
//             position
//         ));

//         // Get 5 lines after
//         const endLine = Math.min(document.lineCount - 1, position.line + 5);
//         const afterText = document.getText(new vscode.Range(
//             position,
//             new vscode.Position(endLine, document.lineAt(endLine).text.length)
//         ));

//         return beforeText + afterText;
//     }

//     private shouldSkipRequest(context: string): boolean {
//         const now = Date.now();
        
//         // Skip if the context hasn't changed
//         if (context === this.lastContext) {
//             return true;
//         }

//         // Skip if we're within the throttle window
//         if (now - this.lastRequestTime < this.THROTTLE_MS) {
//             return true;
//         }

//         return false;
//     }

//     private async embedContext(context: string, language: string) {
//         // Skip if we should throttle or context hasn't changed
//         if (this.shouldSkipRequest(context)) {
//             return;
//         }

//         try {
//             this.lastContext = context;
//             this.lastRequestTime = Date.now();
            
//             await fetch(`${this.serverUrl}/embed`, {
//                 method: 'POST',
//                 headers: { 'Content-Type': 'application/json' },
//                 body: JSON.stringify({ 
//                     text: context,
//                     language: language 
//                 })
//             });
//         } catch (error) {
//             console.error('Failed to embed context:', error);
//         }
//     }

//     async provideInlineCompletionItems(
//         document: vscode.TextDocument,
//         position: vscode.Position,
//         context: vscode.InlineCompletionContext
//     ): Promise<vscode.InlineCompletionItem[]> {
//         // Return empty if triggered by explicit request (e.g., keyboard shortcut)
//         if (context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke) {
//             return [];
//         }

//         const codeContext = this.getCodeContext(document, position);
//         const language = document.languageId;

//         // Skip if we should throttle
//         if (this.shouldSkipRequest(codeContext)) {
//             return [];
//         }

//         try {
//             // Get the current line up to the cursor
//             const linePrefix = document.lineAt(position).text.substring(0, position.character);
            
//             // Embed the context first
//             await this.embedContext(codeContext, language);
            
//             // Update request timestamp
//             this.lastRequestTime = Date.now();

//             // Get suggestions from the server
//             const response = await fetch(`${this.serverUrl}/query`, {
//                 method: 'POST',
//                 headers: { 'Content-Type': 'application/json' },
//                 body: JSON.stringify({ 
//                     query: "Complete this code: " + linePrefix,
//                     context: codeContext,
//                     language: language
//                 })
//             });

//             const data: any = await response.json();
            
//             if (data && data.result) {
//                 // Extract the suggestion text, ensuring it's a string
//                 const suggestionText = String(data.result).trim();
                
//                 if (suggestionText) {
//                     return [
//                         new vscode.InlineCompletionItem(
//                             suggestionText,
//                             new vscode.Range(position, position)
//                         )
//                     ];
//                 }
//             }
//         } catch (error) {
//             console.error('Error getting completion:', error);
//         }

//         return [];
//     }
// }




// json:
// "commands": [
//       {
//         "command": "ai-code-assist.openChat",
//         "title": "Open AI Chat"
//       },
//       {
//         "command": "ai-code-assist.toggleSuggestions",
//         "title": "Toggle AI Code Suggestions"
//       }
//     ],
//     "keybindings": [
//       {
//           "command": "editor.action.inlineSuggest.commit",
//           "key": "tab",
//           "when": "inlineSuggestionVisible && !editorTabMovesFocus"
//       }
//     ]