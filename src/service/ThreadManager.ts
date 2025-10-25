// src/service/ThreadManager.ts
import * as vscode from 'vscode';
import { AuthManager } from './AuthService'; // Import AuthManager

export interface Thread {
    id: string;
    title: string;
    projectPath: string;
    createdAt: number;
    updatedAt: number;
    messages: Array<{
        id: string;
        type: 'user' | 'assistant';
        content: string;
        timestamp: number;
    }>;
}

export interface ThreadMetadata {
    id: string;
    title: string;
    projectPath: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
}

export class ThreadManager {
    private static instance: ThreadManager;
    private context: vscode.ExtensionContext;
    private currentThreadId: string | null = null;
    private baseUrl: string;
    private authManager: AuthManager; // Add AuthManager

    private constructor(context: vscode.ExtensionContext, baseUrl: string, authManager: AuthManager) {
        this.context = context;
        this.baseUrl = baseUrl;
        this.authManager = authManager; // Store AuthManager
    }

    public static getInstance(context?: vscode.ExtensionContext, baseUrl?: string, authManager?: AuthManager): ThreadManager {
        if (!ThreadManager.instance) {
            if (!context || !baseUrl || !authManager) {
                throw new Error('ThreadManager must be initialized with context, baseUrl, and authManager first');
            }
            ThreadManager.instance = new ThreadManager(context, baseUrl, authManager);
        }
        return ThreadManager.instance;
    }

