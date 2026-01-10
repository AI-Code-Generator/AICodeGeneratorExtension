// src/service/AgentService.ts
import * as vscode from 'vscode';
import { promises as fs, existsSync } from 'fs';
import * as path from 'path';
import { DiffManager } from './DiffManager';
import { state, initializeEmbedder, embedQuery } from './FileIndexer';
import { EXCLUDED_DIRS, EXCLUDED_GLOB_PATTERN } from './constants';
import { extractCommandOutput } from './terminalUtils';
import * as Diff from 'diff';

// --- NEW HELPER: Check binary without reading whole file ---
async function isBinaryFile(filePath: string): Promise<boolean> {
    let fileHandle: fs.FileHandle | null = null;
    try {
        fileHandle = await fs.open(filePath, 'r');
        const bytesToCheck = 4096;
        const buffer = Buffer.alloc(bytesToCheck); 
        const { bytesRead } = await fileHandle.read(buffer, 0, bytesToCheck, 0);

        // Check for null bytes in the sample
        for (let i = 0; i < bytesRead; i++) {
            if (buffer[i] === 0) {
                return true;
            }
        }
        return false;
    } catch (error) {
        return false; // Assume text if we can't check
    } finally {
        if (fileHandle) {
            await fileHandle.close();
        }
    }
}
// -----------------------------------------------------------

// The ToolBox holds the set of functions the agent can execute.
class ToolBox {
    private diffManager: DiffManager;
    private terminalCommandCallback?: (command: string) => Promise<boolean>;
    private workingDirectory: string = '';
    private terminal?: vscode.Terminal;
    private captureTimeout?: NodeJS.Timeout;
    private terminalCommandCount: number = 0;
    private readonly MAX_COMMANDS_PER_TERMINAL = 10; // Refresh terminal after 10 commands
    private context: vscode.ExtensionContext; // Store the extension context
    private sendUpdateCallback?: (update: string) => void; // For streaming terminal output

    constructor(context: vscode.ExtensionContext) { // Accept context in constructor
        this.diffManager = DiffManager.getInstance();
        this.context = context; // Store it
    }

    public setTerminalCommandCallback(callback: (command: string) => Promise<boolean>) {
        this.terminalCommandCallback = callback;
    }

    /**
     * Set the callback function for sending live updates to the chat view.
     */
    public setSendUpdateCallback(callback: (update: string) => void) {
        this.sendUpdateCallback = callback;
    }

    public setWorkingDirectory(directory: string) {
        this.workingDirectory = directory;
    }

    public getWorkingDirectory(): string {
        // Auto-initialize to workspace root if not set
        if (!this.workingDirectory && vscode.workspace.workspaceFolders) {
            this.workingDirectory = vscode.workspace.workspaceFolders[0].uri.fsPath;
            console.log('[ToolBox] Auto-initialized working directory to:', this.workingDirectory);
        }
        return this.workingDirectory;
    }

    private ensureTerminal(): vscode.Terminal {
        let cwd = this.workingDirectory || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        
        // Validate that the cwd exists; if not, fall back to workspace root or undefined
        if (cwd && !existsSync(cwd)) {
            console.warn(`[Terminal] Working directory "${cwd}" does not exist. Falling back to workspace root.`);
            cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            
            // If workspace root also doesn't exist, let the terminal use its default (usually $HOME)
            if (cwd && !existsSync(cwd)) {
                console.warn(`[Terminal] Workspace root "${cwd}" also does not exist. Using system default.`);
                cwd = undefined;
            }
            
            // Update the internal working directory to match the fallback
            this.workingDirectory = cwd || '';
            console.log(`[Terminal] Updated working directory to: ${this.workingDirectory || '(empty - will use workspace root)'}`);
        }
        
        // Check if we should refresh the terminal (too many commands executed)
        const shouldRefresh = this.terminalCommandCount >= this.MAX_COMMANDS_PER_TERMINAL;
        
        if (!this.terminal || this.terminal.exitStatus || shouldRefresh) {
            // Dispose old terminal if refreshing
            if (shouldRefresh && this.terminal && !this.terminal.exitStatus) {
                console.log(`[Terminal] Refreshing terminal after ${this.terminalCommandCount} commands`);
                try {
                    this.terminal.dispose();
                } catch { /* ignore */ }
                this.terminalCommandCount = 0; // Reset counter
            }
            
            // Create a new terminal
            this.terminal = vscode.window.createTerminal({ name: 'AI Code Assist Agent', cwd });
            // Show terminal immediately to initialize shell integration faster
            this.terminal.show(false);
            console.log(`[Terminal] Created new terminal with cwd: ${cwd || '(system default)'}`);
        } else {
            // Reusing existing terminal
            console.log(`[Terminal] Reusing existing terminal (${this.terminalCommandCount}/${this.MAX_COMMANDS_PER_TERMINAL} commands)`);
            this.terminal.show(false);
        }
        return this.terminal;
    }

    // Deleted the ensurePseudoTerminal method - we'll use the regular terminal only

    // Attempt to stop any currently running process in the agent terminal.
    // Strategy: send Ctrl+C a couple times, wait briefly, then dispose and recreate terminal to guarantee a clean state.
    private async killRunningTerminalProcess(): Promise<void> {
        // Clear any pending timeout
        if (this.captureTimeout) {
            clearTimeout(this.captureTimeout);
            this.captureTimeout = undefined;
        }

        // Only send Ctrl+C if terminal exists and is not closed
        // DON'T dispose the terminal - we want to reuse it!
        if (this.terminal && !this.terminal.exitStatus) {
            try {
                // Send Ctrl+C twice to gracefully terminate any running process
                console.log('[Terminal] Sending Ctrl+C to stop any running process...');
                this.terminal.sendText('\x03', false);  // Ctrl+C without newline
                await new Promise((r) => setTimeout(r, 300));
                this.terminal.sendText('\x03', false);
                await new Promise((r) => setTimeout(r, 300));
            } catch { /* ignore */ }
        }
        // Keep the terminal alive for reuse!
    }

    public async list_files(offset: number = 0): Promise<{files: string[], total: number, hasMore: boolean}> {
        const limit: number = 10000;
        let allFiles: string[] = [];
        
        if (this.workingDirectory) {
            // Use fs to list files recursively in the specific directory
            const fs = require('fs');
            const path = require('path');
            
            const getAllFiles = (dirPath: string, arrayOfFiles: string[] = []): string[] => {
                try {
                    const files = fs.readdirSync(dirPath);
                    
                    for (const file of files) {
                        // Skip excluded directories - check before processing
                        if (EXCLUDED_DIRS.includes(file)) {
                            continue;
                        }
                        
                        const fullPath = path.join(dirPath, file);
                        
                        try {
                            const stat = fs.statSync(fullPath);
                            if (stat.isDirectory()) {
                                getAllFiles(fullPath, arrayOfFiles);
                            } else {
                                // Return relative path from working directory
                                const relativePath = path.relative(this.workingDirectory, fullPath);
                                arrayOfFiles.push(relativePath);
                            }
                        } catch (statError) {
                            // Skip files that can't be accessed (permissions, broken symlinks, etc.)
                            continue;
                        }
                    }
                } catch (error) {
                    console.error(`Error reading directory ${dirPath}:`, error);
                }
                
                return arrayOfFiles;
            };
            
            allFiles = getAllFiles(this.workingDirectory);
        } else {
            // Find all files, ignoring dependency folders and other common exclusions
            const files = await vscode.workspace.findFiles('**/*', EXCLUDED_GLOB_PATTERN);
            allFiles = files.map(file => vscode.workspace.asRelativePath(file));
        }

        // Sort files for consistent ordering
        allFiles.sort();
        
        // Paginate the results
        const startIndex = offset;
        const endIndex = Math.min(offset + limit, allFiles.length);
        const paginatedFiles = allFiles.slice(startIndex, endIndex);
        
        return {
            files: paginatedFiles,
            total: allFiles.length,
            hasMore: endIndex < allFiles.length
        };
    }

    public async search_files(pattern: string): Promise<string[]> {
        if (this.workingDirectory) {
            const fs = require('fs');
            const path = require('path');
            
            const searchFiles = (dirPath: string, pattern: string, arrayOfFiles: string[] = []): string[] => {
                try {
                    const files = fs.readdirSync(dirPath);
                    
                    for (const file of files) {
                        // Skip excluded directories - check before processing
                        if (EXCLUDED_DIRS.includes(file)) {
                            continue;
                        }
                        
                        const fullPath = path.join(dirPath, file);
                        
                        try {
                            const stat = fs.statSync(fullPath);
                            if (stat.isDirectory()) {
                                searchFiles(fullPath, pattern, arrayOfFiles);
                            } else {
                                const relativePath = path.relative(this.workingDirectory, fullPath);
                                // Simple pattern matching - contains the pattern or matches file extension
                                if (relativePath.toLowerCase().includes(pattern.toLowerCase()) || 
                                    relativePath.endsWith(pattern)) {
                                    arrayOfFiles.push(relativePath);
                                }
                            }
                        } catch (statError) {
                            // Skip files that can't be accessed
                            continue;
                        }
                    }
                } catch (error) {
                    console.error(`Error reading directory ${dirPath}:`, error);
                }
                
                return arrayOfFiles;
            };
            
            return searchFiles(this.workingDirectory, pattern).slice(0, 50); // Limit to 50 results
        } else {
            // Find files using vscode
            const files = await vscode.workspace.findFiles(`**/*${pattern}*`, EXCLUDED_GLOB_PATTERN);
            return files.map(file => vscode.workspace.asRelativePath(file)).slice(0, 50);
        }
    }

