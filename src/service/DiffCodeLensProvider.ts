// src/service/DiffCodeLensProvider.ts
import * as vscode from 'vscode';
import { DiffManager } from './DiffManager';

export class DiffCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;
    private diffManager: DiffManager;

    constructor() {
        this.diffManager = DiffManager.getInstance();
    }

    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        const filePath = vscode.workspace.asRelativePath(document.uri);
        const pendingChanges = this.diffManager.getPendingChanges(filePath);
        
        if (pendingChanges.length === 0) {
            return [];
        }

        const codeLenses: vscode.CodeLens[] = [];

        for (const change of pendingChanges) {
            if (!change.applied) {
                continue; // Skip rejected changes
            }

            // Position the CodeLens based on change type
            let range: vscode.Range;
            
            if (change.changeType === 'delete') {
                // For deletions, position CodeLens at the deletion point
                const line = Math.min(change.startLine, document.lineCount - 1);
                range = new vscode.Range(line, 0, line, 0);
            } else {
                // For insertions and replacements, position at the start of the changed block
                range = new vscode.Range(change.startLine, 0, change.startLine, 0);
            }

            // Create different button text based on change type
            const changeTypeText = change.changeType === 'delete' ? ' (Deletion)' : 
                                 change.changeType === 'insert' ? ' (Addition)' : ' (Modification)';

            // Accept button
            const acceptCodeLens = new vscode.CodeLens(range, {
                title: `✓ Accept${changeTypeText}`,
                command: 'aiCodeAssist.acceptChange',
                arguments: [change.id],
                tooltip: `Accept this ${change.changeType}`
            });

            // Reject button
            const rejectCodeLens = new vscode.CodeLens(range, {
                title: `✗ Reject${changeTypeText}`,
                command: 'aiCodeAssist.rejectChange',
                arguments: [change.id],
                tooltip: `Reject this ${change.changeType} and revert to original`
            });

            codeLenses.push(acceptCodeLens, rejectCodeLens);
        }

        return codeLenses;
    }

    public refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }
}