import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import * as lancedb from '@lancedb/lancedb';
import { CodeParser } from './Parser';
import * as crypto from 'crypto';

interface FileTrackingData {
    filePath: string;
    lastModified: number;
    contentHash: string;
}

interface CodeChunkMetadata {
    id?: string;
    content: string;
    filePath: string;
    startLine: number;
    endLine: number;
    chunkType: string;
    vector: number[];
    contentHash?: string;
    lastIndexed?: number;
    [key: string]: any;
}

let embedder: any = null;
const EMBEDDING_DIM = 768;
const LANCEDB_TABLE_NAME = 'code_chunks';
const FILE_TRACKING_TABLE = 'file_tracking';
let STORAGEPATH: any = null;

export const state = {
    db: null as lancedb.Connection | null,
    table: null as lancedb.Table | null,
    fileTrackingTable: null as lancedb.Table | null
};

export const bulkState = {
    metadataBuffer: [] as Record<string, any>[],
    fileTrackingBuffer: [] as Record<string, any>[],
    batchSize: 100
};

async function initializeEmbedder() {
    if (!embedder) {
        const { pipeline } = await import('@huggingface/transformers');
        embedder = await pipeline('feature-extraction', 'nomic-ai/nomic-embed-text-v1.5');
    }
}

function calculateContentHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
}

async function shouldProcessFile(filePath: string, content: string): Promise<boolean> {
    if (!state.fileTrackingTable) {
        return true;
    }

    const contentHash = calculateContentHash(content);

    try {
        const results = await state.fileTrackingTable
            .query()
            .where(`\`filePath\` = '${filePath.replace(/'/g, "''")}'`)
            .toArray();

        if (results.length === 0) {
            return true;
        }

        const fileInfo = results[0] as FileTrackingData;
        return fileInfo.contentHash !== contentHash;
    } catch (error) {
        console.error(`Error checking file ${filePath}:`, error);
        return true;
    }
}

async function updateFileTracking(filePath: string, content: string): Promise<void> {
    if (!state.fileTrackingTable) {
        return;
    }

    const contentHash = calculateContentHash(content);
    const lastModified = Date.now();

    bulkState.fileTrackingBuffer.push({
        filePath,
        lastModified,
        contentHash
    });

    if (bulkState.fileTrackingBuffer.length >= bulkState.batchSize) {
        await saveFileTrackingBatch();
    }
}

async function saveFileTrackingBatch(): Promise<void> {
    if (!state.fileTrackingTable || bulkState.fileTrackingBuffer.length === 0) {
        return;
    }

    try {
        for (const fileInfo of bulkState.fileTrackingBuffer) {
            await state.fileTrackingTable.delete(`\`filePath\` = '${fileInfo.filePath.replace(/'/g, "''")}'`);
        }

        await state.fileTrackingTable.add(bulkState.fileTrackingBuffer);
        bulkState.fileTrackingBuffer = [];
    } catch (error) {
        console.error('Failed to save file tracking data:', error);
    }
}

export async function readFilesRecursive(directory: string, excludeList: string[] = []): Promise<string[]> {
    let results: string[] = [];

    try {
        const files = await fs.readdir(directory, { withFileTypes: true });

        for (const file of files) {
            const fullPath = path.join(directory, file.name);

            if (excludeList.includes(file.name)) {
                continue;
            }

            if (file.isDirectory()) {
                const subFiles = await readFilesRecursive(fullPath, excludeList);
                results = results.concat(subFiles);
            } else {
                results.push(fullPath);
                const content: string = await fs.readFile(fullPath, 'utf8');

                const shouldProcess = await shouldProcessFile(fullPath, content);

                if (shouldProcess) {
                    const chunks = CodeParser.parseCode(content, fullPath);
                    console.log(`Processing changed/new file: ${fullPath}`);

                    await initializeEmbedder();

                    if (state.table) {
                        await state.table.delete(`\`filePath\` = '${fullPath.replace(/'/g, "''")}'`);
                    }

                    for (const chunk of chunks) {
                        const embedding = await embedText(chunk.content);

                        await saveLanceDB({
                            content: chunk.content,
                            filePath: fullPath,
                            startLine: chunk.startLine || 0,
                            endLine: chunk.endLine || 0,
                            chunkType: chunk.type || 'unknown',
                            vector: embedding,
                            contentHash: calculateContentHash(chunk.content),
                            lastIndexed: Date.now()
                        });
                    }

                    await updateFileTracking(fullPath, content);
                } else {
                    console.log(`Skipping unchanged file: ${fullPath}`);
                }
            }
        }

        await flushRemainingMetadata();
        await flushRemainingFileTracking();

        await removeDeletedFiles(directory, results, excludeList);
    } catch (error) {
        console.error('Error reading directory:', error);
    }

    return results;
}

