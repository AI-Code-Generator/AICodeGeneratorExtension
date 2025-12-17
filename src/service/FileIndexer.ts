import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import * as lancedb from '@lancedb/lancedb';
import { CodeParser } from './Parser';
import * as crypto from 'crypto';
import { EXCLUDED_DIRS } from './constants';

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
// Threshold for determining if a file is "small" enough to return entirely
// Files under this line count will have their full content returned instead of just chunks
const SMALL_FILE_THRESHOLD_LINES = 150;
// Default number of neighbor chunks to include before/after matched chunk in large files
const DEFAULT_NEIGHBOR_COUNT = 2;

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

export async function initializeEmbedder(context: vscode.ExtensionContext) {
    if (embedder) {
        return;
    }

    try {
        // Construct the full, platform-independent path to your bundled model folder
        const modelPath = vscode.Uri.joinPath(
            context.extensionUri,
            'resources',
            'models',
            'all-MiniLM-L6-v2'
        ).fsPath;

        const { pipeline } = await import('@huggingface/transformers');

        // Tell the pipeline to load the model from your local folder
        embedder = await pipeline('feature-extraction', modelPath, {
            dtype: 'fp32',
            device: 'cpu'
        });

        console.log('Embedder initialized successfully from local bundled model.');

    } catch (error) {
        console.error('Failed to initialize local embedder:', error);
        vscode.window.showErrorMessage(
            'Failed to load the local AI model. Similarity search and other features may be disabled. Please try reinstalling the extension.'
        );
        embedder = null; // Prevent further attempts
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
    '.pdf', '.po', '.mo',
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
    '.sql', '.graphql', '.gql', '.txt', '.md'
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
    
    return true;
}

export async function readFilesRecursive(directory: string, context: vscode.ExtensionContext, excludeList: string[] = []): Promise<string[]> {
    let results: string[] = [];

    try {
        const files = await fs.readdir(directory, { withFileTypes: true });

        for (const file of files) {
            const fullPath = path.join(directory, file.name);

            if (excludeList.includes(file.name)) {
                console.log(`Skipping excluded directory: ${fullPath}`);
                continue;
            }

            if (file.isDirectory()) {
                const subFiles = await readFilesRecursive(fullPath, context, excludeList);
                console.log(`Indexing directory: ${fullPath} started`);
                results = results.concat(subFiles);
            } else if (shouldIndexFile(fullPath)) {
                results.push(fullPath);
                const content: string = await fs.readFile(fullPath, 'utf8');

                const shouldProcess = await shouldProcessFile(fullPath, content);

                if (shouldProcess) {
                    const chunks = CodeParser.parseCode(content, fullPath);

                    await initializeEmbedder(context);

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

export async function indexWorkspaceFiles(storageUri: vscode.Uri, context: vscode.ExtensionContext, excludeDirs = EXCLUDED_DIRS): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return [];
    }

    STORAGEPATH = storageUri;
    await initializeLanceDB(storageUri);

    const rootDirectory = workspaceFolders[0].uri.fsPath;
    const startTime = Date.now();
    const files = await readFilesRecursive(rootDirectory, context, excludeDirs);
    await removeDeletedFiles(rootDirectory, files, excludeDirs);
    const endTime = Date.now();

    console.log(`Found ${files.length} files. Indexing completed in ${(endTime - startTime) / 1000} seconds.`);
    return files;
}

export async function indexSingleFile(fileUri: vscode.Uri, storageUri: vscode.Uri, context: vscode.ExtensionContext): Promise<boolean> {
    const filePath = fileUri.fsPath;
    
    try {
        // Skip excluded directories
        if (isInExcludedDir(filePath, EXCLUDED_DIRS)) {
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
            
            await initializeEmbedder(context);
            
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
    if (isInExcludedDir(filePath, EXCLUDED_DIRS)) {
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

export interface EnhancedSearchResult {
    filePath: string;
    content: string;
    startLine: number;
    endLine: number;
    chunkType: string;
    score: number;
    retrievalMode: 'full_file' | 'chunk_with_neighbors';
    neighborChunks?: {
        before: SimilaritySearchResultMetadata[];
        after: SimilaritySearchResultMetadata[];
    };
}

export interface EnhancedSearchOptions {
    smallFileThreshold?: number;
    neighborCount?: number;
}

/**
 * Get the line count of a file
 */
async function getFileLineCount(filePath: string): Promise<number> {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        return content.split('\n').length;
    } catch (error) {
        console.error(`Error reading file for line count: ${filePath}`, error);
        return Infinity; // Treat as large file if we can't read it
    }
}

/**
 * Read the full content of a file
 */
async function getFullFileContent(filePath: string): Promise<string> {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch (error) {
        console.error(`Error reading full file: ${filePath}`, error);
        return '';
    }
}

/**
 * Get neighboring chunks from the same file based on line ranges
 */
async function getNeighborChunks(
    filePath: string,
    startLine: number,
    endLine: number,
    neighborCount: number = DEFAULT_NEIGHBOR_COUNT
): Promise<{ before: SimilaritySearchResultMetadata[]; after: SimilaritySearchResultMetadata[] }> {
    if (!state.table) {
        return { before: [], after: [] };
    }

    try {
        const escapedPath = filePath.replace(/'/g, "''");

        // Get chunks that end before the current chunk starts (preceding neighbors)
        const beforeResults = await state.table
            .query()
            .where(`\`filePath\` = '${escapedPath}' AND \`endLine\` < ${startLine}`)
            .toArray();

        // Sort by endLine descending to get the closest chunks first
        const sortedBefore = beforeResults
            .sort((a, b) => b.endLine - a.endLine)
            .slice(0, neighborCount)
            .reverse(); // Reverse to maintain line order

        // Get chunks that start after the current chunk ends (following neighbors)
        const afterResults = await state.table
            .query()
            .where(`\`filePath\` = '${escapedPath}' AND \`startLine\` > ${endLine}`)
            .toArray();

        // Sort by startLine ascending to get the closest chunks first
        const sortedAfter = afterResults
            .sort((a, b) => a.startLine - b.startLine)
            .slice(0, neighborCount);

        const mapToMetadata = (result: any): SimilaritySearchResultMetadata => ({
            id: result.id,
            filePath: result.filePath,
            startLine: result.startLine,
            endLine: result.endLine,
            chunkType: result.chunkType,
            content: result.content,
            score: 0 // Neighbors don't have a relevance score
        });

        return {
            before: sortedBefore.map(mapToMetadata),
            after: sortedAfter.map(mapToMetadata)
        };
    } catch (error) {
        console.error(`Error getting neighbor chunks for ${filePath}:`, error);
        return { before: [], after: [] };
    }
}

export async function similaritySearch(text: string, context: vscode.ExtensionContext, limit: number = 8): Promise<SimilaritySearchResultMetadata[] | null> {
    if (!text || !state.table) {
        return null;
    }

    try {
        await initializeEmbedder(context);
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

/**
 * Enhanced similarity search with parent retrieval
 * - For small files (< threshold lines): returns the entire file content
 * - For large files: returns the matched chunk with surrounding neighbor chunks
 */
export async function enhancedSimilaritySearch(
    text: string,
    context: vscode.ExtensionContext,
    limit: number = 8,
    options?: EnhancedSearchOptions
): Promise<EnhancedSearchResult[] | null> {
    if (!text || !state.table) {
        return null;
    }

    const threshold = options?.smallFileThreshold ?? SMALL_FILE_THRESHOLD_LINES;
    const neighborCount = options?.neighborCount ?? DEFAULT_NEIGHBOR_COUNT;

    try {
        await initializeEmbedder(context);
        const embeddedText = await embedQuery(text);

        const results = await state.table
            .vectorSearch(embeddedText)
            .limit(limit)
            .toArray();

        // Group results by file path to avoid duplicate file reads
        const fileGroups = new Map<string, typeof results>();
        for (const result of results) {
            const existing = fileGroups.get(result.filePath) || [];
            existing.push(result);
            fileGroups.set(result.filePath, existing);
        }

        // Cache file line counts to avoid repeated reads
        const fileLineCountCache = new Map<string, number>();
        // Cache full file contents for small files
        const fullFileContentCache = new Map<string, string>();

        const enhancedResults: EnhancedSearchResult[] = [];
        const processedFullFiles = new Set<string>(); // Track files already returned in full

        for (const result of results) {
            const filePath = result.filePath;

            // Get or compute line count
            if (!fileLineCountCache.has(filePath)) {
                fileLineCountCache.set(filePath, await getFileLineCount(filePath));
            }
            const lineCount = fileLineCountCache.get(filePath)!;

            if (lineCount <= threshold) {
                // Small file: return full content (but only once per file)
                if (processedFullFiles.has(filePath)) {
                    continue; // Skip duplicate entries for the same small file
                }
                processedFullFiles.add(filePath);

                // Get or read full file content
                if (!fullFileContentCache.has(filePath)) {
                    fullFileContentCache.set(filePath, await getFullFileContent(filePath));
                }
                const fullContent = fullFileContentCache.get(filePath)!;

                enhancedResults.push({
                    filePath,
                    content: fullContent,
                    startLine: 1,
                    endLine: lineCount,
                    chunkType: 'full_file',
                    score: result._distance,
                    retrievalMode: 'full_file'
                });
            } else {
                // Large file: return chunk with neighbors
                const neighbors = await getNeighborChunks(
                    filePath,
                    result.startLine,
                    result.endLine,
                    neighborCount
                );

                // Combine neighbor content with the main chunk for a richer context
                let combinedContent = '';

                // Add before neighbors
                for (const neighbor of neighbors.before) {
                    combinedContent += `// --- Context (lines ${neighbor.startLine}-${neighbor.endLine}) ---\n`;
                    combinedContent += neighbor.content + '\n\n';
                }

                // Add main chunk
                combinedContent += `// --- Matched chunk (lines ${result.startLine}-${result.endLine}) ---\n`;
                combinedContent += result.content;

                // Add after neighbors
                for (const neighbor of neighbors.after) {
                    combinedContent += '\n\n';
                    combinedContent += `// --- Context (lines ${neighbor.startLine}-${neighbor.endLine}) ---\n`;
                    combinedContent += neighbor.content;
                }

                // Calculate the effective line range
                const effectiveStartLine = neighbors.before.length > 0
                    ? neighbors.before[0].startLine
                    : result.startLine;
                const effectiveEndLine = neighbors.after.length > 0
                    ? neighbors.after[neighbors.after.length - 1].endLine
                    : result.endLine;

                enhancedResults.push({
                    filePath,
                    content: combinedContent.trim(),
                    startLine: effectiveStartLine,
                    endLine: effectiveEndLine,
                    chunkType: result.chunkType,
                    score: result._distance,
                    retrievalMode: 'chunk_with_neighbors',
                    neighborChunks: neighbors
                });
            }
        }

        // Sort by score (lower distance = better match)
        return enhancedResults.sort((a, b) => a.score - b.score);
    } catch (error) {
        console.error('Error in enhanced similarity search:', error);
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