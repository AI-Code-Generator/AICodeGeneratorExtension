import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { IndexFlatL2, Index, IndexFlatIP, MetricType } from 'faiss-node';
import { CodeParser } from './Parser';
import * as fsSync from 'fs';
import { initializeSQLite, sqliteDb } from './Sqlite';

interface CodeChunkMetadata {
    id?: number;
    content: string;
    filePath: string;
    startLine: number;
    endLine: number;
    chunkType: string;
    embedding_index: number;
}

let embedder: any = null;
const EMBEDDING_DIM = 768;
const FAISS_INDEX_FILENAME = 'workspace_index.faiss';
let STORAGEPATH: any = null;
// let vectorIndex: IndexFlatL2 | null = null;

export const state = {
    vectorIndex: null as IndexFlatL2 | null
};

export const bulkState = {
    metadataBuffer: [] as CodeChunkMetadata[],
    batchSize: 100,
    currentEmbeddingIndex: 0
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
                //const chunks: string[] = chunkByLines(content);
                const chunks = CodeParser.parseCode(content, fullPath);

                await initializeEmbedder();

                for (const chunk of chunks) {
                    // Generate embedding for the chunk
                    const embedding = await embedText(chunk.content);
                    // store in the chunks in faiss vector db       
                    await saveFaiss(embedding, {
                        content: chunk.content,
                        filePath: fullPath,
                        startLine: chunk.startLine || 0,
                        endLine: chunk.endLine || 0,
                        chunkType: chunk.type || 'unknown'
                    });
                }
            }
        }
        await flushRemainingMetadata();
        writeToFaiss();
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
    const embeddings = Array.from(output[0].data);
    return embeddings;
}

export async function indexWorkspaceFiles(storageUri: vscode.Uri, excludeDirs = ['node_modules', '.git', 'dist', 'build']): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return [];
    }

    STORAGEPATH = storageUri;
    await initializeSQLite(storageUri);
    initializeFaiss(storageUri);
    
    const rootDirectory = workspaceFolders[0].uri.fsPath;
    const files = await readFilesRecursive(rootDirectory, excludeDirs);
    console.log(`Found ${files.length} files.`);
    return files;
}

// Naively chunk text by lines
function chunkByLines(text: string, linesPerChunk = 3) {
    const lines = text.split("\n").map(line => line.trim()).filter(line => line.length > 0);
    let chunks = [];

    for (let i = 0; i < lines.length; i += linesPerChunk) {
        chunks.push(lines.slice(i, i + linesPerChunk).join("\n"));
    }

    return chunks;
}

function initializeFaiss(storageUri: vscode.Uri) {
    try {
        const faissIndexStoragePath = path.join(storageUri.fsPath, FAISS_INDEX_FILENAME);
        fsSync.accessSync(faissIndexStoragePath);
        state.vectorIndex = IndexFlatL2.read(faissIndexStoragePath);
    } catch (error) {
        console.log('Faiss index file not found or error loading, creating a new one.');
        state.vectorIndex = new IndexFlatL2(EMBEDDING_DIM); // <===== check this error handling part
        // If creating a new Faiss index, ensure metadata is also cleared (if it could be out of sync)
        if (sqliteDb.db) {
            sqliteDb.db.run('DELETE FROM metadata', (err) => {
                if (err) {
                    console.error("Failed to clear metadata table:", err);
                } else {
                    console.log("New Faiss index, cleared metadata table.");
                }
            });
        }
    }
}

async function saveFaiss(embedding: any[], metadata: Omit<CodeChunkMetadata, 'id' | 'embedding_index'>) {
    if (!state.vectorIndex) {
        state.vectorIndex = new IndexFlatL2(EMBEDDING_DIM);
    }

    if (embedding.length !== EMBEDDING_DIM) {
        throw new Error(`Invalid embedding dimension. Expected ${EMBEDDING_DIM}, got ${embedding.length}`);
    }

    state.vectorIndex.add(embedding);
    const all = state.vectorIndex.ntotal();

    bulkState.metadataBuffer.push({
        ...metadata,
        embedding_index: bulkState.currentEmbeddingIndex
    });
    
    bulkState.currentEmbeddingIndex++;

    // Save in batches
    if (bulkState.metadataBuffer.length >= bulkState.batchSize) {
        await saveBulkMetadata();
    }
}

// Bulk save metadata to SQLite
async function saveBulkMetadata(): Promise<void> {
    if (!sqliteDb?.db || bulkState.metadataBuffer.length === 0) {
        return;
    }

    return new Promise((resolve, reject) => {
        const stmt = sqliteDb.db!.prepare(`
            INSERT INTO metadata (content, file_path, start_line, end_line, type, embedding_index)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        sqliteDb.db!.serialize(() => {
            sqliteDb.db!.run('BEGIN TRANSACTION', (err) => {
                if (err) {
                    stmt.finalize();
                    reject(err);
                    return;
                }

                try {
                    // Use synchronous run instead of async
                    for (const chunk of bulkState.metadataBuffer) {
                        stmt.run([
                            chunk.content,
                            chunk.filePath,
                            chunk.startLine,
                            chunk.endLine,
                            chunk.chunkType,
                            chunk.embedding_index
                        ]);
                    }

                    sqliteDb.db!.run('COMMIT', (err) => {
                        stmt.finalize();
                        if (err) {
                            reject(err);
                        } else {
                            console.log(`Saved ${bulkState.metadataBuffer.length} metadata entries to database`);
                            bulkState.metadataBuffer = [];
                            resolve();
                        }
                    });
                } catch (error) {
                    console.error('Failed to insert metadata:', error);
                    sqliteDb.db!.run('ROLLBACK', () => {
                        stmt.finalize();
                        reject(error);
                    });
                }
            });
        });
    });
}

// Function to flush remaining metadata
export async function flushRemainingMetadata() {
    if (bulkState.metadataBuffer.length > 0) {
        await saveBulkMetadata();
    }
}

function writeToFaiss() {
    const faissIndexStoragePath = path.join(STORAGEPATH.fsPath, FAISS_INDEX_FILENAME);
    state.vectorIndex?.write(faissIndexStoragePath);
}

// Function to get metadata by embedding index
export function getMetadataByEmbeddingIndex(embeddingIndex: number): Promise<CodeChunkMetadata | null> {
    return new Promise((resolve, reject) => {
        if (!sqliteDb?.db) {
            resolve(null);
            return;
        }

        sqliteDb.db.get(
            'SELECT * FROM metadata WHERE embedding_index = ?',
            [embeddingIndex],
            (err, row) => {
                if (err) {
                    console.error('Failed to get metadata:', err);
                    reject(err);
                } else {
                    resolve(row as CodeChunkMetadata || null);
                }
            }
        );
    });
}

export async function similaritySearch(text: string) {
    if (!text) {
        return null;
    }
    const embeddedText: any[] = await embedText(text);
    if (!embeddedText) {
        return null;
    }

    const result = state.vectorIndex?.search(embeddedText, 8);
    if (!result) {
        return null;
    }

    // Get metadata for each result (now async)
    const resultsWithMetadata = await Promise.all(
        result.labels.map(async (embeddingIndex: number, i: number) => {
            const metadata = await getMetadataByEmbeddingIndex(embeddingIndex);
            return {
                score: result.distances[i],
                embeddingIndex,
                metadata
            };
        })
    );

    return resultsWithMetadata;
}