    private generateThreadId(): string {
        try {
            const maybeCrypto = (globalThis as any).crypto;
            if (maybeCrypto?.randomUUID) {
                return `thread_${maybeCrypto.randomUUID()}`;
            }
        } catch (e) {
            // fall back silently
        }
        return `thread_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }

    private generateMessageId(): string {
        try {
            const maybeCrypto = (globalThis as any).crypto;
            if (maybeCrypto?.randomUUID) {
                return `msg_${maybeCrypto.randomUUID()}`;
            }
        } catch (e) {
            // fall back silently
        }
        return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }

    public getCurrentProjectPath(): string {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            return workspaceFolders[0].uri.fsPath;
        }
        return 'default';
    }

    public getCurrentThreadId(): string | null {
        return this.currentThreadId;
    }

    public setCurrentThreadId(threadId: string) {
        this.currentThreadId = threadId;
        // Store last thread ID per-project and per-user
        // We can't get user ID here easily, so let's just store it globally.
        // The server will validate if the user can access it.
        this.context.globalState.update('currentThreadId', threadId);
    }

    public async createNewThread(initialMessage?: string): Promise<Thread> {
        const threadId = this.generateThreadId();
        const projectPath = this.getCurrentProjectPath();
        const timestamp = Date.now();
        
        const thread: Thread = {
            id: threadId,
            title: initialMessage ? this.generateThreadTitle(initialMessage) : 'New Conversation',
            projectPath: projectPath,
            createdAt: timestamp,
            updatedAt: timestamp,
            messages: []
        };

        // If there's an initial message, add it
        if (initialMessage) {
            thread.messages.push({
                id: this.generateMessageId(),
                type: 'user',
                content: initialMessage,
                timestamp: timestamp
            });
        }

        // Save to server (will now require auth)
        try {
            await this.saveThreadToServer(thread);
        } catch (error) {
            console.error('Failed to save thread to server:', error);
            // Don't save to local storage if server save fails, as it's out of sync
            throw error; // Re-throw to notify caller
        }

        // Set as current thread
        this.setCurrentThreadId(threadId);

        return thread;
    }

    private generateThreadTitle(message: string): string {
        // Generate a title from the first message (first 50 chars)
        const title = message.trim().substring(0, 50);
        return title.length < message.trim().length ? title + '...' : title;
    }

    public async getThread(threadId: string): Promise<Thread | null> {
        // Try to get from server first
        try {
            const thread = await this.getThreadFromServer(threadId);
            if (thread) {
                return thread;
            }
            return null; // If server returns null (e.g., 404), don't check local
        } catch (error) {
            console.error('Failed to get thread from server:', error);
            // Fallback to local storage (e.g., if offline)
            return await this.getThreadFromLocalStorage(threadId);
        }
    }

    public async getThreads(projectPath?: string): Promise<ThreadMetadata[]> {
        const currentProject = projectPath || this.getCurrentProjectPath();
        
        // Try to get from server first
        try {
            const threads = await this.getThreadsFromServer(currentProject);
            // Sync local storage with server list
            await this.syncLocalStorageWithServer(threads);
            return threads;
        } catch (error) {
            console.error('Failed to get threads from server:', error);
            // Fallback to local storage
            return await this.getThreadsFromLocalStorage(currentProject);
        }
    }
    
    // Helper to update local storage based on server data
    private async syncLocalStorageWithServer(serverThreads: ThreadMetadata[]): Promise<void> {
        const projectPath = this.getCurrentProjectPath();
        const threadsKey = `threads_${this.sanitizeProjectPath(projectPath)}`;
        const localThreadMetas = await this.getThreadsFromLocalStorage(projectPath);
        
        // Simple sync: just overwrite local list with server list metadata
        // A more complex sync would merge, but this is fine for now.
        const localThreads: Thread[] = []; // We can't reconstruct full threads from metadata
        
        // This is tricky. We'll just update the metadata list,
        // but can't fully update the local Thread[] cache without full data.
        // For simplicity, let's clear local cache if we get a server list.
        // This isn't perfect, but ensures we don't show stale local data.
        
        // A better approach: store threads locally by ID.
        // Let's modify local storage to be a map.
        const threadsKeyMap = `threads_map_${this.sanitizeProjectPath(projectPath)}`;
        const localThreadMap = this.context.globalState.get<{[id: string]: Thread}>(threadsKeyMap, {});
        
        // Remove threads from local map that are NOT on the server
        for (const localId in localThreadMap) {
            if (!serverThreads.find(st => st.id === localId)) {
                delete localThreadMap[localId];
            }
        }
        await this.context.globalState.update(threadsKeyMap, localThreadMap);
    }


    public async addMessageToThread(threadId: string, type: 'user' | 'assistant', content: string): Promise<void> {
        // Get thread from server to ensure we're up-to-date
        const thread = await this.getThread(threadId);
        if (!thread) {
            throw new Error(`Thread ${threadId} not found or access denied`);
        }

        const message = {
            id: this.generateMessageId(),
            type: type,
            content: content,
            timestamp: Date.now()
        };

        thread.messages.push(message);
        thread.updatedAt = Date.now();

        // Update title if this is the first user message
        if (thread.messages.filter(m => m.type === 'user').length === 1 && type === 'user') {
            thread.title = this.generateThreadTitle(content);
        }

        // Save to server
        try {
            await this.saveThreadToServer(thread);
            // Also update local cache
            await this.saveThreadToLocalStorage(thread); 
        } catch (error) {
            console.error('Failed to save thread to server:', error);
            throw error; // Re-throw
        }
    }

    public async deleteMessages(threadId: string, messageIds: string[]): Promise<void> {
        // Delete from server first
        try {
            await this.deleteMessagesFromServer(threadId, messageIds);
        } catch (error) {
            console.error('Failed to delete messages from server:', error);
            throw error; // Re-throw
        }

        // Update local storage
        const thread = await this.getThreadFromLocalStorage(threadId);
        if (thread) {
            thread.messages = thread.messages.filter(m => !messageIds.includes(m.id));
            thread.updatedAt = Date.now();
            await this.saveThreadToLocalStorage(thread);
        }
    }

    public async deleteThread(threadId: string): Promise<void> {
        // Delete from server
        try {
            await this.deleteThreadFromServer(threadId);
        } catch (error) {
            console.error('Failed to delete thread from server:', error);
            throw error; // Re-throw
        }

        // Delete from local storage
        await this.deleteThreadFromLocalStorage(threadId);

        // If this was the current thread, clear it
        if (this.currentThreadId === threadId) {
            this.currentThreadId = null;
            this.context.globalState.update('currentThreadId', null);
        }
    }
    
    // --- Helper for getting auth headers ---
    private async getAuthHeaders(): Promise<Record<string, string>> {
        const token = await this.authManager.getToken();
        if (!token) {
            throw new Error('Not authenticated. Please log in.');
        }
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        };
    }

    // Server API methods
    private async saveThreadToServer(thread: Thread): Promise<void> {
        const headers = await this.getAuthHeaders();
        const response = await fetch(`${this.baseUrl}/threads/save`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                thread_id: thread.id,
                title: thread.title,
                project_path: thread.projectPath,
                created_at: thread.createdAt,
                updated_at: thread.updatedAt,
                messages: thread.messages
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`Failed to save thread: ${response.statusText} - ${errorData.detail || ''}`);
        }
    }

    private async getThreadFromServer(threadId: string): Promise<Thread | null> {
        const headers = await this.getAuthHeaders();
        const response = await fetch(`${this.baseUrl}/threads/get?thread_id=${encodeURIComponent(threadId)}`, {
            method: 'GET',
            headers: headers
        });

        if (response.status === 404) {
            return null;
        }
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`Failed to get thread: ${response.statusText} - ${errorData.detail || ''}`);
        }

        const data = await response.json();
        if (data.thread) {
            const thread: Thread = {
                id: data.thread.thread_id,
                title: data.thread.title,
                projectPath: data.thread.project_path,
                createdAt: data.thread.created_at,
                updatedAt: data.thread.updated_at,
                messages: data.thread.messages || []
            };
            // Cache locally
            await this.saveThreadToLocalStorage(thread);
            return thread;
        }

        return null;
    }

    private async getThreadsFromServer(projectPath: string): Promise<ThreadMetadata[]> {
        const headers = await this.getAuthHeaders();
        const response = await fetch(`${this.baseUrl}/threads/list`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                project_path: projectPath
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`Failed to get threads: ${response.statusText} - ${errorData.detail || ''}`);
        }

        const data = await response.json();
        if (data.threads) {
            return data.threads.map((t: any) => ({
                id: t.thread_id,
                title: t.title,
                projectPath: t.project_path,
                createdAt: t.created_at,
                updatedAt: t.updated_at,
                messageCount: t.message_count || 0
            }));
        }

        return [];
    }

    private async deleteThreadFromServer(threadId: string): Promise<void> {
        const headers = await this.getAuthHeaders();
        const response = await fetch(`${this.baseUrl}/threads/delete`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                thread_id: threadId
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`Failed to delete thread: ${response.statusText} - ${errorData.detail || ''}`);
        }
    }

    private async deleteMessagesFromServer(threadId: string, messageIds: string[]): Promise<void> {
        const headers = await this.getAuthHeaders();
        const response = await fetch(`${this.baseUrl}/threads/delete-message`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                thread_id: threadId,
                message_ids: messageIds
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`Failed to delete messages: ${response.statusText} - ${errorData.detail || ''}`);
        }
    }

    // Local storage methods (backup) - Now using a map for better caching
    private async saveThreadToLocalStorage(thread: Thread): Promise<void> {
        const threadsKeyMap = `threads_map_${this.sanitizeProjectPath(thread.projectPath)}`;
        const localThreadMap = this.context.globalState.get<{[id: string]: Thread}>(threadsKeyMap, {});
        localThreadMap[thread.id] = thread;
        await this.context.globalState.update(threadsKeyMap, localThreadMap);
    }

    private async getThreadFromLocalStorage(threadId: string): Promise<Thread | null> {
        const threadsKeyMap = `threads_map_${this.sanitizeProjectPath(this.getCurrentProjectPath())}`;
        const localThreadMap = this.context.globalState.get<{[id: string]: Thread}>(threadsKeyMap, {});
        return localThreadMap[threadId] || null;
    }

    private async getThreadsFromLocalStorage(projectPath: string): Promise<ThreadMetadata[]> {
        const threadsKeyMap = `threads_map_${this.sanitizeProjectPath(projectPath)}`;
        const localThreadMap = this.context.globalState.get<{[id: string]: Thread}>(threadsKeyMap, {});
        
        return Object.values(localThreadMap)
            .map(t => ({
                id: t.id,
                title: t.title,
                projectPath: t.projectPath,
                createdAt: t.createdAt,
                updatedAt: t.updatedAt,
                messageCount: t.messages.length
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    private async deleteThreadFromLocalStorage(threadId: string): Promise<void> {
        const threadsKeyMap = `threads_map_${this.sanitizeProjectPath(this.getCurrentProjectPath())}`;
        const localThreadMap = this.context.globalState.get<{[id: string]: Thread}>(threadsKeyMap, {});
        
        if (localThreadMap[threadId]) {
            delete localThreadMap[threadId];
            await this.context.globalState.update(threadsKeyMap, localThreadMap);
        }
    }

    private sanitizeProjectPath(path: string): string {
        // Replace invalid characters for storage keys
        return path.replace(/[^a-zA-Z0-9]/g, '_');
    }
}