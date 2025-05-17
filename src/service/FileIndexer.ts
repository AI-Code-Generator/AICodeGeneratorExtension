import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { IndexFlatL2, Index, IndexFlatIP, MetricType } from 'faiss-node';
import { CodeParser } from './Parser';

let embedder: any = null;
const EMBEDDING_DIM = 768;
let vectorIndex: IndexFlatL2 | null = null;

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
                    await saveFaiss(embedding);
                }
            }
        }
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

// Naively chunk text by lines
function chunkByLines(text: string, linesPerChunk = 3) {
    const lines = text.split("\n").map(line => line.trim()).filter(line => line.length > 0);
    let chunks = [];

    for (let i = 0; i < lines.length; i += linesPerChunk) {
        chunks.push(lines.slice(i, i + linesPerChunk).join("\n"));
    }

    return chunks;
}

async function saveFaiss(embedding: any[]) {
    if (!vectorIndex) {
        vectorIndex = new IndexFlatL2(EMBEDDING_DIM);
    }

    if (embedding.length !== EMBEDDING_DIM) {
        throw new Error(`Invalid embedding dimension. Expected ${EMBEDDING_DIM}, got ${embedding.length}`);
    }

    vectorIndex.add(embedding);
}