    /**
     * Search for a keyword across the workspace file contents.
     * Returns an array of compact match objects with file path and line snippets.
     * This is different from search_files which matches file NAMES only.
     */
    public async search_text(keyword: string, maxFiles: number = 200, maxMatchesPerFile: number = 5): Promise<Array<{ file: string, matches: Array<{ line: number, text: string }> }>> {
        const results: Array<{ file: string, matches: Array<{ line: number, text: string }> }> = [];

        // Helper to scan a single file content for keyword
        const scanContent = (content: string, file: string) => {
            const lower = content.toLowerCase();
            const idx = lower.indexOf(keyword.toLowerCase());
            if (idx === -1) {
                return; // quick reject
            }

            const lines = content.split('\n');
            const fileMatches: Array<{ line: number, text: string }> = [];
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(keyword.toLowerCase())) {
                    fileMatches.push({ line: i + 1, text: lines[i].slice(0, 500) });
                    if (fileMatches.length >= maxMatchesPerFile) {
                        break;
                    }
                }
            }
            if (fileMatches.length) {
                results.push({ file, matches: fileMatches });
            }
        };

        if (this.workingDirectory) {
            const fsSync = require('fs');
            const pathMod = require('path');

            const gatherFiles = (dirPath: string, acc: string[] = []) => {
                try {
                    for (const entry of fsSync.readdirSync(dirPath)) {
                        if (EXCLUDED_DIRS.includes(entry)) {
                            continue;
                        }
                        const full = pathMod.join(dirPath, entry);
                        try {
                            const stat = fsSync.statSync(full);
                            if (stat.isDirectory()) {
                                gatherFiles(full, acc);
                            } else {
                                acc.push(full);
                                if (acc.length >= maxFiles) {
                                    return acc;
                                }
                            }
                        } catch (_) {
                            // Skip files that can't be accessed
                            continue;
                        }
                    }
                } catch (_) { /* ignore */ }
                return acc;
            };

            const files = gatherFiles(this.workingDirectory, []);
            for (const abs of files) {
                try {
                    // Skip large files (>1MB)
                    const stat = fsSync.statSync(abs);
                    if (stat.size > 1_000_000) {
                        continue;
                    }
                    const content = fsSync.readFileSync(abs, 'utf-8');
                    const rel = pathMod.relative(this.workingDirectory, abs);
                    scanContent(content, rel);
                } catch (_) { /* ignore */ }
            }
        } else {
            // VS Code API path
            const files = await vscode.workspace.findFiles('**/*', EXCLUDED_GLOB_PATTERN);
            let count = 0;
            for (const uri of files) {
                if (count >= maxFiles) {
                    break;
                }
                try {
                    const doc = await vscode.workspace.fs.readFile(uri);
                    // Limit size to 1MB
                    if (doc.byteLength > 1_000_000) {
                        continue;
                    }
                    const content = Buffer.from(doc).toString('utf-8');
                    const rel = vscode.workspace.asRelativePath(uri);
                    scanContent(content, rel);
                    count++;
                } catch (_) { /* ignore */ }
            }
        }

        return results.slice(0, maxFiles);
    }

    // --- OPTIMIZED READ_FILE ---
    public async read_file(filePath: string): Promise<string> {
        const absolutePath = this.getAbsolutePath(filePath);
        const CHUNK_SIZE = 50000;
        const FILE_SIZE_LIMIT = CHUNK_SIZE;

        try {
            // 1. Check statistics FIRST (before reading content)
            const stats = await fs.stat(absolutePath);

            // 2. Fail fast on Binary Files
            if (await isBinaryFile(absolutePath)) {
                return `Error: File '${filePath}' appears to be a binary file. Reading it as text is not supported.`;
            }

            // 3. Fail fast on size (check bytes, not characters, to avoid memory spikes)
            // Use a safety multiplier (e.g. 1.2x limit) because 1 char != 1 byte in UTF8
            // If the file is > 100KB bytes, it's definitely going to be > 100k chars or close enough to warn
            if (stats.size > FILE_SIZE_LIMIT * 1.5) {
                const totalChunks = Math.ceil(stats.size / CHUNK_SIZE);
                return `Error: File '${filePath}' is too long (approx ${stats.size} bytes). ` +
                        `It has been divided into approx ${totalChunks} chunks. ` +
                        `Use 'search_in_file(filePath, keyword)' to find specific content, ` +
                        `or 'read_file_chunk(filePath, chunkNumber)' to read a specific chunk.`;
            }

            // 4. Safe to read into RAM now
            const content = await fs.readFile(absolutePath, 'utf-8');
            
            // 5. Final accurate character check
            if (content.length > FILE_SIZE_LIMIT) {
                // Calculate total chunks based on the fixed chunk size
                const totalChunks = Math.ceil(content.length / CHUNK_SIZE);

                // If file is too long, return error with total chunks
                return `Error: File '${filePath}' is too long (${content.length} characters). ` +
                       `It has been divided into ${totalChunks} chunks. ` + // Inform about total chunks
                       `Use 'search_in_file(filePath, keyword)' to find specific content, ` +
                       `or 'read_file_chunk(filePath, chunkNumber)' to read a specific chunk (e.g., chunkNumber 1).`;
                       // Removed the truncated content start
            }
            return content; // Return full content if within limit
        } catch (error) {
            if ((error as any).code === 'ENOENT') {
                return `Error: File not found at path: ${absolutePath}. Working directory: ${this.workingDirectory}`;
            }
            return `Error reading file: ${error}`;
        }
    }

    public async search_in_file(filePath: string, keyword: string): Promise<string> {
        const absolutePath = this.getAbsolutePath(filePath);
        try {
            // NOTE: search_in_file still reads the whole file to find matches.
            // If you have massive files, you might want to stream this too, 
            if (await isBinaryFile(absolutePath)) {
                return `Error: Cannot search in binary file '${filePath}'.`;
            }

            const content = await fs.readFile(absolutePath, 'utf-8');
            const lines = content.split('\n');
            const matchingLines: string[] = [];
            const CONTEXT_LINES = 5; // How many lines before and after to show

            lines.forEach((line, index) => {
                if (line.toLowerCase().includes(keyword.toLowerCase())) {
                    matchingLines.push(`\n--- Match found on line ${index + 1} ---\n`);
                    const start = Math.max(0, index - CONTEXT_LINES);
                    const end = Math.min(lines.length, index + CONTEXT_LINES + 1);
                    for (let i = start; i < end; i++) {
                        // Add line numbers for context
                        matchingLines.push(`${i + 1}: ${lines[i]}`);
                    }
                }
            });

            if (matchingLines.length === 0) {
                return `Keyword '${keyword}' not found in file '${filePath}'.`;
            }

            // Join the results and cap the total length to prevent explosions
            return matchingLines.join('\n').substring(0, 8000);

        } catch (error) {
            if ((error as any).code === 'ENOENT') {
                return `Error: File not found at path: ${absolutePath}.`;
            }
            return `Error searching in file: ${error}`;
        }
    }

    // Updated read_file_chunk: removed chunkSize, uses fixed size
    public async read_file_chunk(filePath: string, chunkNumber: number = 1): Promise<string> {
        const absolutePath = this.getAbsolutePath(filePath);
        const CHUNK_SIZE = 50000; // Use the fixed chunk size

        try {
            if (await isBinaryFile(absolutePath)) {
                return `Error: Cannot read chunk of binary file '${filePath}'.`;
            }

            const content = await fs.readFile(absolutePath, 'utf-8');
            const totalChunks = Math.ceil(content.length / CHUNK_SIZE);

            if (chunkNumber < 1 || chunkNumber > totalChunks) {
                return `Error: Chunk number ${chunkNumber} is out of bounds. The file '${filePath}' only has ${totalChunks} chunks (1 to ${totalChunks}).`;
            }

            const start = (chunkNumber - 1) * CHUNK_SIZE;
            // End index is calculated correctly, Math.min handles the last chunk
            const end = Math.min(start + CHUNK_SIZE, content.length);
            const chunkContent = content.substring(start, end);

            // Never return truncated message from here
            return `--- Showing chunk ${chunkNumber} of ${totalChunks} from file '${filePath}' ---\n\n` + chunkContent;

        } catch (error) {
            if ((error as any).code === 'ENOENT') {
                return `Error: File not found at path: ${absolutePath}.`;
            }
            return `Error reading file chunk: ${error}`;
        }
    }

    /**
     * Replaces the entire content of a file. Use apply_file_patch for smaller changes.
     */
    public async apply_file_change(filePath: string, newContent: string): Promise<string> {
        // Convert relative path to absolute path using workingDirectory
        const absolutePath = this.getAbsolutePath(filePath);
        console.log('[apply_file_change] Converting path:', filePath, '→', absolutePath);
        
        // Pass both absolute path (for file operations) and relative path (for display)
        return await this.diffManager.applyChangeWithDiff(absolutePath, newContent);
    }

    /**
     * Applies a patch (in standard diff format) to a file.
     * Useful for applying small changes generated by the agent without replacing the whole file.
     */
    public async apply_file_patch(filePath: string, patchContent: string): Promise<string> {
        const absolutePath = this.getAbsolutePath(filePath);
        console.log('[apply_file_patch] Applying patch to:', absolutePath);

        let originalContent: string;
        try {
            originalContent = await fs.readFile(absolutePath, 'utf-8');
        } catch (error) {
            if ((error as any).code === 'ENOENT') {
                return `Error: File not found at path: ${absolutePath} to apply patch. Working directory: ${this.workingDirectory}`;
            }
            return `Error reading file for patching: ${error}`;
        }

        // Pre-sanitize common LLM patch issues before attempting to apply
        const sanitized = this.sanitizeUnifiedDiff(patchContent);

        try {
            const patchedContent = Diff.applyPatch(originalContent, sanitized);

            if (patchedContent === false) {
                // The patch didn't apply cleanly
                console.warn(`[apply_file_patch] Patch did not apply cleanly to ${filePath}.`);
                // Attempt to apply with fuzz factor (optional, can be noisy)
                const fuzzyResult = Diff.applyPatch(originalContent, sanitized, { fuzzFactor: 2 });
                if (fuzzyResult === false) {
                    // As a last-resort, try a manual hunk applier that tolerates incorrect counts
                    const manual = this.tryManualHunkApply(originalContent, sanitized);
                    if (manual === null) {
                        return `Error: Patch could not be applied cleanly to file ${filePath}. The file content might have changed, or the patch format is incorrect.`;
                    }
                    console.log(`[apply_file_patch] Patch applied via manual hunk applier.`);
                    return await this.diffManager.applyChangeWithDiff(absolutePath, manual);
                }
                console.log(`[apply_file_patch] Patch applied with fuzz factor.`);
                // If fuzzy patching worked, use that result.
                // We still use applyChangeWithDiff to leverage existing UI.
                return await this.diffManager.applyChangeWithDiff(absolutePath, fuzzyResult);
            }

            // If patch applied cleanly, use applyChangeWithDiff to show the result
            return await this.diffManager.applyChangeWithDiff(absolutePath, patchedContent);

        } catch (error: any) {
            console.warn(`[apply_file_patch] Parser threw while applying patch to ${filePath}: ${error?.message || error}. Trying manual fallback.`);
            // Try manual fallback even on thrown parse errors
            const manual = this.tryManualHunkApply(originalContent, sanitized);
            if (manual !== null) {
                console.log(`[apply_file_patch] Patch applied via manual hunk applier after exception.`);
                return await this.diffManager.applyChangeWithDiff(absolutePath, manual);
            }
            console.error(`[apply_file_patch] Manual fallback also failed for ${filePath}.`);
            return `Error applying patch (and manual fallback failed): ${error?.message || error}`;
        }
    }

    /**
     * Attempts to normalize a unified diff string to be acceptable by the 'diff' library parser.
     * Fixes these common issues:
     * - Removes surrounding code fences (``` or *** Begin/End Patch wrappers left in content)
     * - Normalizes CRLF to LF
     * - Ensures lines inside @@ hunk blocks start with a valid marker (' ', '+', '-', '\\')
     * - Ensures the patch ends with a trailing newline (some parsers require it)
     */
    private sanitizeUnifiedDiff(patch: string): string {
        if (!patch) { return patch; }

        // 1) Strip code fences and wrapper markers if present
        let p = patch.trim();
        // Remove markdown code fences
        if (p.startsWith('```')) {
            p = p.replace(/^```[a-zA-Z0-9]*\n?/m, '');
            p = p.replace(/\n?```\s*$/m, '');
        }
        // Remove our Begin/End Patch wrapper if mistakenly included inside
        p = p.replace(/\*\*\*\s*Begin Patch\s*\n/g, '')
             .replace(/\n?\*\*\*\s*End Patch\s*$/g, '')
             .trim();

        // 2) Normalize line endings
        p = p.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        // 3) Ensure hunk lines have proper prefixes
        const lines = p.split('\n');
        let inHunk = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('@@')) {
                inHunk = true;
                continue;
            }
            // Headers or file markers exit hunk context
            if (line.startsWith('diff ') || line.startsWith('Index:') || line.startsWith('--- ') || line.startsWith('+++ ')) {
                inHunk = false; // outside hunk until next @@
                continue;
            }
            if (inHunk) {
                // Valid prefixes inside a hunk: space, '+', '-', '\\' (for no newline at EOF)
                if (!(line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\'))) {
                    // Likely an unchanged context line missing the required leading space
                    lines[i] = ' ' + line;
                }
            }
        }
        p = lines.join('\n');

        // 4) Ensure patch ends with a newline
        if (!p.endsWith('\n')) {
            p += '\n';
        }

        return p;
    }

    /**
     * Manual unified-diff hunk application that ignores incorrect hunk counts.
     * Strategy: split into hunks, derive old/new blocks from line markers, and
     * perform a straightforward substring replacement per hunk in sequence.
     * Returns null if any hunk cannot be located.
     */
    private tryManualHunkApply(original: string, patch: string): string | null {
        let src = original.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const p = patch.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        // Extract hunks: everything after a line starting with @@ until next @@ or end
        const lines = p.split('\n');
        const hunks: string[][] = [];
        let current: string[] | null = null;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('@@')) {
                if (current) { hunks.push(current); }
                current = [line];
            } else if (current) {
                // Stop hunk at a new index header (---/+++/diff/Index)
                if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff ') || line.startsWith('Index:')) {
                    hunks.push(current);
                    current = null;
                } else {
                    current.push(line);
                }
            }
        }
        if (current) { hunks.push(current); }

        const applyOne = (content: string, hunkLines: string[]): string | null => {
            // Build old/new text blocks from markers
            const oldParts: string[] = [];
            const newParts: string[] = [];
            for (let i = 1; i < hunkLines.length; i++) { // skip header line
                const l = hunkLines[i];
                if (!l.length) { // blank line inside hunk => context blank line
                    oldParts.push('');
                    newParts.push('');
                    continue;
                }
                const tag = l[0];
                const body = l.substring(1);
                if (tag === ' ') {
                    oldParts.push(body);
                    newParts.push(body);
                } else if (tag === '-') {
                    oldParts.push(body);
                } else if (tag === '+') {
                    newParts.push(body);
                } else if (tag === '\\') {
                    // No newline marker; ignore
                } else {
                    // Unexpected, treat as context line (auto-fix)
                    oldParts.push(l);
                    newParts.push(l);
                }
            }
            const oldText = oldParts.join('\n');
            const newText = newParts.join('\n');

            // Direct substring search
            let idx = content.indexOf(oldText);
            if (idx === -1) {
                // Try a weaker anchor match: use first and last 2 context lines
                const contextLines = hunkLines.filter(h => h.startsWith(' ')).map(h => h.substring(1));
                const head = contextLines.slice(0, 2).join('\n');
                const tail = contextLines.slice(-2).join('\n');
                if (head) {
                    const headIdx = content.indexOf(head);
                    if (headIdx !== -1) {
                        const searchStart = headIdx;
                        const tailIdx = tail ? content.indexOf(tail, searchStart) : -1;
                        if (tailIdx !== -1 && tailIdx >= headIdx) {
                            
                            // --- FIX STARTS HERE ---
                            // 'before' should be the content *before* the head anchor
                            const before = content.substring(0, headIdx);
                            // 'after' should be the content *after* the tail anchor
                            const after = content.substring(tailIdx + (tail ? tail.length : 0));
                            
                            // 'newCandidate' is the full new block (head + new middle + tail)
                            const newCandidate = head + newText.substring(head.length, newText.length - (tail ? tail.length : 0)) + (tail ? tail : '');
                            
                            // This now correctly assembles: (before) + (newCandidate) + (after)
                            return before + newCandidate + after;
                            // --- FIX ENDS HERE ---
                        }
                    }
                }
                return null;
            }
            return content.substring(0, idx) + newText + content.substring(idx + oldText.length);
        };

        for (const h of hunks) {
            const next = applyOne(src, h);
            if (next === null) {
                return null;
            }
            src = next;
        }
        return src;
    }


    /**
     * NEW: Helper function to strip ANSI codes.
     */
    private stripAnsiCodes(text: string): string {
        return text
            // Remove ANSI escape sequences (colors, cursor movement, etc.)
            .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
            // Remove OSC escape sequences (e.g., window title, or VS Code shell integration ]633;...)
            // Fixed: [0-9] -> [0-9]* to match multi-digit codes like 633
            .replace(/\x1b\][0-9]*;[^\x07]*\x07/g, '')
            // Remove Braille patterns commonly used for loading spinners (⠙⠹⠸...)
            .replace(/[\u2800-\u28FF]/g, '')
            // Remove control characters except newline, carriage return, and tab
            .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '')
            // Clean up excessive whitespace while preserving structure
            .replace(/\r\n/g, '\n')  // Normalize line endings
            .replace(/\r/g, '\n')     // Convert remaining \r to \n
            .replace(/\n{3,}/g, '\n\n'); // Max 2 consecutive newlines
    }

    private async scrapeTerminalBuffer(term: vscode.Terminal): Promise<{ buffer: string, error: string }> {
        let originalClipboard = '';
        let buffer = '';
        let errorMsg = '';

        try {
            originalClipboard = await vscode.env.clipboard.readText();
        } catch (e) {
            console.warn('[Terminal] Could not read clipboard before scraping.');
        }

        try {
            await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
            await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
            await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');
            buffer = await vscode.env.clipboard.readText();
        } catch (e: any) {
            console.error(`[Terminal] Failed to scrape terminal buffer: ${e.message}`);
            errorMsg = `Failed to capture terminal output: ${e.message}`;
        }

        try {
            await vscode.env.clipboard.writeText(originalClipboard);
        } catch (e) {
            console.warn('[Terminal] Could not restore clipboard after scraping.');
        }

        return { buffer: this.stripAnsiCodes(buffer), error: errorMsg };
    }

    /**
     * NEW: Fallback command execution using sendText and clipboard scrape
     */
    private async runFallbackCommand(term: vscode.Terminal, command: string): Promise<{ stdout: string, stderr: string }> {
        console.warn(`[Terminal] Using fallback 'sendText' for command: ${command}`);

        // Send the command
        term.sendText(command, true);

        // Wait 3 seconds. This is an arbitrary guess.
        await new Promise((resolve) => setTimeout(resolve, 3000));

    const { buffer, error } = await this.scrapeTerminalBuffer(term);
    const finalOutput = extractCommandOutput(buffer, command);

        return {
            stdout: finalOutput,
            stderr: error
        };
    }

    /**
     * Executes a shell command using Node.js child_process.spawn for live output.
     * Intercepts 'cd' commands to update the internal working directory.
     * Streams stdout/stderr to the sendUpdateCallback.
     */
    public async run_terminal_command(command: string): Promise<{ stdout: string, stderr: string }> {
        // 1. Ask for permission
        let allow = false;
        if (this.terminalCommandCallback) {
            allow = await this.terminalCommandCallback(command);
        } else {
            const result = await vscode.window.showInformationMessage(
                `The agent wants to run the following command:\n\n${command}\n\nDo you want to allow it?`,
                { modal: true },
                'Yes',
                'No'
            );
            allow = result === 'Yes';
        }

        if (!allow) {
            return { stdout: '', stderr: 'Command not allowed by user.' };
        }

        // 2. Stop any previous process
        await this.killRunningTerminalProcess();
        
        // 3. Get or create a terminal
        const term = this.ensureTerminal();
        term.show(true); // Show terminal with focus

        // 4. Wait for shell integration
        if (!term.shellIntegration) {
            console.log('[Terminal] Waiting for shell integration to initialize...');
            await new Promise<void>(resolve => {
                const disposable = vscode.window.onDidChangeTerminalShellIntegration(e => {
                    if (e.terminal === term && e.shellIntegration) {
                        console.log('[Terminal] Shell integration initialized via listener.');
                        disposable.dispose();
                        resolve();
                    }
                });
                // Failsafe timeout
                setTimeout(() => {
                    if (term.shellIntegration) {
                        console.log('[Terminal] Shell integration was ready after timeout check.');
                    } else {
                        console.warn('[Terminal] Shell integration timed out.');
                    }
                    disposable.dispose();
                    resolve();
                }, 3000); // 3-second wait
            });
        }
        
        // 5. Execute command: Primary path or Fallback path
        if (term.shellIntegration) {
            // --- PRIMARY (GOOD) PATH ---
            console.log('[Terminal] Shell integration is available. Running with stream API.');
            let currentExecution: vscode.TerminalShellExecution;
            try {
                currentExecution = term.shellIntegration.executeCommand(command);
                console.log('[Terminal] Executing command with shell integration:', command);
            } catch (error: any) {
                console.error(`[Terminal] Failed to execute command with shell integration: ${error.message}. Trying fallback.`);
                return await this.runFallbackCommand(term, command);
            }

            let output = '';
            let exitCode: number | undefined = undefined;
            let streamClosed = false;
            let timeoutTriggered = false;

            // Promise for the 'end' event
            const commandFinished = new Promise<'event'>(resolve => {
                const disposable = vscode.window.onDidEndTerminalShellExecution(event => {
                    if (event.execution === currentExecution) {
                        console.log(`[Terminal] onDidEndTerminalShellExecution fired. Exit code: ${event.exitCode}`);
                        exitCode = event.exitCode;
                        disposable.dispose();
                        resolve('event');
                    }
                });
            });

            // 6. Modified Loop: Use Inactivity Timeout instead of Total Timeout
            const stream = currentExecution.read();
            const iterator = stream[Symbol.asyncIterator]();
            console.log('[Terminal] Reading output stream manually...');

            // Configuration for timeouts
            const IDLE_TIMEOUT_MS = 15000; // 15 seconds of no output triggers timeout
            const ABSOLUTE_TIMEOUT_MS = 600000; // 10 minutes max absolute limit (failsafe)
            const startTime = Date.now();

            while (!streamClosed) {
                // Failsafe: Check absolute time limit
                if (Date.now() - startTime > ABSOLUTE_TIMEOUT_MS) {
                    console.warn(`[Terminal] Command hit absolute max timeout (${ABSOLUTE_TIMEOUT_MS}ms).`);
                    timeoutTriggered = true;
                    streamClosed = true;
                    break;
                }

                // Create a cancellable idle timeout for this specific iteration
                let idleTimer: NodeJS.Timeout;
                const idlePromise = new Promise<'timeout'>((resolve) => {
                    idleTimer = setTimeout(() => {
                        console.warn(`[Terminal] Inactivity timeout: No data for ${IDLE_TIMEOUT_MS}ms.`);
                        resolve('timeout');
                    }, IDLE_TIMEOUT_MS);
                });

                const nextChunkPromise = iterator.next(); // Promise<IteratorResult<string>>
                
                // Race: Data chunk vs Finished Event vs Idle Timeout
                const winner = await Promise.race([nextChunkPromise, commandFinished, idlePromise]);

                // Clear the idle timer immediately regardless of who won
                clearTimeout(idleTimer!);

                if (winner === 'event') {
                    // Event fired first. Command is done.
                    console.log('[Terminal] Event fired. Waiting 200ms for final stream data.');
                    await new Promise(r => setTimeout(r, 200)); 
                    streamClosed = true;
                } else if (winner === 'timeout') {
                    // Idle timeout fired.
                    console.warn('[Terminal] Idle Timeout fired. Breaking stream loop.');
                    timeoutTriggered = true;
                    streamClosed = true;
                } else if (winner.done) {
                    // Stream closed naturally (iterator finished).
                    console.log('[Terminal] Stream closed naturally.');
                    streamClosed = true;
                } else {
                    // We got data (winner is the chunk). 
                    // Loop continues, which creates a FRESH idle timer for the next chunk.
                    output += winner.value;
                    
                    // Optional: Send live updates to UI if needed
                    if (this.sendUpdateCallback) {
                        // this.sendUpdateCallback(winner.value);
                    }
                }
            }

            // 7. We've exited the loop.
            // Check if the event *still* hasn't fired (e.g., stream closed but event is delayed).
            if (exitCode === undefined) {
                console.log('[Terminal] Stream closed, waiting for event or 2s grace period...');
                await Promise.race([commandFinished, new Promise(r => setTimeout(r, 2000))]);
            }

            // 8. Process CWD change (best effort)
            try {
                const initialCwd = this.workingDirectory;
                const maxRetries = 5; // Poll for ~1 second max (5 * 200ms)
                const retryInterval = 200;

                for (let i = 0; i < maxRetries; i++) {
                    const currentCwdUri = (term.shellIntegration as any).cwd;
                    if (currentCwdUri) {
                        const newDir = currentCwdUri.fsPath || currentCwdUri.toString();
                        
                        // If the directory is different from what we had, it changed!
                        if (newDir && newDir !== initialCwd) {
                            console.log(`[Terminal] Directory changed from ${initialCwd} to ${newDir} (detected on attempt ${i + 1})`);
                            this.workingDirectory = newDir;
                            break; // Stop polling, we found the change
                        }
                    }

                    // Wait before next check to give VS Code time to update
                    if (i < maxRetries - 1) {
                        await new Promise(r => setTimeout(r, retryInterval));
                    }
                }
            } catch (error) {
                console.warn('[Terminal] Could not update CWD:', error);
            }
            
            // 9. Increment counter
            this.terminalCommandCount++;
            console.log(`[Terminal] Command completed (${this.terminalCommandCount}/${this.MAX_COMMANDS_PER_TERMINAL})`);

            // 10. Check results and decide on fallback
            let cleanStdout = this.stripAnsiCodes(output);
            let cleanStderr = '';

            if (!timeoutTriggered && output.length === 0 && exitCode === undefined) {
                // Total failure: Timed out/Ended with no stream data and no event.
                console.error('[Terminal] Stream failure (0 output, no exit code). Retrying with fallback scrape.');
                return await this.runFallbackCommand(term, command);
            }

            if (exitCode !== undefined && exitCode !== 0) {
                cleanStderr = `Command exited with code ${exitCode}`;
            } else if (exitCode === undefined) {
                // This means we timed out (idle or absolute), but we *have* the partial output
                const cause = timeoutTriggered ? "inactivity" : "unknown";
                cleanStderr = `Command stopped due to ${cause} timeout. Output may be incomplete.`;
            }

            if (timeoutTriggered) {
                console.warn('[Terminal] Timeout detected, attempting clipboard scrape for final output.');
                const { buffer, error } = await this.scrapeTerminalBuffer(term);
                const scrapedOutput = extractCommandOutput(buffer, command);
                if (scrapedOutput) {
                    cleanStdout = scrapedOutput;
                }
                if (error) {
                    cleanStderr = cleanStderr ? `${cleanStderr}\n${error}` : error;
                }
            }

            return { stdout: cleanStdout, stderr: cleanStderr };

        } else {
            // --- FALLBACK PATH ---
            console.warn('[Terminal] Shell integration NOT available. Using fallback (sendText + clipboard scrape).');
            return await this.runFallbackCommand(term, command);
        }
    }
    
    public async similar_search(query: string, limit: number = 8): Promise<object[]> {
        if (!state.table) {
            return [{ error: 'Database not initialized' }];
        }

        try {
            await initializeEmbedder(this.context);
            const embedding = await embedQuery(query);
            const results = await state.table.vectorSearch(embedding).limit(limit).toArray();
            return results.map(result => ({
                filePath: result.filePath,
                startLine: result.startLine,
                endLine: result.endLine,
                chunkType: result.chunkType,
                content: result.content,
                score: result._distance
            }));
        } catch (error: any) {
            return [{ error: error.message }];
        }
    }

    private getAbsolutePath(filePath: string): string {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }
        
        if (this.workingDirectory) {
            return path.join(this.workingDirectory, filePath);
        }
        
        if (vscode.workspace.workspaceFolders) {
            return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, filePath);
        }
        // This is a fallback, but the agent should be working in a workspace.
        return filePath;
    }
}