async function removeDeletedFiles(rootDir: string, currentFiles: string[], excludeList: string[]): Promise<void> {
    if (!state.fileTrackingTable || !state.table) {
        return;
    }

    try {
        const trackedFiles = await state.fileTrackingTable.query().toArray();
        const currentFilePaths = new Set(currentFiles);

        for (const fileInfo of trackedFiles) {
            const filePath = fileInfo.filePath;

            if (!currentFilePaths.has(filePath) && !isInExcludedDir(filePath, excludeList)) {
                console.log(`Removing deleted file data: ${filePath}`);

                await state.table.delete(`\`filePath\` = '${filePath.replace(/'/g, "''")}'`);
                await state.fileTrackingTable.delete(`\`filePath\` = '${filePath.replace(/'/g, "''")}'`);
            }
        }
    } catch (error) {
        console.error('Error removing deleted files:', error);
    }
}

function isInExcludedDir(filePath: string, excludeList: string[]): boolean {
    return excludeList.some(dir => filePath.includes(`/${dir}/`) || filePath.includes(`\\${dir}\\`));
}

async function embedText(text: string): Promise<number[]> {
    if (!embedder) {
        throw new Error("Embedder not initialized. Call initializeEmbedder() first.");
    }

    const output = await embedder(text, {
        pooling: "mean",
        normalize: true
    });

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
    const startTime = Date.now();
    const files = await readFilesRecursive(rootDirectory, excludeDirs);
    const endTime = Date.now();

    console.log(`Found ${files.length} files. Indexing completed in ${(endTime - startTime) / 1000} seconds.`);
    return files;
}

async function initializeLanceDB(storageUri: vscode.Uri) {
    try {
        const lanceDbPath = path.join(storageUri.fsPath, 'lancedb');
        state.db = await lancedb.connect(lanceDbPath);

        const tableNames = await state.db.tableNames();

        if (tableNames.includes(LANCEDB_TABLE_NAME)) {
            state.table = await state.db.openTable(LANCEDB_TABLE_NAME);
            console.log('Loaded existing LanceDB table');
        } else {
            const sampleData = [{
                id: 'sample',
                content: 'sample content',
                filePath: 'sample/path',
                startLine: 0,
                endLine: 0,
                chunkType: 'sample',
                contentHash: 'sample',
                lastIndexed: Date.now(),
                vector: new Array(EMBEDDING_DIM).fill(0)
            }];

            state.table = await state.db.createTable(LANCEDB_TABLE_NAME, sampleData);
            await state.table.delete('id = "sample"');
            console.log('Created new LanceDB table');
        }

        if (tableNames.includes(FILE_TRACKING_TABLE)) {
            state.fileTrackingTable = await state.db.openTable(FILE_TRACKING_TABLE);
            console.log('Loaded existing file tracking table');
        } else {
            const sampleData = [{
                filePath: 'sample/path',
                lastModified: Date.now(),
                contentHash: 'sample'
            }];

            state.fileTrackingTable = await state.db.createTable(FILE_TRACKING_TABLE, sampleData);
            await state.fileTrackingTable.delete('\`filePath\` = "sample/path"');
            console.log('Created new file tracking table');
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

    const id = `${metadata.filePath}:${metadata.startLine}-${metadata.endLine}`;

    const record: Record<string, any> = {
        id,
        ...metadata
    };

    bulkState.metadataBuffer.push(record);

    if (bulkState.metadataBuffer.length >= bulkState.batchSize) {
        await saveBulkMetadata();
    }
}

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

export async function flushRemainingMetadata() {
    if (bulkState.metadataBuffer.length > 0) {
        await saveBulkMetadata();
    }
}

export async function flushRemainingFileTracking() {
    if (bulkState.fileTrackingBuffer.length > 0) {
        await saveFileTrackingBatch();
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
            score: result._distance,
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

export async function getAllEntries(): Promise<CodeChunkMetadata[]> {
    if (!state.table) {
        return [];
    }

    try {
        const results = await state.table.query().toArray();
        return results;
    } catch (error) {
        console.error('Error getting all entries:', error);
        return [];
    }
}

export async function clearAllData(): Promise<void> {
    if (!state.db) {
        return;
    }

    try {
        if (state.table) {
            await state.table.delete('id IS NOT NULL');
        }

        if (state.fileTrackingTable) {
            await state.fileTrackingTable.delete('\`filePath\` IS NOT NULL');
        }

        console.log('Cleared all data from LanceDB');
    } catch (error) {
        console.error('Error clearing data:', error);
        throw error;
    }
}