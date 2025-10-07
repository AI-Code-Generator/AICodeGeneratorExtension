// src/service/DiffManager.ts
import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';

export interface DiffChange {
    id: string;
    filePath: string;
    originalContent: string;
    newContent: string;
    startLine: number;
    endLine: number;
    applied: boolean;
    timestamp: Date;
    changeType: 'insert' | 'delete' | 'replace'; // Add change type
}

export class DiffManager {
    private static instance: DiffManager;
    private pendingChanges: Map<string, DiffChange[]> = new Map();
    private insertDecorationType: vscode.TextEditorDecorationType;
    private deleteDecorationType: vscode.TextEditorDecorationType;
    private replaceDecorationType: vscode.TextEditorDecorationType;
    private updateTimeouts: Map<string, NodeJS.Timeout> = new Map();
    private dynamicDecorations: Map<string, vscode.TextEditorDecorationType[]> = new Map(); // Track dynamic decorations

    private constructor() {
        // Insert decoration (green background)
        this.insertDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('merge.incomingContentBackground'),
            isWholeLine: true,
            overviewRulerColor: new vscode.ThemeColor('merge.incomingHeaderBackground'),
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            border: '2px dashed rgba(0,200,0,0.5)',
            after: {
                contentText: ' ➕ ADDED by AI',
                color: new vscode.ThemeColor('merge.incomingHeaderBackground'),
                fontStyle: 'italic',
                margin: '0 0 0 1em'
            }
        });

        // Replace decoration (blue background)
        this.replaceDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('merge.currentContentBackground'),
            isWholeLine: true,
            overviewRulerColor: new vscode.ThemeColor('merge.currentHeaderBackground'),
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            after: {
                contentText: ' ← AI Generated (Modified)',
                color: new vscode.ThemeColor('merge.currentHeaderBackground'),
                fontStyle: 'italic',
                margin: '0 0 0 1em'
            }
        });

        // Delete decoration (shows deleted content)
        this.deleteDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('editorError.background'),
            overviewRulerColor: new vscode.ThemeColor('editorError.foreground'),
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            after: {
                contentText: ' ← AI Generated (Deleted)',
                color: new vscode.ThemeColor('editorError.foreground'),
                fontStyle: 'italic',
                margin: '0 0 0 1em'
            }
        });

        // Listen for active editor changes to update decorations
        vscode.window.onDidChangeActiveTextEditor(this.updateDecorations.bind(this));
        vscode.workspace.onDidChangeTextDocument(this.handleTextDocumentChange.bind(this));
        vscode.window.onDidChangeVisibleTextEditors(this.updateAllVisibleDecorations.bind(this));
    }

    public static getInstance(): DiffManager {
        if (!DiffManager.instance) {
            DiffManager.instance = new DiffManager();
        }
        return DiffManager.instance;
    }

    public async applyChangeWithDiff(filePath: string, newContent: string): Promise<string> {
        const absolutePath = this.getAbsolutePath(filePath);
        
        // Normalize to workspace-relative path for storage and UI
        // This ensures decorations match regardless of whether we receive absolute or relative path
        const workspaceRelativePath = vscode.workspace.asRelativePath(absolutePath);
        
        console.log('[DiffManager] Path normalization:', filePath, '→ absolute:', absolutePath, '→ relative:', workspaceRelativePath);
        
        // Read current content
        let originalContent: string;
        try {
            originalContent = await fs.readFile(absolutePath, 'utf-8');
        } catch (error) {
            // File doesn't exist, create it
            originalContent = '';
        }

        // Generate diff (use workspace-relative path for storage)
        const changes = this.generateDiffChanges(originalContent, newContent, workspaceRelativePath);
        
        if (changes.length === 0) {
            return 'No changes detected';
        }

        // Store pending changes with workspace-relative path as key
        this.pendingChanges.set(workspaceRelativePath, changes);

        // Apply changes to file immediately
        await fs.writeFile(absolutePath, newContent, 'utf-8');

        // Open the file if not already open
        await this.ensureFileIsOpen(absolutePath);

        // Force decoration update with a slight delay to ensure file is loaded
        setTimeout(() => {
            this.updateAllVisibleDecorations();
            // Force a second update to handle any timing issues
            setTimeout(() => {
                this.updateAllVisibleDecorations();
            }, 200);
        }, 100);

        return `Applied ${changes.length} changes to ${path.basename(filePath)}. Review and accept/reject individual changes.`;
    }

    private generateDiffChanges(originalContent: string, newContent: string, filePath: string): DiffChange[] {
        const originalLines = originalContent.split('\n');
        const newLines = newContent.split('\n');
        const changes: DiffChange[] = [];

        // Use a simple LCS-based diff algorithm
        const diff = this.computeDiff(originalLines, newLines);
        let changeId = 0;

        for (const change of diff) {
            if (change.type !== 'equal') {
                let startLine, endLine;
                
                if (change.type === 'delete') {
                    // For deletions, position at where the deletion occurred in the new file
                    startLine = change.newStart;
                    endLine = change.newStart;
                } else {
                    // For insertions and replacements, use the actual new lines
                    startLine = change.newStart;
                    endLine = change.newStart + Math.max(change.newLines.length, 1) - 1;
                }
                
                changes.push({
                    id: `${filePath}-${changeId++}`,
                    filePath,
                    originalContent: change.originalLines.join('\n'),
                    newContent: change.newLines.join('\n'),
                    startLine,
                    endLine,
                    applied: true,
                    timestamp: new Date(),
                    changeType: change.type as 'insert' | 'delete' | 'replace'
                });
            }
        }

        return changes;
    }

    private computeDiff(originalLines: string[], newLines: string[]): Array<{
        type: 'equal' | 'delete' | 'insert' | 'replace';
        originalStart: number;
        originalLines: string[];
        newStart: number;
        newLines: string[];
    }> {
        const diff: Array<{
            type: 'equal' | 'delete' | 'insert' | 'replace';
            originalStart: number;
            originalLines: string[];
            newStart: number;
            newLines: string[];
        }> = [];

        let i = 0, j = 0;

        while (i < originalLines.length || j < newLines.length) {
            // Find equal lines
            const equalStart = { original: i, new: j };
            while (i < originalLines.length && j < newLines.length && originalLines[i] === newLines[j]) {
                i++;
                j++;
            }

            if (i > equalStart.original) {
                diff.push({
                    type: 'equal',
                    originalStart: equalStart.original,
                    originalLines: originalLines.slice(equalStart.original, i),
                    newStart: equalStart.new,
                    newLines: newLines.slice(equalStart.new, j)
                });
            }

            if (i >= originalLines.length && j >= newLines.length) {
                break;
            }

            // Find the next matching block
            const changeStart = { original: i, new: j };
            let foundMatch = false;

            // Look ahead to find next common line
            for (let lookAhead = 1; lookAhead <= 10; lookAhead++) {
                for (let oi = i; oi < Math.min(i + lookAhead, originalLines.length); oi++) {
                    for (let ni = j; ni < Math.min(j + lookAhead, newLines.length); ni++) {
                        if (originalLines[oi] === newLines[ni] &&
                            oi + 1 < originalLines.length && ni + 1 < newLines.length &&
                            originalLines[oi + 1] === newLines[ni + 1]) {
                            
                            // Create change block
                            const originalBlock = originalLines.slice(changeStart.original, oi);
                            const newBlock = newLines.slice(changeStart.new, ni);
                            
                            if (originalBlock.length > 0 || newBlock.length > 0) {
                                let changeType: 'delete' | 'insert' | 'replace';
                                if (originalBlock.length === 0) {
                                    changeType = 'insert';
                                } else if (newBlock.length === 0) {
                                    changeType = 'delete';
                                } else {
                                    changeType = 'replace';
                                }

                                diff.push({
                                    type: changeType,
                                    originalStart: changeStart.original,
                                    originalLines: originalBlock,
                                    newStart: changeStart.new,
                                    newLines: newBlock
                                });
                            }

                            i = oi;
                            j = ni;
                            foundMatch = true;
                            break;
                        }
                    }
                    if (foundMatch) {
                        break;
                    }
                }
                if (foundMatch) {
                    break;
                }
            }

            if (!foundMatch) {
                // No more matches found, treat rest as change
                const originalBlock = originalLines.slice(changeStart.original);
                const newBlock = newLines.slice(changeStart.new);
                
                if (originalBlock.length > 0 || newBlock.length > 0) {
                    let changeType: 'delete' | 'insert' | 'replace';
                    if (originalBlock.length === 0) {
                        changeType = 'insert';
                    } else if (newBlock.length === 0) {
                        changeType = 'delete';
                    } else {
                        changeType = 'replace';
                    }

                    diff.push({
                        type: changeType,
                        originalStart: changeStart.original,
                        originalLines: originalBlock,
                        newStart: changeStart.new,
                        newLines: newBlock
                    });
                }
                break;
            }
        }

        return diff;
    }

    private async ensureFileIsOpen(absolutePath: string): Promise<void> {
        const uri = vscode.Uri.file(absolutePath);
        
        // Check if file is already open in any visible editor
        const visibleEditors = vscode.window.visibleTextEditors;
        const isAlreadyVisible = visibleEditors.some(editor => 
            editor.document.uri.fsPath === uri.fsPath
        );

        if (!isAlreadyVisible) {
            // Open the file
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document, vscode.ViewColumn.Active);
        }
    }

    private updateDecorations(): void {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            this.updateDecorationsForEditor(activeEditor);
        }
    }

    private updateAllVisibleDecorations(): void {
        // Update decorations for all visible editors
        vscode.window.visibleTextEditors.forEach(editor => {
            this.updateDecorationsForEditor(editor);
        });
    }

    private updateDecorationsForEditor(editor: vscode.TextEditor): void {
        const filePath = vscode.workspace.asRelativePath(editor.document.uri);
        const changes = this.pendingChanges.get(filePath);

        // Clear existing dynamic decorations for this file
        const existingDecorations = this.dynamicDecorations.get(filePath) || [];
        existingDecorations.forEach(decoration => decoration.dispose());
        this.dynamicDecorations.set(filePath, []);

        // Clear static decorations
        editor.setDecorations(this.insertDecorationType, []);
        editor.setDecorations(this.replaceDecorationType, []);
        editor.setDecorations(this.deleteDecorationType, []);

        if (!changes || changes.length === 0) {
            return;
        }

        const insertDecorations: vscode.DecorationOptions[] = [];
        const newDynamicDecorations: vscode.TextEditorDecorationType[] = [];

        for (const change of changes) {
            if (!change.applied) {
                continue; // Skip rejected changes
            }

            if (change.changeType === 'delete') {
                // For deletions, create a clear visual indicator with hover content
                const deleteLinesCount = change.originalContent.split('\n').length;
                
                const deleteDecoration = vscode.window.createTextEditorDecorationType({
                    backgroundColor: new vscode.ThemeColor('editorError.background'),
                    overviewRulerColor: new vscode.ThemeColor('editorError.foreground'),
                    overviewRulerLane: vscode.OverviewRulerLane.Right,
                    isWholeLine: true,
                    border: '2px dashed rgba(255,0,0,0.5)',
                    // Show clear deletion indicator
                    after: {
                        contentText: ` 🗑️ DELETED ${deleteLinesCount} line${deleteLinesCount > 1 ? 's' : ''} (hover to see content)`,
                        color: new vscode.ThemeColor('editorError.foreground'),
                        fontStyle: 'italic',
                        fontWeight: 'bold',
                        margin: '0 0 0 1em',
                        backgroundColor: new vscode.ThemeColor('editorError.background'),
                        border: '1px solid rgba(255,0,0,0.3)',
                        textDecoration: 'none'
                    }
                });

                newDynamicDecorations.push(deleteDecoration);
                
                // Position for showing deleted content indicator
                let line = Math.min(change.startLine, editor.document.lineCount - 1);
                if (line < 0) {
                    line = Math.max(0, editor.document.lineCount - 1);
                }
                
                const range = new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length);

                editor.setDecorations(deleteDecoration, [{
                    range,
                    hoverMessage: new vscode.MarkdownString(
                        `**🗑️ AI Generated Deletion**\n\n` +
                        `Change ID: \`${change.id}\`\n\n` +
                        `Applied at: ${change.timestamp.toLocaleString()}\n\n` +
                        `**❌ DELETED CONTENT:**\n\`\`\`\n${change.originalContent}\n\`\`\`\n\n` +
                        `*${deleteLinesCount} line${deleteLinesCount > 1 ? 's were' : ' was'} removed from this location*`
                    )
                }]);

            } else if (change.changeType === 'replace') {
                // For replacements, show modified indicator with rich hover showing both versions
                const replaceDecoration = vscode.window.createTextEditorDecorationType({
                    backgroundColor: new vscode.ThemeColor('merge.currentContentBackground'),
                    isWholeLine: true,
                    overviewRulerColor: new vscode.ThemeColor('merge.currentHeaderBackground'),
                    overviewRulerLane: vscode.OverviewRulerLane.Right,
                    border: '2px dashed rgba(0,100,200,0.5)',
                    after: {
                        contentText: ' 🔄 MODIFIED (hover to see original vs new)',
                        color: new vscode.ThemeColor('merge.currentHeaderBackground'),
                        fontStyle: 'italic',
                        fontWeight: 'bold',
                        margin: '0 0 0 1em',
                        backgroundColor: new vscode.ThemeColor('merge.currentContentBackground'),
                        border: '1px solid rgba(0,100,200,0.3)'
                    }
                });

                newDynamicDecorations.push(replaceDecoration);
                
                const maxLine = Math.min(change.endLine, editor.document.lineCount - 1);
                const startLine = Math.min(change.startLine, editor.document.lineCount - 1);

                if (startLine >= 0 && maxLine >= startLine) {
                    const range = new vscode.Range(
                        startLine,
                        0,
                        maxLine,
                        editor.document.lineAt(maxLine).text.length
                    );

                    editor.setDecorations(replaceDecoration, [{
                        range,
                        hoverMessage: new vscode.MarkdownString(
                            `**🔄 AI Generated Modification**\n\n` +
                            `Change ID: \`${change.id}\`\n\n` +
                            `Applied at: ${change.timestamp.toLocaleString()}\n\n` +
                            `**❌ ORIGINAL (removed):**\n\`\`\`\n${change.originalContent}\n\`\`\`\n\n` +
                            `**✅ NEW (current):**\n\`\`\`\n${change.newContent}\n\`\`\`\n\n` +
                            `*The original content was replaced with the new content above*`
                        )
                    }]);
                }

            } else { // insert
                const maxLine = Math.min(change.endLine, editor.document.lineCount - 1);
                const startLine = Math.min(change.startLine, editor.document.lineCount - 1);

                if (startLine >= 0 && maxLine >= startLine) {
                    const range = new vscode.Range(
                        startLine,
                        0,
                        maxLine,
                        editor.document.lineAt(maxLine).text.length
                    );

                    insertDecorations.push({
                        range,
                        hoverMessage: new vscode.MarkdownString(
                            `**➕ AI Generated Addition**\n\n` +
                            `Change ID: \`${change.id}\`\n\n` +
                            `Applied at: ${change.timestamp.toLocaleString()}\n\n` +
                            `**✅ ADDED CONTENT:**\n\`\`\`\n${change.newContent}\n\`\`\`\n\n` +
                            `*This content was added by the AI*`
                        )
                    });
                }
            }
        }

        // Apply static decorations
        editor.setDecorations(this.insertDecorationType, insertDecorations);

        // Store dynamic decorations for cleanup
        this.dynamicDecorations.set(filePath, newDynamicDecorations);
    }

    private handleTextDocumentChange(event: vscode.TextDocumentChangeEvent): void {
        // Update decorations when document changes, but with a delay to avoid too frequent updates
        const filePath = vscode.workspace.asRelativePath(event.document.uri);
        
        if (this.pendingChanges.has(filePath)) {
            // Clear any existing timeout for this file
            clearTimeout(this.updateTimeouts.get(filePath));
            
            // Set a new timeout to update decorations
            const timeout = setTimeout(() => {
                // Find the editor for this document and update its decorations
                const editor = vscode.window.visibleTextEditors.find(
                    e => e.document.uri.fsPath === event.document.uri.fsPath
                );
                if (editor) {
                    this.updateDecorationsForEditor(editor);
                }
                this.updateTimeouts.delete(filePath);
            }, 150);
            
            this.updateTimeouts.set(filePath, timeout);
        }
    }

    public acceptChange(changeId: string): void {
        for (const [filePath, changes] of this.pendingChanges) {
            const change = changes.find(c => c.id === changeId);
            if (change) {
                // Change is already applied, just remove it from pending
                const index = changes.indexOf(change);
                changes.splice(index, 1);
                
                if (changes.length === 0) {
                    this.pendingChanges.delete(filePath);
                }
                
                // Force immediate decoration update
                this.updateAllVisibleDecorations();
                vscode.window.showInformationMessage(`Accepted change ${changeId}`);
                return;
            }
        }
    }

    public async rejectChange(changeId: string): Promise<void> {
        for (const [filePath, changes] of this.pendingChanges) {
            const change = changes.find(c => c.id === changeId);
            if (change) {
                // Revert the change in the file
                const absolutePath = this.getAbsolutePath(filePath);
                const currentContent = await fs.readFile(absolutePath, 'utf-8');
                const lines = currentContent.split('\n');
                
                // Find the exact lines to replace
                const startLine = change.startLine;
                const endLine = change.endLine;
                const linesToReplace = endLine - startLine + 1;
                
                // Replace the changed lines with original content
                const originalLines = change.originalContent.split('\n');
                
                // Handle empty original content (pure insertion)
                if (change.originalContent.trim() === '') {
                    // Remove the inserted lines
                    lines.splice(startLine, linesToReplace);
                } else {
                    // Replace with original lines
                    lines.splice(startLine, linesToReplace, ...originalLines);
                }
                
                await fs.writeFile(absolutePath, lines.join('\n'), 'utf-8');
                
                // Remove from pending changes
                const index = changes.indexOf(change);
                changes.splice(index, 1);
                
                if (changes.length === 0) {
                    this.pendingChanges.delete(filePath);
                }
                
                // Force immediate decoration update
                this.updateAllVisibleDecorations();
                vscode.window.showInformationMessage(`Rejected change ${changeId}`);
                return;
            }
        }
    }

    public acceptAllChanges(): void {
        // Simply clear all pending changes since they're already applied to files
        const changeCount = Array.from(this.pendingChanges.values()).reduce((total, changes) => total + changes.length, 0);
        this.pendingChanges.clear();
        
        // Clear all dynamic decorations
        for (const decorations of this.dynamicDecorations.values()) {
            decorations.forEach(decoration => decoration.dispose());
        }
        this.dynamicDecorations.clear();

        // Force immediate decoration update
        this.updateAllVisibleDecorations();
        vscode.window.showInformationMessage(`Accepted ${changeCount} AI-generated changes`);
    }

    public async rejectAllChanges(): Promise<void> {
        // Collect all changes and their file info for batch processing
        const filesToRevert: Map<string, { absolutePath: string, changes: DiffChange[] }> = new Map();
        
        for (const [filePath, changes] of this.pendingChanges) {
            if (changes.length > 0) {
                filesToRevert.set(filePath, {
                    absolutePath: this.getAbsolutePath(filePath),
                    changes: [...changes] // Create a copy
                });
            }
        }

        // Process each file
        for (const [filePath, fileInfo] of filesToRevert) {
            try {
                // Read current content
                const currentContent = await fs.readFile(fileInfo.absolutePath, 'utf-8');
                let lines = currentContent.split('\n');
                
                // Sort changes by line number in reverse order to avoid line number shifting
                const sortedChanges = fileInfo.changes.sort((a, b) => b.startLine - a.startLine);
                
                // Apply reverts in reverse order
                for (const change of sortedChanges) {
                    if (change.changeType === 'delete') {
                        // Re-insert deleted content
                        const originalLines = change.originalContent.split('\n');
                        lines.splice(change.startLine, 0, ...originalLines);
                    } else if (change.changeType === 'insert') {
                        // Remove inserted content
                        const linesToRemove = change.endLine - change.startLine + 1;
                        lines.splice(change.startLine, linesToRemove);
                    } else if (change.changeType === 'replace') {
                        // Replace with original content
                        const linesToReplace = change.endLine - change.startLine + 1;
                        const originalLines = change.originalContent.split('\n');
                        lines.splice(change.startLine, linesToReplace, ...originalLines);
                    }
                }
                
                // Write reverted content back to file
                await fs.writeFile(fileInfo.absolutePath, lines.join('\n'), 'utf-8');
                
            } catch (error) {
                console.error(`Failed to revert changes in ${filePath}:`, error);
                vscode.window.showErrorMessage(`Failed to revert changes in ${filePath}`);
            }
        }

        const changeCount = Array.from(this.pendingChanges.values()).reduce((total, changes) => total + changes.length, 0);
        
        // Clear all pending changes
        this.pendingChanges.clear();
        
        // Clear all dynamic decorations
        for (const decorations of this.dynamicDecorations.values()) {
            decorations.forEach(decoration => decoration.dispose());
        }
        this.dynamicDecorations.clear();

        // Force immediate decoration update
        this.updateAllVisibleDecorations();
        vscode.window.showInformationMessage(`Rejected ${changeCount} AI-generated changes`);
    }

    public getPendingChanges(filePath: string): DiffChange[] {
        return this.pendingChanges.get(filePath) || [];
    }

    public getAllPendingChanges(): Map<string, DiffChange[]> {
        return new Map(this.pendingChanges);
    }

    private getAbsolutePath(filePath: string): string {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }
        if (vscode.workspace.workspaceFolders) {
            return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, filePath);
        }
        return filePath;
    }

    public dispose(): void {
        this.insertDecorationType.dispose();
        this.replaceDecorationType.dispose();
        this.deleteDecorationType.dispose();
        
        // Dispose all dynamic decorations
        for (const decorations of this.dynamicDecorations.values()) {
            decorations.forEach(decoration => decoration.dispose());
        }
        this.dynamicDecorations.clear();
        
        this.pendingChanges.clear();
        
        // Clear all pending timeouts
        for (const timeout of this.updateTimeouts.values()) {
            clearTimeout(timeout);
        }
        this.updateTimeouts.clear();
    }

    public forceRefreshDecorations(): void {
        // Force refresh decorations for all visible editors
        this.updateAllVisibleDecorations();
    }
}