export class AgentService {
    private toolbox: ToolBox;
    private shouldStop = false;
    private currentAbortController?: AbortController;
    private terminalCommandCallback?: (command: string) => Promise<boolean>;
    private recentThoughts: string[] = []; // last up to 5 raw thoughts
    private summarizedArchive: string = ''; // cumulative summary of ALL prior (evicted) thoughts
    private summarizing: boolean = false;
    private readonly MAX_RECENT_THOUGHTS = 5;
    private pendingSummaryTimeout?: NodeJS.Timeout;

    constructor(context: vscode.ExtensionContext) {
        this.toolbox = new ToolBox(context);
    }

    public setTerminalCommandCallback(callback: (command: string) => Promise<boolean>) {
        this.terminalCommandCallback = callback;
        this.toolbox.setTerminalCommandCallback(callback);
    }

    public setWorkingDirectory(directory: string) {
        this.toolbox.setWorkingDirectory(directory);
    }

    private async summarizeEvictedThought(evicted: string, remainingRecent: string[], sendUpdate: (u: string)=>void, serverUrl: string, token: string) {
        // If this is the first eviction, show it directly as the previous thought summary without calling the endpoint.
        if (!this.summarizedArchive) {
            this.summarizedArchive = `[*] ${evicted}`;
            // Quiet UI: log to console instead of UI
            console.log('[ThoughtSummary] Initialized rolling summary with first evicted thought.');
            return;
        }

        // Debounce rapid consecutive evictions to batch them slightly
        if (this.pendingSummaryTimeout) {
            clearTimeout(this.pendingSummaryTimeout);
        }
        // Append the evicted thought directly without summarizing
        const needsNewline = this.summarizedArchive.length > 0 && !this.summarizedArchive.endsWith('\n');
        this.summarizedArchive += `${needsNewline ? '\n' : ''}[*] ${evicted}`;
        console.log(`[ThoughtSummary] Appended evicted thought. Summary length ${this.summarizedArchive.length}`);
        // If the rolling summary itself grows too large, ask for a shorter version.
        if (this.summarizedArchive.length > 10000) {
            await this.shortenArchiveIfTooLong(sendUpdate, serverUrl, token);
        }
    }

