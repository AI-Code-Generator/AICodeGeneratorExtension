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

            // Position the CodeLens at the start of the changed block
            const range = new vscode.Range(
                change.startLine,
                0,
                change.startLine,
                0
            );

            // Accept button
            const acceptCodeLens = new vscode.CodeLens(range, {
                title: "✓ Accept",
                command: 'aiCodeAssist.acceptChange',
                arguments: [change.id],
                tooltip: 'Accept this change'
            });

            // Reject button
            const rejectCodeLens = new vscode.CodeLens(range, {
                title: "✗ Reject",
                command: 'aiCodeAssist.rejectChange',
                arguments: [change.id],
                tooltip: 'Reject this change and revert to original'
            });

            codeLenses.push(acceptCodeLens, rejectCodeLens);
        }

        return codeLenses;
    }

    public refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }
}
