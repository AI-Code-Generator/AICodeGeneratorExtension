import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

export async function readFilesRecursive(directory: string, excludeList: string[] = []): Promise<string[]> {
    let results: string[] = [];
    
    try {
        const files = await fs.readdir(directory, { withFileTypes: true });
        
        for (const file of files) {
            const fullPath = path.join(directory, file.name);
            
            // Skip excluded directories
            if (excludeList.includes(file.name)) {
                continue;
            }
            
            if (file.isDirectory()) {
                const subFiles = await readFilesRecursive(fullPath, excludeList);
                results = results.concat(subFiles);
            } else {
                results.push(fullPath);
            }
        }
    } catch (error) {
        console.error('Error reading directory:', error);
    }
    
    return results;
}

export async function indexWorkspaceFiles(excludeDirs = ['node_modules', '.git', 'dist', 'build']): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return [];
    }
    
    const rootDirectory = workspaceFolders[0].uri.fsPath;
    const files = await readFilesRecursive(rootDirectory, excludeDirs);
    console.log(`Found ${files.length} files.`);
    return files;
}
