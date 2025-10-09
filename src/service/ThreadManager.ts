// src/service/ThreadManager.ts
import * as vscode from 'vscode';

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

    private constructor(context: vscode.ExtensionContext, baseUrl: string) {
        this.context = context;
        this.baseUrl = baseUrl;
    }

    public static getInstance(context?: vscode.ExtensionContext, baseUrl?: string): ThreadManager {
        if (!ThreadManager.instance) {
            if (!context || !baseUrl) {
                throw new Error('ThreadManager must be initialized with context and baseUrl first');
            }
            ThreadManager.instance = new ThreadManager(context, baseUrl);
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

        // Save to server
        try {
            await this.saveThreadToServer(thread);
        } catch (error) {
            console.error('Failed to save thread to server:', error);
        }

        // Save to local storage as backup
        await this.saveThreadToLocalStorage(thread);

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
        } catch (error) {
            console.error('Failed to get thread from server:', error);
        }

        // Fallback to local storage
        return await this.getThreadFromLocalStorage(threadId);
    }

    public async getThreads(projectPath?: string): Promise<ThreadMetadata[]> {
        const currentProject = projectPath || this.getCurrentProjectPath();
        
        // Try to get from server first
        try {
            const threads = await this.getThreadsFromServer(currentProject);
            if (threads && threads.length > 0) {
                return threads;
            }
        } catch (error) {
            console.error('Failed to get threads from server:', error);
        }

        // Fallback to local storage
        return await this.getThreadsFromLocalStorage(currentProject);
    }

    public async addMessageToThread(threadId: string, type: 'user' | 'assistant', content: string): Promise<void> {
        const thread = await this.getThread(threadId);
        if (!thread) {
            throw new Error(`Thread ${threadId} not found`);
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
        } catch (error) {
            console.error('Failed to save thread to server:', error);
        }

        // Save to local storage as backup
        await this.saveThreadToLocalStorage(thread);
    }

    public async deleteMessages(threadId: string, messageIds: string[]): Promise<void> {
        const thread = await this.getThread(threadId);
        if (!thread) {
            throw new Error(`Thread ${threadId} not found`);
        }

        thread.messages = thread.messages.filter(m => !messageIds.includes(m.id));
        thread.updatedAt = Date.now();

        // Save to server
        try {
            await this.deleteMessagesFromServer(threadId, messageIds);
        } catch (error) {
            console.error('Failed to delete messages from server:', error);
        }

        // Save to local storage as backup
        await this.saveThreadToLocalStorage(thread);
    }

    public async deleteThread(threadId: string): Promise<void> {
        // Delete from server
        try {
            await this.deleteThreadFromServer(threadId);
        } catch (error) {
            console.error('Failed to delete thread from server:', error);
        }

        // Delete from local storage
        await this.deleteThreadFromLocalStorage(threadId);

        // If this was the current thread, clear it
        if (this.currentThreadId === threadId) {
            this.currentThreadId = null;
            this.context.globalState.update('currentThreadId', null);
        }
    }

    // Server API methods
    private async saveThreadToServer(thread: Thread): Promise<void> {
        const response = await fetch(`${this.baseUrl}/threads/save`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
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
            throw new Error(`Failed to save thread: ${response.statusText}`);
        }
    }

    private async getThreadFromServer(threadId: string): Promise<Thread | null> {
        const response = await fetch(`${this.baseUrl}/threads/get?thread_id=${encodeURIComponent(threadId)}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            }
        });

        if (!response.ok) {
            return null;
        }

        const data = await response.json();
        if (data.thread) {
            return {
                id: data.thread.thread_id,
                title: data.thread.title,
                projectPath: data.thread.project_path,
                createdAt: data.thread.created_at,
                updatedAt: data.thread.updated_at,
                messages: data.thread.messages || []
            };
        }

        return null;
    }

    private async getThreadsFromServer(projectPath: string): Promise<ThreadMetadata[]> {
        const response = await fetch(`${this.baseUrl}/threads/list`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                project_path: projectPath
            })
        });

        if (!response.ok) {
            return [];
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
        const response = await fetch(`${this.baseUrl}/threads/delete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                thread_id: threadId
            })
        });

        if (!response.ok) {
            throw new Error(`Failed to delete thread: ${response.statusText}`);
        }
    }

    private async deleteMessagesFromServer(threadId: string, messageIds: string[]): Promise<void> {
        const response = await fetch(`${this.baseUrl}/threads/delete-message`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                thread_id: threadId,
                message_ids: messageIds
            })
        });

        if (!response.ok) {
            throw new Error(`Failed to delete messages: ${response.statusText}`);
        }
    }

    // Local storage methods (backup)
    private async saveThreadToLocalStorage(thread: Thread): Promise<void> {
        const threadsKey = `threads_${this.sanitizeProjectPath(thread.projectPath)}`;
        const existingThreads = this.context.globalState.get<Thread[]>(threadsKey, []);
        
        const index = existingThreads.findIndex(t => t.id === thread.id);
        if (index >= 0) {
            existingThreads[index] = thread;
        } else {
            existingThreads.push(thread);
        }

        await this.context.globalState.update(threadsKey, existingThreads);
    }

    private async getThreadFromLocalStorage(threadId: string): Promise<Thread | null> {
        const threadsKey = `threads_${this.sanitizeProjectPath(this.getCurrentProjectPath())}`;
        const threads = this.context.globalState.get<Thread[]>(threadsKey, []);
        const thread = threads.find(t => t.id === threadId);
        if (thread) {
            return thread;
        }

        return null;
    }

    private async getThreadsFromLocalStorage(projectPath: string): Promise<ThreadMetadata[]> {
        const threadsKey = `threads_${this.sanitizeProjectPath(projectPath)}`;
        const threads = this.context.globalState.get<Thread[]>(threadsKey, []);
        
        return threads
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
        const threadsKey = `threads_${this.sanitizeProjectPath(this.getCurrentProjectPath())}`;
        const threads = this.context.globalState.get<Thread[]>(threadsKey, []);
        const filteredThreads = threads.filter(t => t.id !== threadId);
        
        if (filteredThreads.length !== threads.length) {
            await this.context.globalState.update(threadsKey, filteredThreads);
        }
    }

    private sanitizeProjectPath(path: string): string {
        // Replace invalid characters for storage keys
        return path.replace(/[^a-zA-Z0-9]/g, '_');
    }
}