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
// MiniLM (all-MiniLM-L6-v2) outputs 384-d embeddings
const EMBEDDING_DIM = 384;
// Use a dimensioned table name to avoid schema conflicts when switching models
const LANCEDB_TABLE_NAME = 'code_chunks';
const FILE_TRACKING_TABLE = 'file_tracking';
let STORAGEPATH: any = null;
let CURRENT_PROJECT_KEY: string | null = null;
// Conservative char cap for embedder input (~8k tokens headroom)
const MAX_EMBED_INPUT_CHARS = 4000;

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

export async function initializeEmbedder() {
    if (!embedder) {
        const { pipeline } = await import('@huggingface/transformers');
    // Switch to MiniLM (Transformers.js compatible model id)
    embedder = await pipeline('feature-extraction', 'sentence-transformers/all-MiniLM-L6-v2', {
            dtype: 'fp32',
            device: 'cpu'
        });
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

// File extensions to exclude from indexing (config files, documentation, etc.)
const EXCLUDED_EXTENSIONS = new Set([
    '.gitattributes', '.gitmodules',
    '.pdf',
    '.lock', '.log', '.tmp', '.temp',
    '.env', '.env.local', '.env.development', '.env.production',
    '.min.js', '.min.css', '.map',
    '.ico', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
    '.woff', '.woff2', '.ttf', '.eot',
    '.zip', '.tar', '.gz', '.rar', '.7z'
]);

// File names to exclude (regardless of extension)
const EXCLUDED_FILENAMES = new Set([
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    '.DS_Store', 'Thumbs.db'
]);

// Preferred code file extensions to prioritize
const CODE_EXTENSIONS = new Set([
    '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.vue', '.svelte', '.astro',
    '.py', '.rb', '.go', '.rs', '.java', '.kt',
    '.c', '.cpp', '.h', '.hpp',
    '.cs', '.php', '.swift',
    '.html', '.css', '.scss', '.sass', '.less',
    '.sql', '.graphql', '.gql'
]);

function shouldIndexFile(filePath: string): boolean {
    const fileName = path.basename(filePath);
    const extension = path.extname(filePath).toLowerCase();
    
    // Check if filename is excluded
    if (EXCLUDED_FILENAMES.has(fileName) || EXCLUDED_FILENAMES.has(fileName.toLowerCase())) {
        return false;
    }
    
    // Check if extension is excluded
    if (EXCLUDED_EXTENSIONS.has(extension)) {
        return false;
    }
    
    // Check for files without extension that should be excluded
    if (!extension && EXCLUDED_EXTENSIONS.has(fileName)) {
        return false;
    }
    
    // Prioritize known code file extensions
    if (CODE_EXTENSIONS.has(extension)) {
        return true;
    }
    
    // For files without recognized extensions, be more conservative
    // Only include if they're not in our exclude list and seem code-like
    if (!extension) {
        // Include files like 'Dockerfile', shell scripts without extensions, etc.
        const codeKeywords = ['script', 'dockerfile', 'makefile', 'rakefile'];
        return codeKeywords.some(keyword => fileName.toLowerCase().includes(keyword));
    }
    
    return false;
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
            } else if (shouldIndexFile(fullPath)) {
                results.push(fullPath);
                const content: string = await fs.readFile(fullPath, 'utf8');

                const shouldProcess = await shouldProcessFile(fullPath, content);

                if (shouldProcess) {
                    const chunks = CodeParser.parseCode(content, fullPath);

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
            } else {
                console.log(`Skipping excluded file: ${fullPath}`);
            }
        }

        await flushRemainingMetadata();
        await flushRemainingFileTracking();

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

export async function embedText(text: string): Promise<number[]> {
    if (!embedder) {
        throw new Error("Embedder not initialized. Call initializeEmbedder() first.");
    }

    // Trim overly long inputs; MiniLM doesn't require a task prefix
    const safeText = text.length > MAX_EMBED_INPUT_CHARS ? text.slice(0, MAX_EMBED_INPUT_CHARS) : text;

    const output = await embedder(safeText, {
        pooling: "mean",
        normalize: true
    });

    const embeddings = Array.from(output[0].data) as number[];
    return embeddings;
}

// Embed a user query using the query-specific task prefix to match document embeddings
export async function embedQuery(query: string): Promise<number[]> {
    if (!embedder) {
        throw new Error("Embedder not initialized. Call initializeEmbedder() first.");
    }

    const safeQuery = query.length > MAX_EMBED_INPUT_CHARS ? query.slice(0, MAX_EMBED_INPUT_CHARS) : query;
    
    const output = await embedder(safeQuery, {
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
    await removeDeletedFiles(rootDirectory, files, excludeDirs);
    const endTime = Date.now();

    console.log(`Found ${files.length} files. Indexing completed in ${(endTime - startTime) / 1000} seconds.`);
    return files;
}

export async function indexSingleFile(fileUri: vscode.Uri, storageUri: vscode.Uri): Promise<boolean> {
    const filePath = fileUri.fsPath;
    
    try {
        // Skip excluded directories
        const excludeDirs = ['node_modules', '.git', 'dist', 'build'];
        if (isInExcludedDir(filePath, excludeDirs)) {
            return false;
        }

        // Skip excluded file types
        if (!shouldIndexFile(filePath)) {
            console.log(`Skipping excluded file type: ${filePath}`);
            return false;
        }

        // Make sure DB is initialized
        if (!state.db) {
            STORAGEPATH = storageUri;
            await initializeLanceDB(storageUri);
        }
        
        // Read file content
        const content = await fs.readFile(filePath, 'utf8');
        
        // Check if we need to process this file
        const shouldProcess = await shouldProcessFile(filePath, content);
        
        if (shouldProcess) {
            const chunks = CodeParser.parseCode(content, filePath);
            console.log(`Processing changed file: ${filePath}`);
            
            await initializeEmbedder();
            
            if (state.table) {
                await state.table.delete(`\`filePath\` = '${filePath.replace(/'/g, "''")}'`);
            }
            
            for (const chunk of chunks) {
                const embedding = await embedText(chunk.content);
                
                await saveLanceDB({
                    content: chunk.content,
                    filePath: filePath,
                    startLine: chunk.startLine || 0,
                    endLine: chunk.endLine || 0,
                    chunkType: chunk.type || 'unknown',
                    vector: embedding,
                    contentHash: calculateContentHash(chunk.content),
                    lastIndexed: Date.now()
                });
            }
            
            await updateFileTracking(filePath, content);
            await flushRemainingMetadata();
            await flushRemainingFileTracking();
            
            return true;
        } else {
            console.log(`Skipping unchanged file: ${filePath}`);
            return false;
        }
    } catch (error) {
        console.error(`Error indexing file ${filePath}:`, error);
        return false;
    }
}

export async function deleteSingleFile(uri: vscode.Uri, storageUri: vscode.Uri): Promise<void> {
    const filePath = uri.fsPath;

    // Skip excluded directories
    const excludeDirs = ['node_modules', '.git', 'dist', 'build'];
    if (isInExcludedDir(filePath, excludeDirs)) {
        return;
    }

    // Skip if not an indexable file type
    if (!shouldIndexFile(filePath)) {
        console.log(`Skipping deletion for excluded file type: ${filePath}`);
        return;
    }

    // Initialize DB if needed
    if (!state.db) {
        STORAGEPATH = storageUri;
        await initializeLanceDB(storageUri);
    }

    try {
        // Delete chunks from code_chunks table
        if (state.table) {
            await state.table.delete(`\`filePath\` = '${filePath.replace(/'/g, "''")}'`);
        }

        // Delete from file_tracking table
        if (state.fileTrackingTable) {
            await state.fileTrackingTable.delete(`\`filePath\` = '${filePath.replace(/'/g, "''")}'`);
        }

        console.log(`Deleted index data for file: ${filePath}`);
    } catch (error) {
        console.error(`Error deleting index data for ${filePath}:`, error);
        throw error;
    }
}

function getProjectKey(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return null;
    }
    const root = workspaceFolders[0].uri.fsPath;
    return crypto.createHash('sha1').update(root).digest('hex').slice(0,16);
}

async function initializeLanceDB(storageUri: vscode.Uri) {
    try {
        const projectKey = getProjectKey();
        const lanceDbPath = path.join(storageUri.fsPath, 'lancedb', projectKey || 'default');

        // If project changed, reset cached handles so new connection is created
        if (CURRENT_PROJECT_KEY && projectKey && CURRENT_PROJECT_KEY !== projectKey) {
            state.db = null;
            state.table = null;
            state.fileTrackingTable = null;
        }

        CURRENT_PROJECT_KEY = projectKey || null;
        state.db = await lancedb.connect(lanceDbPath);

        const tableNames = await state.db.tableNames();

        if (tableNames.includes(LANCEDB_TABLE_NAME)) {
            state.table = await state.db.openTable(LANCEDB_TABLE_NAME);
            console.log(`Loaded existing LanceDB table for project ${CURRENT_PROJECT_KEY}`);
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
            console.log(`Created new LanceDB table for project ${CURRENT_PROJECT_KEY}`);
        }

        if (tableNames.includes(FILE_TRACKING_TABLE)) {
            state.fileTrackingTable = await state.db.openTable(FILE_TRACKING_TABLE);
            console.log(`Loaded existing file tracking table for project ${CURRENT_PROJECT_KEY}`);
        } else {
            const sampleData = [{
                filePath: 'sample/path',
                lastModified: Date.now(),
                contentHash: 'sample'
            }];

            state.fileTrackingTable = await state.db.createTable(FILE_TRACKING_TABLE, sampleData);
            await state.fileTrackingTable.delete('\`filePath\` = "sample/path"');
            console.log(`Created new file tracking table for project ${CURRENT_PROJECT_KEY}`);
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

export interface SimilaritySearchResultMetadata {
    id: string;
    filePath: string;
    startLine: number;
    endLine: number;
    chunkType: string;
    content: string;
    score: number;
}

export async function similaritySearch(text: string, limit: number = 8): Promise<SimilaritySearchResultMetadata[] | null> {
    if (!text || !state.table) {
        return null;
    }

    try {
        await initializeEmbedder();
        // Use query embedding prefix for search queries
        const embeddedText = await embedQuery(text);

        const results = await state.table
            .vectorSearch(embeddedText)
            .limit(limit)
            .toArray();

        return results.map(result => ({
            id: result.id,
            filePath: result.filePath,
            startLine: result.startLine,
            endLine: result.endLine,
            chunkType: result.chunkType,
            content: result.content,
            score: result._distance
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