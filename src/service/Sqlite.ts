import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import sqlite3 from 'sqlite3';

const METADATA_DB_FILENAME = 'metadata.sqlite';

export const sqliteDb = {
    db: null as sqlite3.Database | null
};

export function initializeSQLite(storageUri: vscode.Uri): Promise<void> {
    return new Promise((resolve, reject) => {
        try {
            fs.mkdirSync(storageUri.fsPath, { recursive: true });
        } catch (error) {
            console.error("Failed to create storage directory:", error);
        }

        try {
            const metadataDbPath = path.join(storageUri.fsPath, METADATA_DB_FILENAME);
            sqliteDb.db = new sqlite3.Database(metadataDbPath, (err) => {
                if (err) {
                    console.error('Failed to initialize SQLite database:', err);
                    sqliteDb.db = null;
                    reject(err);
                    return;
                }

                sqliteDb.db!.run(`
                    CREATE TABLE IF NOT EXISTS metadata (
                        vector_id INTEGER PRIMARY KEY,
                        file_path TEXT NOT NULL,
                        content TEXT NOT NULL,
                        type TEXT NOT NULL,
                        start_line INTEGER NOT NULL,
                        end_line INTEGER NOT NULL,
                        embedding_index INTEGER
                    );
                `, (err) => {
                    if (err) {
                        console.error('Failed to create table:', err);
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        } catch (error) {
            console.error('Failed to initialize SQLite database:', error);
            sqliteDb.db = null;
            reject(error);
        }
    });
}
