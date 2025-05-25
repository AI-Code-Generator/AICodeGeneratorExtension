import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import * as lancedb from '@lancedb/lancedb';
import { CodeParser } from './Parser';

interface CodeChunkMetadata {
    id?: string;
    content: string;
    filePath: string;
    startLine: number;
    endLine: number;
    chunkType: string;
    vector: number[];
    [key: string]: any; // Add index signature for LanceDB compatibility
}

let embedder: any = null;
const EMBEDDING_DIM = 768;
const LANCEDB_TABLE_NAME = 'code_chunks';
let STORAGEPATH: any = null;

export const state = {
    db: null as lancedb.Connection | null,
    table: null as lancedb.Table | null
};

export const bulkState = {
    metadataBuffer: [] as Record<string, any>[], // Change to Record<string, any>[]
    batchSize: 100
};

async function initializeEmbedder() {
    if (!embedder) {
        const { pipeline } = await import('@huggingface/transformers');
        embedder = await pipeline('feature-extraction', 'nomic-ai/nomic-embed-text-v1.5');
    }
}

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
                const content: string = await fs.readFile(fullPath, 'utf8');
                const chunks = CodeParser.parseCode(content, fullPath);

                await initializeEmbedder();

                for (const chunk of chunks) {
                    // Generate embedding for the chunk
                    const embedding = await embedText(chunk.content);
                    // Store in LanceDB
                    await saveLanceDB({
                        content: chunk.content,
                        filePath: fullPath,
                        startLine: chunk.startLine || 0,
                        endLine: chunk.endLine || 0,
                        chunkType: chunk.type || 'unknown',
                        vector: embedding
                    });
                }
            }
        }
        await flushRemainingMetadata();
    } catch (error) {
        console.error('Error reading directory:', error);
    }
    
    return results;
}

async function embedText(text: string) {
    if (!embedder) {
        throw new Error("Embedder not initialized. Call initializeEmbedder() first.");
    }

    const output = await embedder(text, { 
        pooling: "mean",
        normalize: true
    });
    // Convert from ONNX type tensor to a normal js one
    const embeddings = Array.from(output[0].data) as number[];
    return embeddings;
}

export async function indexWorkspaceFiles(storageUri: vscode.Uri, excludeDirs = ['node_modules', '.git', 'dist', 'build']): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return [];
    }

    STORAGEPATH = storageUri;
    await initializeLanceDB(storageUri);
    
    const rootDirectory = workspaceFolders[0].uri.fsPath;
    const files = await readFilesRecursive(rootDirectory, excludeDirs);
    console.log(`Found ${files.length} files.`);
    return files;
}

async function initializeLanceDB(storageUri: vscode.Uri) {
    try {
        const lanceDbPath = path.join(storageUri.fsPath, 'lancedb');
        state.db = await lancedb.connect(lanceDbPath);
        
        // Check if table exists
        const tableNames = await state.db.tableNames();
        
        if (tableNames.includes(LANCEDB_TABLE_NAME)) {
            state.table = await state.db.openTable(LANCEDB_TABLE_NAME);
            console.log('Loaded existing LanceDB table');
        } else {
            // Create new table with sample data to define schema
            const sampleData = [{
                id: 'sample',
                content: 'sample content',
                filePath: 'sample/path',
                startLine: 0,
                endLine: 0,
                chunkType: 'sample',
                vector: new Array(EMBEDDING_DIM).fill(0)
            }];
            
            state.table = await state.db.createTable(LANCEDB_TABLE_NAME, sampleData);
            // Delete the sample data
            await state.table.delete('id = "sample"');
            console.log('Created new LanceDB table');
        }
    } catch (error) {
        console.error('Failed to initialize LanceDB:', error);
        throw error;
    }
}

async function saveLanceDB(metadata: Omit<CodeChunkMetadata, 'id'>) {
    if (!state.table) {
        throw new Error('LanceDB table not initialized');
    }

    if (metadata.vector.length !== EMBEDDING_DIM) {
        throw new Error(`Invalid embedding dimension. Expected ${EMBEDDING_DIM}, got ${metadata.vector.length}`);
    }

    // Generate a unique ID
    const id = `${metadata.filePath}:${metadata.startLine}-${metadata.endLine}:${Date.now()}`;

    const record: Record<string, any> = {
        id,
        ...metadata
    };

    bulkState.metadataBuffer.push(record);

    // Save in batches
    if (bulkState.metadataBuffer.length >= bulkState.batchSize) {
        await saveBulkMetadata();
    }
}

// Bulk save metadata to LanceDB
async function saveBulkMetadata(): Promise<void> {
    if (!state.table || bulkState.metadataBuffer.length === 0) {
        return;
    }

    try {
        await state.table.add(bulkState.metadataBuffer);
        console.log(`Saved ${bulkState.metadataBuffer.length} entries to LanceDB`);
        bulkState.metadataBuffer = [];
    } catch (error) {
        console.error('Failed to save bulk metadata to LanceDB:', error);
        throw error;
    }
}

// Function to flush remaining metadata
export async function flushRemainingMetadata() {
    if (bulkState.metadataBuffer.length > 0) {
        await saveBulkMetadata();
    }
}

export async function similaritySearch(text: string, limit: number = 8) {
    if (!text || !state.table) {
        return null;
    }

    try {
        await initializeEmbedder();
        const embeddedText = await embedText(text);
        
        const results = await state.table
            .vectorSearch(embeddedText)
            .limit(limit)
            .toArray();

        return results.map(result => ({
            score: result._distance, // LanceDB returns distance in _distance field
            metadata: {
                id: result.id,
                content: result.content,
                filePath: result.filePath,
                startLine: result.startLine,
                endLine: result.endLine,
                chunkType: result.chunkType
            }
        }));
    } catch (error) {
        console.error('Error in similarity search:', error);
        return null;
    }
}

// Helper function to get all entries (for debugging)
export async function getAllEntries(): Promise<CodeChunkMetadata[]> {
    if (!state.table) {
        return [];
    }

    try {
        // Use query() to get all entries
        const results = await state.table.query().toArray();
        return results;
    } catch (error) {
        console.error('Error getting all entries:', error);
        return [];
    }
}

// Helper function to clear all data
export async function clearAllData(): Promise<void> {
    if (!state.table) {
        return;
    }

    try {
        // Use delete with proper SQL WHERE clause
        await state.table.delete('id IS NOT NULL'); // Delete all rows
        console.log('Cleared all data from LanceDB');
    } catch (error) {
        console.error('Error clearing data:', error);
        throw error;
    }
}