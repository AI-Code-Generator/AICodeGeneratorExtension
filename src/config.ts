import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env file from the project root
dotenv.config({ path: path.join(__dirname, '../.env') });

export const config = {
    serverUrl: process.env.SERVER_URL || 'http://localhost:5000'
};