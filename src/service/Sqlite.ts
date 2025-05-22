import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

const METADATA_DB_FILENAME = 'metadata.sqlite';

export const sqliteDb = {
    db: null as Database.Database | null
};

export function initializeSQLite(storageUri: vscode.Uri) {
    try {
        fs.mkdirSync(storageUri.fsPath, { recursive: true });
    } catch (error) {
        console.error("Failed to create storage directory:", error);
    }

    try {
        const metadataDbPath = path.join(storageUri.fsPath, METADATA_DB_FILENAME);
        sqliteDb.db = new Database(metadataDbPath);
    
        sqliteDb.db.exec(`
            CREATE TABLE IF NOT EXISTS metadata (
                vector_id INTEGER PRIMARY KEY,
                file_path TEXT NOT NULL,
                content TEXT NOT NULL,
                type TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL
            );
        `);

    } catch (error) {
        console.error('Failed to initialize or connect to metadata SQLite database:', error);
        sqliteDb.db = null;
    }
}
