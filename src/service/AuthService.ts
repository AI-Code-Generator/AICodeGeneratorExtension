// src/service/AuthManager.ts
import * as vscode from 'vscode';

const AUTH_TOKEN_KEY = 'aiCodeAssist.authToken';

export class AuthManager {
    private static instance: AuthManager;
    private constructor(private readonly context: vscode.ExtensionContext) {}

    public static getInstance(context?: vscode.ExtensionContext): AuthManager {
        if (!AuthManager.instance) {
            if (!context) {
                throw new Error('AuthManager must be initialized with context first');
            }
            AuthManager.instance = new AuthManager(context);
        }
        return AuthManager.instance;
    }

    public async getToken(): Promise<string | undefined> {
        try {
            return await this.context.secrets.get(AUTH_TOKEN_KEY);
        } catch (error) {
            console.error('Error getting auth token:', error);
            return undefined;
        }
    }

    public async setToken(token: string): Promise<void> {
        try {
            await this.context.secrets.store(AUTH_TOKEN_KEY, token);
        } catch (error) {
            console.error('Error storing auth token:', error);
        }
    }

    public async clearToken(): Promise<void> {
        try {
            await this.context.secrets.delete(AUTH_TOKEN_KEY);
        } catch (error) {
            console.error('Error clearing auth token:', error);
        }
    }

    /**
     * Tries to parse the user ID from the JWT token.
     * Note: This does NOT verify the token's signature.
     * It's only for display/logging purposes.
     * The server is responsible for verification.
     */
    public getUserIdFromToken(token: string): string | null {
        try {
            const payloadBase64 = token.split('.')[1];
            if (!payloadBase64) {
                return null;
            }
            const payloadJson = Buffer.from(payloadBase64, 'base64').toString('ascii');
            const payload = JSON.parse(payloadJson);
            return payload.sub_id || null; // 'sub_id' is what we set in main.py
        } catch (e) {
            console.error('Failed to parse user ID from token', e);
            return null;
        }
    }
}