    private async shortenArchiveIfTooLong(sendUpdate: (u: string)=>void, serverUrl: string, token: string) {
        if (this.summarizing) { return; }
        if (!this.summarizedArchive || this.summarizedArchive.length <= 2000) { return; }
        try {
            this.summarizing = true;
            const prompt = `Shorten the following rolling summary to ~1200 characters while preserving all key decisions, constraints, unresolved items, and next actions. Use compact bullets or short paragraphs.\n\n${this.summarizedArchive}`;
            console.log('[ThoughtSummary] Shortening rolling summary (too long).');
            const resp = await fetch(serverUrl, { 
                method: 'POST', 
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                }, 
                body: JSON.stringify({ query: prompt })
            });
            if (!resp.ok) {
                console.warn(`[ThoughtSummary] Shorten request failed status ${resp.status}`);
                return;
            }
            const jr = await resp.json();
            let text: string = jr.response || '';
            const match = text.match(/```(?:markdown|text)?\n([\s\S]*?)```/);
            if (match && match[1]) { text = match[1]; }
            this.summarizedArchive = text.trim();
            console.log(`[ThoughtSummary] Shortened summary length ${this.summarizedArchive.length}`);
        } catch (e: any) {
            console.warn(`[ThoughtSummary] Error while shortening: ${e.message}`);
        } finally {
            this.summarizing = false;
        }
    }

    private async summarizeLongThought(rawThought: string, sendUpdate: (u: string)=>void, serverUrl: string, token: string) {
        try {
            const prompt = `Summarize the following agent thought into <= 400 characters, preserving concrete next actions, file targets, and decisions. Remove repetition.\n\n${rawThought}`;
            console.log(`[Thoughts] Summarizing the thought output`);
            const resp = await fetch(serverUrl, { 
                method: 'POST', 
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                }, 
                body: JSON.stringify({ query: prompt })
            });
            if (!resp.ok) {
                console.warn(`[Thoughts] Thought summarization failed with status ${resp.status}`);
                return;
            }
            const jr = await resp.json();
            let text: string = jr.response || '';
            const match = text.match(/```(?:markdown|text)?\n([\s\S]*?)```/);
            if (match && match[1]) { text = match[1]; }
            const condensed = text.trim();
            return condensed;
        } catch (e: any) {
            console.warn(`[Thoughts] Error summarizing long thought: ${e.message}`);
            return rawThought;
        }
    }

    private async summarizeOriginalPrompt(prompt: string, serverUrl: string, token: string): Promise<string> {
        // Define the character limit for the summary and for the fallback truncation.
        const SUMMARY_MAX_LENGTH = 50000;
        
        // Create a fallback response in case the summarization fails.
        const fallbackResponse = prompt.substring(0, SUMMARY_MAX_LENGTH) + 
                                "\n\n... [Original prompt was too long and summarization failed. The prompt has been truncated.] ...";
        
        if (prompt.length > 1000000) { return fallbackResponse; }

        try {
            const summarizationInstruction = `Summarize the following user request into a clear and concise objective for an AI agent. Focus on the primary goal, key constraints, and specific files or functions mentioned. The summary should be a direct command. Maximum ${SUMMARY_MAX_LENGTH} characters.\n\nOriginal Request:\n${prompt}`;
            
            console.log(`[AgentService] Summarizing original prompt.`);
            const resp = await fetch(serverUrl, { 
                method: 'POST', 
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                }, 
                body: JSON.stringify({ query: summarizationInstruction })
            });

            if (!resp.ok) {
                console.warn(`[AgentService] Prompt summarization failed with status ${resp.status}. Returning truncated prompt.`);
                return fallbackResponse; // Return truncated prompt on failure
            }

            const jr = await resp.json();
            let text: string = jr.response || '';
            const match = text.match(/```(?:markdown|text)?\n([\s\S]*?)```/);
            if (match && match[1]) { text = match[1]; }

            const condensed = text.trim();
            
            // If the model returns an empty summary, also use the truncated fallback.
            return condensed.length > 0 ? condensed : fallbackResponse;

        } catch (e: any) {
            console.warn(`[AgentService] Error summarizing original prompt: ${e.message}. Returning truncated prompt.`);
            return fallbackResponse; // Return truncated prompt on error
        }
    }

    private normalizeThought(t: string): string {
        return t.replace(/\s+/g, ' ').trim();
    }
    private async recordThought(thought: string | undefined, sendUpdate: (u: string)=>void, serverUrl: string, token: string) {
        if (!thought) { return; }
        const norm = this.normalizeThought(thought);
        if (!norm) { return; }
        // If same as the most recent stored thought, skip to avoid repetition noise
        const last = this.recentThoughts[this.recentThoughts.length - 1];
        if (last && this.normalizeThought(last) === norm) {
            // Quiet UI: skip duplicate without notifying UI
            return;
        }
        // If the thought is very long, temporarily truncate for display and kick off an async summarization
        // so the recent list gets a condensed version shortly after.
        let finalThought: any = norm;
        const LONG_THOUGHT_THRESHOLD = 1000;
        const isLong = finalThought.length > LONG_THOUGHT_THRESHOLD;
        if (isLong) {
            finalThought = await this.summarizeLongThought(finalThought, sendUpdate, serverUrl, token);
        }
        if (this.recentThoughts.length >= this.MAX_RECENT_THOUGHTS) {
            const evicted = this.recentThoughts.shift();
            if (evicted) {
                // Add to rolling summary (not losing content)
                const remaining = this.recentThoughts.slice();
                await this.summarizeEvictedThought(evicted, remaining, sendUpdate, serverUrl, token);
            }
        }
        this.recentThoughts.push(finalThought);
        // If long, summarize asynchronously and replace the truncated version in-place when ready.
    }

    private buildThoughtSections() {
        const thoughtsSection = this.recentThoughts.length ? `Recent Model Thoughts (most recent last):\n<recentModelThoughts>\n${this.recentThoughts.map((t,i)=>`[${i+1}] ${t}`).join('\n')}\n</recentModelThoughts>` : 'Recent Model Thoughts: \n<recentModelThoughts>(none yet)</recentModelThoughts>';
        const archiveSummarySection = this.summarizedArchive ? `Previous Thought Summary:\n<previousThoughtSummary>\n${this.summarizedArchive}\n</previousThoughtSummary>\n` : '';
        return { thoughtsSection, archiveSummarySection };
    }

    public getThoughtsDebug() {
        return { recentThoughts: this.recentThoughts.slice(), summarizedArchive: this.summarizedArchive };
    }

    public async processRequest(
        prompt: string, 
        serverUrl: string, 
        token: string, // <-- ADDED: Accept the token
        sendUpdate: (update: string) => void, 
        threadId: string | null
    ) {
        // Quiet UI: no initial debug to UI; log minimal info to console
        console.log(`[AgentService] processRequest start. WD=${this.toolbox.getWorkingDirectory() || 'Not set'} promptLen=${prompt.length}`);
        this.shouldStop = false;
        let history: { action: string, result: any }[] = [];
        const maxSteps = 60;
        // Preserve the original user request for all subsequent iterations.
        let originalPrompt = prompt;

        // --- Pass sendUpdate to ToolBox for streaming ---
        this.toolbox.setSendUpdateCallback(sendUpdate);
        // ---
        
        const PROMPT_LENGTH_THRESHOLD = 100000;
        if (originalPrompt.length > PROMPT_LENGTH_THRESHOLD) {
            originalPrompt = await this.summarizeOriginalPrompt(originalPrompt, serverUrl, token);
        }

        let currentInstruction = originalPrompt; // Instruction for the model (first step uses full prompt)
        
        let isFirstStep = true;
        for (let i = 0; i < maxSteps; i++) {
            if (this.shouldStop) {
                sendUpdate("❌ Stopped by user.");
                return;
            }
            if(isFirstStep) {
                this.recentThoughts = [];
                this.summarizedArchive = '';
            }
            console.log(`[Agent] Step ${i + 1}`);
            const { tool, args, thought } = await this.getNextActionFromModel(
                currentInstruction, 
                originalPrompt, 
                history, 
                sendUpdate, 
                serverUrl, 
                token, // <-- PASS: Pass token down
                threadId
            );
            await this.recordThought(thought, sendUpdate, serverUrl, token); // <-- PASS: Pass token down
            if (this.shouldStop) {
                sendUpdate("❌ Stopped by user.");
                return;
            }
            if (isFirstStep) {
                isFirstStep = false;
                // After first step, switch to continuation instruction while retaining originalPrompt separately.
                currentInstruction = "Continue with the next step based on the history to complete the original request.";
            }
            if (tool === 'finish') {
                sendUpdate(`✅ Done: ${args[0]}`);
                return;
            }
            if (tool === 'retry_with_valid_json') {
                history.push({ action: `invalid_json_response`, result: args[0] });
                continue; // retry loop
            }
            const availableTools = this.getToolDefinitions();
            const availableToolNames = availableTools.map(t => t.name);
            if (!availableToolNames.includes(tool) && !(this.toolbox as any)[tool]) {
                const errorMsg = `Unknown tool: ${tool}`;
                sendUpdate(`❌ ${errorMsg}`);
                history.push({ action: `unknown_tool(${tool})`, result: errorMsg });
                continue;
            }

            const { startMsg, doneMsg } = this.getToolMessages(tool, args, availableTools);
            if (startMsg) {
                sendUpdate(`⏳ ${startMsg}`);
            }
            try {
                // @ts-ignore
                const result = await this.toolbox[tool](...args);
                const resultString = JSON.stringify(result, null, 2);
                history.push({ action: `${tool}(${args.map((a: any) => JSON.stringify(a)).join(', ')})`, result: resultString });
                if (doneMsg) {
                    sendUpdate(`✅ ${doneMsg}`);
                }
            } catch (error: any) {
                const errorMessage = `Error executing ${tool}: ${error.message}`;
                if (doneMsg) {
                    sendUpdate(`❌ ${doneMsg} — ${error.message}`);
                } else {
                    sendUpdate(`❌ ${errorMessage}`);
                }
                console.warn(`Tool execution error at step ${i + 1}: ${error.message}`);
                console.warn(error.stack);
                history.push({ action: `${tool}(${args.map((a: any) => JSON.stringify(a)).join(', ')})`, result: errorMessage });
            }
        }
        sendUpdate("Agent stopped after reaching max steps.");
    }

    public stop() {
        this.shouldStop = true;
        if (this.currentAbortController) {
            this.currentAbortController.abort();
        }
    }

    private getToolDefinitions() {
        // <-- Updated descriptions and added the new tool -->
        return [
            { name: 'list_files', description: 'List files in the workspace. Provide an \'offset\' to get the next page of results. Default offset is 0 and increment by 1 to get the next results. Returns an object with files array, total count, and hasMore flag. Each call returns up to 10000 files.', args: [{ name: 'offset', type: 'number' }] },
            { name: 'search_files', description: 'Search for files by NAME or pattern only (does NOT search file contents).', args: [{ name: 'pattern', type: 'string' }] },
            { name: 'search_text', description: 'Search for a keyword across file CONTENTS. Returns file paths with matching line numbers and snippets.', args: [{ name: 'keyword', type: 'string' }, { name: 'maxFiles', type: 'number' }, { name: 'maxMatchesPerFile', type: 'number' }] },
            { name: 'read_file', description: 'Read the FULL content of a file at a given relative path. If the file is too long (>100000 chars), it returns an error message stating the total number of chunks. Use this first for reading file purposes.', args: [{ name: 'filePath', type: 'string' }] },
            { name: 'search_in_file', description: 'Search for a specific keyword within a single file (given relative path). This is the most efficient way to find relevant code in long files. Returns the matching lines with surrounding context.', args: [{ name: 'filePath', type: 'string' }, { name: 'keyword', type: 'string' }] },
            { name: 'read_file_chunk', description: `Read a specific chunk of a large file. Use this if read_file indicates the file is too long and you need to browse sequentially. read_file returns the total no. of chunks for that file`, args: [{ name: 'filePath', type: 'string' }, { name: 'chunkNumber', type: 'number' }] },
            { name: 'apply_file_change', description: 'Replaces the ENTIRE content of a file. Use this only when replacing the whole file, often after reading it fully. For smaller modifications, prefer apply_file_patch. Changes are applied instantly. Returns a status message.', args: [{ name: 'filePath', type: 'string' }, { name: 'newContent', type: 'string' }] },
            { name: 'apply_file_patch', description: 'Applies a patch (in standard `diff` format, like `git diff`) to modify an existing file. Use this for making targeted changes without needing the full file content, especially for large files read in chunks. Provide the relative filePath and the patch content. Returns a status message or an error if the patch cannot be applied.', args: [{ name: 'filePath', type: 'string' }, { name: 'patchContent', type: 'string' }] }, // <-- New tool definition
            { name: 'run_terminal_command', description: 'Run a shell command in the workspace. Asks for user permission first. Returns stdout and stderr. IMPORTANT: When you run "cd <directory>" command, the working directory is automatically updated for ALL subsequent file operations (read_file, apply_file_change, list_files, etc.). This means after "cd my-app", file paths like "src/App.js" will resolve to "my-app/src/App.js".', args: [{ name: 'command', type: 'string' }] },
            { name: 'similar_search', description: 'Perform semantic similarity search on the indexed codebase to find relevant code snippets. Useful for understanding code patterns or finding similar implementations. Returns list of matching chunks with metadata and similarity score.', args: [{ name: 'query', type: 'string' }, { name: 'limit', type: 'number' }] },
            { name: 'finish', description: 'Finishes the task with a message.', args: [{ name: 'message', type: 'string' }] }
        ];
    }

    private async getNextActionFromModel(
        currentInstruction: string, 
        originalPrompt: string, 
        history: any[], 
        sendUpdate: (update: string) => void, 
        serverUrl: string, 
        token: string,
        threadId: string | null
    ): Promise<{ tool: string, args: any[], thought: string }> {
    console.log("[AgentService] Asking the model for the next step...");
    console.log(`[AgentService] Making request to: ${serverUrl}`);

        const showInstruction = currentInstruction.trim() !== originalPrompt.trim();
        const currentInstructionSection = showInstruction ? currentInstruction: "This is your first iteration.";

        // Include current working directory information
        const workingDirInfo = this.toolbox.getWorkingDirectory() 
            ? `\nCURRENT WORKING DIRECTORY: ${this.toolbox.getWorkingDirectory()}\n- All file paths (read_file, apply_file_change, apply_file_patch, list_files, etc.) are relative to this directory\n- When you run 'cd' command, this directory updates automatically\n- File operations, terminal commands will use paths relative to this directory\n`
            : '';

        const systemPrompt = `You are an expert AI programmer agent.
Your goal is to complete the user's ORIGINAL request.
${workingDirInfo}
CRITICAL INSTRUCTIONS:
1. You must start by using the 'list_files' tool to get an idea about the codebase (use 'list_files' even though it was used in conversation history and not used in the current session)
2. You operate autonomously - make file changes immediately without asking permission
3. Use 'apply_file_change' to replace the ENTIRE file content. Use 'apply_file_patch' to apply a small modification using a diff patch.
4. Changes are applied instantly and user sees diffs with accept/reject buttons
5. NEVER ask "Should I..." or "Would you like me to..." - just do it
6. Complete the entire task by making all necessary changes 
7. When task is finished always test before calling 'finish' tool
8. Only use 'finish' when the task is completely done

IMPORTANT: Use tools efficiently to explore codebase:
- search_files(pattern) to find specific files by name/pattern (e.g., "separable" finds separable.py)
- list_files(offset) for paginated browsing when exploring structure. start with 0 and only increment one by one if has_more is true
- To list more files, you MUST increment the 'offset' parameter in 'list_files'
- list_files(0) gets first 10000 files, list_files(1) gets next 10000
- The response includes hasMore flag to indicate if there are more files

CRITICAL WORKFLOW FOR READING FILES:
1. Your first step to read a file MUST be the 'read_file' tool.
2. If 'read_file' returns an error like "File ... is too long ... It has been divided into X chunks", the file is too large to read at once.
3. If the file is too long, your NEXT step should usually be 'search_in_file' with a relevant keyword to find specific information.
4. Only use 'read_file_chunk(filePath, chunkNumber)' if you need to browse the file sequentially (e.g., starting with chunkNumber 1) after 'read_file' failed due to size. The error message from 'read_file' will tell you the total number of chunks available.

CRITICAL WORKFLOW FOR MODIFYING FILES:
1. For small files you read completely with 'read_file', modify the content in your thought process, and use 'apply_file_change' with the FULL NEW content.
2. For large files (where 'read_file' failed or you only read chunks/searched), identify the specific lines to change. Generate a patch in the standard 'diff' format (like 'git diff'). Use the 'apply_file_patch' tool with the filePath and the patch content.

CRITICAL INSTRUCTIONS FOR TESTING THE APPLICATION:
1. Consider the language or framework you are dealing with when testing
2. First check for any compilation errors. To accomplish this you can try compiling or building the application
3. Try running tests if any available. If not found or user denies testing just move on

You operate in a loop. In each step, choose the appropriate tool and execute it.
Do not ask for clarification or permission.

Tools:
${JSON.stringify(this.getToolDefinitions())}

Respond with a single JSON object with two keys: "thought" and "tool_call".
"thought" should be a string explaining your reasoning for the chosen action.
"tool_call" should be an object with two keys: "name" and "args".

Example 1 (single argument tool):
{
    "thought": "I need to see the files in the workspace to understand the project structure.",
    "tool_call": {
        "name": "list_files",
        "args": {"offset": 0}
    }
}

Example 2 (multi-argument tool):
{
    "thought": "The file 'folder/example.py' was too long to read fully. I need to search inside it for the 'header_rows' keyword to find where it's handled.",
    "tool_call": {
        "name": "search_in_file",
        "args": {
            "filePath": "folder/example.py",
            "keyword": "header_rows"
        }
    }
}

Example 3 (replace whole file):
{
    "thought": "I read the small configuration file config.json. I need to update the 'port' setting to 8080.",
    "tool_call": {
        "name": "apply_file_change",
        "args": {
            "filePath": "config.json",
            "newContent": "{\n  \"port\": 8080,\n  \"host\": \"localhost\"\n}"
        }
    }
}

Example 4 (apply patch to large file):
{
    "thought": "I searched in the large file 'main.py' and found the function 'process_data' on line 500. I need to add a logging statement inside it. I will generate a diff patch and apply it.",
    "tool_call": {
        "name": "apply_file_patch",
        "args": {
            "filePath": "main.py",
            "patchContent": "--- a/main.py\n+++ b/main.py\n@@ -501,6 +501,7 @@\n def process_data(data):\n   # existing code\n   result = data * 2\n+  print(f\"Processing data: {data}\") # Added logging\n   return result"
        }
    }
}`;

        const MODEL_TOTAL_CONTEXT_CHARS = 500000; // Approx. 125k tokens
        const HISTORY_CHAR_BUDGET = MODEL_TOTAL_CONTEXT_CHARS - systemPrompt.length - originalPrompt.length;
        let ENTRY_BUDGET = HISTORY_CHAR_BUDGET;
        const FAIR_ENTRY_BUDGET = (HISTORY_CHAR_BUDGET / history.length) * 2;

        let currentChars = 0;
        const truncatedHistory = [];

        // Loop backwards from the most recent entry to the oldest.
        for (let i = history.length - 1; i >= 0; i--) {
            const entry = history[i];

            // Truncate very long individual results to prevent any single entry from dominating.
            let result = entry.result;
            if (typeof result === 'string' && (result.length > ENTRY_BUDGET || result.length > FAIR_ENTRY_BUDGET)) {
                result = result.substring(0, ENTRY_BUDGET) + '... [TRUNCATED - content too long]';
            }

            const sanitizedEntry = { action: entry.action, result: result };
            const entryString = JSON.stringify(sanitizedEntry);

            // Check if adding this next entry would blow our budget.
            if (currentChars + entryString.length > HISTORY_CHAR_BUDGET) {
                // If so, we have enough history and can stop.
                break;
            }

            // Add the entry to the beginning of our new array to maintain the correct order.
            truncatedHistory.unshift(sanitizedEntry);
            currentChars += entryString.length;
            ENTRY_BUDGET -= currentChars;
        }

        const { thoughtsSection, archiveSummarySection } = this.buildThoughtSections();
        // Build an XML-delimited prompt for more reliable parsing
        const fullPrompt = 
`System Prompt:
<systemPrompt>
${systemPrompt}
</systemPrompt>

Original User Request:
<originalUserRequest>
${originalPrompt}
</originalUserRequest>

Current Instruction:
<currentInstruction>
${currentInstructionSection}
</currentInstruction>

${archiveSummarySection}\n${thoughtsSection}

Tool Call History (most recent last):
<toolCallHistory>
${JSON.stringify(truncatedHistory)}
</toolCallHistory>`;

        console.log(`[AgentService] Full prompt length: ${fullPrompt.length}, history: ${history.length} -> ${truncatedHistory.length}`);

        try {
            this.currentAbortController = new AbortController();
            
            console.log(`[AgentService] Making fetch request to: ${serverUrl}`);
            console.log(`[AgentService] Request payload length: ${JSON.stringify({ query: fullPrompt, thread_id: threadId }).length} characters`);
            
            const response = await fetch(serverUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ 
                    query: fullPrompt,
                    thread_id: threadId
                }),
                signal: this.currentAbortController.signal
            });

            console.log(`[AgentService] Received response with status: ${response.status}`);

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[AgentService] Server error: ${response.status} - ${errorText}`);
                if (response.status === 401) {
                     return {
                        thought: `Authentication failed. The user's token may be invalid.`,
                        tool: 'finish',
                        args: [`Authentication error: ${errorText}`]
                    };
                }
                return {
                    thought: `The model API call failed with status ${response.status}.`,
                    tool: 'finish',
                    args: [`Model API error: ${errorText}`]
                };
            }

            const jsonResponse = await response.json();
            console.log(`[AgentService] Response JSON keys: ${Object.keys(jsonResponse)}`);

            // Check if server returned an error
            if (jsonResponse.error) {
                // Check for the specific MAX_TOKENS error
                 const errorMessage = jsonResponse.error || '';
                 if (errorMessage.includes("finish_reason") && errorMessage.includes("2")) {
                     console.warn(`[AgentService] Model response truncated due to MAX_TOKENS.`);
                     return {
                         thought: "The previous response was cut short because it was too long. I need to be more concise or take smaller steps.",
                         tool: 'retry_with_valid_json', // Or potentially 'finish' if it happens too often
                         args: [`Model output truncated (MAX_TOKENS). Error: ${errorMessage}`]
                     };
                 }
                console.warn(`Server returned error: ${jsonResponse.error}`);
                return {
                    thought: "Server returned an error.",
                    tool: 'finish',
                    args: [`Server error: ${jsonResponse.error}`]
                };
            }

            let modelResponseText = jsonResponse.response;
            console.log(`[AgentService] Model response length: ${modelResponseText ? modelResponseText.length : 0}`);

            // Check if the response field is missing
            if (!modelResponseText) {
                console.warn(`[AgentService] Empty/missing response. Full: ${JSON.stringify(jsonResponse, null, 2)}`);
                return {
                    thought: "Server returned empty or missing response field.",
                    tool: 'finish',
                    args: [`Server returned empty response. Full response: ${JSON.stringify(jsonResponse)}`]
                };
            }

            // Check if the response is wrapped in markdown code blocks
            const jsonMatch = modelResponseText.match(/```(json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch && jsonMatch[2]) {
                console.log(`Found JSON in markdown, extracting...`);
                modelResponseText = jsonMatch[2];
            }
            console.log(`Parsing JSON response...`);
            
            let modelOutput;
            try {
                // First try parsing as-is
                modelOutput = JSON.parse(modelResponseText);
            } catch (firstError: any) {
                try {
                    // Simple approach: find and fix the specific issue with unescaped characters
                    // The most common issue is unescaped newlines and quotes in the "thought" field
                    let fixedJson = modelResponseText;
                    
                    // Look for the pattern: "thought": "some text with unescaped chars"
                    fixedJson = fixedJson.replace(/"thought":\s*"([^"]*(?:\\.[^"]*)*)"(?=\s*[,}])/g, (match: string, content: string) => {
                        // Properly escape the content
                        const escaped = content
                            .replace(/\\/g, '\\\\')  // Escape backslashes first
                            .replace(/"/g, '\\"')    // Escape quotes
                            .replace(/\n/g, '\\n')   // Escape newlines
                            .replace(/\r/g, '\\r')   // Escape carriage returns
                            .replace(/\t/g, '\\t');  // Escape tabs
                        return `"thought": "${escaped}"`;
                    });
                    
                    modelOutput = JSON.parse(fixedJson);
                } catch (secondError: any) {
                    // If still failing, try removing problematic content after the JSON
                    try {
                        // Look for the JSON object boundaries and extract just that
                        const jsonStart = modelResponseText.indexOf('{');
                        const jsonEnd = modelResponseText.lastIndexOf('}');
                        console.warn(`JSON parsing failed after attempts: ${firstError.message || firstError}`);
                        console.warn(`Full raw response: ${modelResponseText}`);
                        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
                            const extractedJson = modelResponseText.substring(jsonStart, jsonEnd + 1);
                            modelOutput = JSON.parse(extractedJson);
                        } else {
                            throw new Error('Could not find valid JSON boundaries');
                        }
                    } catch (thirdError: any) {
                        const errorMessage = `Failed to parse model response as JSON. The model returned malformed text. Error: ${firstError.message || firstError}. Full response: ${modelResponseText}`;
                        console.warn(`[Agent Error] (JSON parsing error) ${errorMessage}`);
                        return {
                            thought: "The last response was not valid JSON. I must correct my output format and try again.",
                            tool: 'retry_with_valid_json',
                            args: [`JSON parsing error: ${errorMessage}`]
                        };
                    }
                }
            }
            console.log(`Parsed model output keys: ${Object.keys(modelOutput)}`);
            
            // Validate model output structure
            if (!modelOutput.tool_call) {
                console.warn(`Model output missing tool_call field`);
                return {
                    thought: modelOutput.thought || "Model response missing tool_call",
                    tool: 'finish',
                    args: [`Invalid model response: missing tool_call field`]
                };
            }
            
            if (!modelOutput.tool_call.name) {
                console.warn(`Model output missing tool_call.name field`);
                return {
                    thought: modelOutput.thought || "Model response missing tool name",
                    tool: 'finish',
                    args: [`Invalid model response: missing tool_call.name field`]
                };
            }
            
            const toolName = modelOutput.tool_call.name;
            let args = modelOutput.tool_call.args;
            console.log(`Tool name: ${toolName}, args type: ${typeof args}`);

            // Convert args from object to array based on tool definition
            if (!Array.isArray(args) && typeof args === 'object' && args !== null) {
                const toolDef = this.getToolDefinitions().find(t => t.name === toolName);
                if (toolDef && toolDef.args) {
                    args = toolDef.args.map((argDef: any) => {
                        const value = args[argDef.name];
                        // Handle optional offset default for list_files
                        if (value === undefined && argDef.name === 'offset') {
                            return 0;
                        }
                        // Handle optional chunkNumber default for read_file_chunk
                        if (value === undefined && argDef.name === 'chunkNumber') {
                            return 1;
                        }
                        // Handle other potential defaults if needed
                        return value;
                    });
                    console.log(`Converted object args to array: ${JSON.stringify(args)}`);
                } else {
                    // If no tool definition found or no args defined, convert object values to array
                    args = Object.values(args);
                    console.log(`Converted object values to array: ${JSON.stringify(args)}`);
                }
            } else if (!Array.isArray(args)) {
                args = [];
                console.log(`No args provided, using empty array`);
            }

            console.log(`Final result - tool: ${toolName}, args: ${JSON.stringify(args)}, thought length: ${modelOutput.thought?.length || 0}`);

            return {
                thought: modelOutput.thought,
                tool: toolName,
                args: args
            };

        } catch (error: any) {
            this.currentAbortController = undefined;
            console.warn(`Error in getNextActionFromModel: ${error.message}`);
            
            if (error.name === 'AbortError') {
                console.log(`Request was aborted`);
                return {
                    thought: "Request was stopped by user.",
                    tool: 'finish',
                    args: ["Request was stopped by user."]
                };
            }
            
            console.warn(`Network or parsing error: ${error.message}`);
            return {
                thought: "There was an error calling the model.",
                tool: 'finish',
                args: [`Error calling model: ${error.message}`]
            };
        } finally {
            this.currentAbortController = undefined;
        }
    }

    // Map tool name/args to brief user-facing messages
    private getToolMessages(toolName: string, args: any[], toolDefs: Array<{name: string, args?: Array<{name: string}>}>): { startMsg: string, doneMsg: string } {
        const def = toolDefs.find(t => t.name === toolName);
        let argMap: Record<string, any> = {};
        if (def && Array.isArray(def.args)) {
            argMap = def.args.reduce((acc, defArg, idx) => {
                acc[defArg.name] = args[idx];
                return acc;
            }, {} as Record<string, any>);
        }
        const truncate = (s: any, n = 60) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) + '…' : s) : s);
        switch (toolName) {
            case 'read_file': {
                const fp = argMap.filePath ?? args[0];
                return { startMsg: `Reading file ${fp}`, doneMsg: `Read file ${fp}` };
            }
            case 'read_file_chunk': {
                const fp = argMap.filePath ?? args[0];
                const chunk = argMap.chunkNumber ?? args[1] ?? 1;
                return { startMsg: `Reading chunk ${chunk} of ${fp}`, doneMsg: `Read chunk ${chunk} of ${fp}` };
            }
            case 'search_files': {
                const p = argMap.pattern ?? args[0];
                return { startMsg: `Searching files "${truncate(p)}"`, doneMsg: `Searched files` };
            }
            case 'list_files': {
                const off = argMap.offset ?? args[0];
                return { startMsg: `Listing files (offset ${off})`, doneMsg: `Listed files` };
            }
            case 'search_text': {
                const k = argMap.keyword ?? args[0];
                return { startMsg: `Searching text "${truncate(k)}"`, doneMsg: `Searched text` };
            }
            case 'search_in_file': {
                const fp = argMap.filePath ?? args[0];
                const k = argMap.keyword ?? args[1];
                return { startMsg: `Searching "${truncate(k)}" in ${fp}`, doneMsg: `Searched in ${fp}` };
            }
            case 'apply_file_change': {
                const fp = argMap.filePath ?? args[0];
                return { startMsg: `Applying change to ${fp}`, doneMsg: `Applied change to ${fp}` };
            }
             case 'apply_file_patch': {
                const fp = argMap.filePath ?? args[0];
                return { startMsg: `Applying patch to ${fp}`, doneMsg: `Applied patch to ${fp}` };
            }
            case 'run_terminal_command': {
                const cmd = argMap.command ?? args[0];
                return { startMsg: `Running command: ${truncate(cmd)}`, doneMsg: `Ran command: ${truncate(cmd)}` };
            }
            case 'similar_search': {
                const q = argMap.query ?? args[0];
                return { startMsg: `Semantic search "${truncate(q)}"`, doneMsg: `Semantic search done` };
            }
            default:
                return { startMsg: `Running ${toolName}`, doneMsg: `${toolName} done` };
        }
    }
}