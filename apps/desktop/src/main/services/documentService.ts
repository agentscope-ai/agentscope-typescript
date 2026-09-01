import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
    UserConfirmResultEvent,
    ExternalExecutionResultEvent,
} from '@agentscope-ai/agentscope/event';
import type { Msg } from '@agentscope-ai/agentscope/message';
import type { Document } from '@shared/types/document';
import type { IpcMain, WebContents } from 'electron';

import type { DesktopServiceRuntime } from '../runtime';
import { readJSON, writeJSON, remove } from '../storage';
import { PATHS } from '../storage/paths';

/**
 * Register IPC handlers for document-related operations
 *
 * @param ipcMain - The Electron IPC main instance
 * @param webContents - The web contents for sending events
 * @param runtime - Shared service runtime
 */
export function registerDocumentHandlers(
    ipcMain: IpcMain,
    webContents: WebContents,
    runtime: DesktopServiceRuntime
): void {
    const service = new DocumentService();

    ipcMain.handle('document:isRunning', async (_event, docId: string) => {
        return runtime.isDocumentRunning(docId);
    });

    ipcMain.handle('document:getMessages', async (_event, docId: string) => {
        return runtime.getDocumentMessages(docId);
    });

    ipcMain.handle(
        'document:sendMessage',
        async (
            _event,
            docId: string,
            agentKey: string = 'friday',
            msg?: Msg,
            event?: UserConfirmResultEvent | ExternalExecutionResultEvent
        ) => {
            await runtime.sendDocumentMessage(docId, agentKey, msg ?? event ?? null, agentEvent =>
                webContents.send(`agent:event:document:${docId}`, agentEvent)
            );
        }
    );

    ipcMain.handle('document:getDocuments', () => {
        return service.getDocuments();
    });

    ipcMain.handle('document:createDocument', (_event, name?: string) => {
        return service.createDocument(name);
    });

    ipcMain.handle('document:renameDocument', (_event, id: string, name: string) => {
        return service.renameDocument(id, name);
    });

    ipcMain.handle('document:pinDocument', (_event, id: string) => {
        return service.pinDocument(id);
    });

    ipcMain.handle('document:deleteDocument', async (_event, id: string) => {
        await runtime.deleteDocumentSessions(id);
        service.deleteDocument(id);
    });

    ipcMain.handle('document:getContent', (_event, id: string) => {
        return service.getContent(id);
    });

    ipcMain.handle('document:saveContent', (_event, id: string, content: string) => {
        return service.saveContent(id, content);
    });
}

/**
 * Service class for managing documents
 */
export class DocumentService {
    private documentsIndexPath = path.join(PATHS.root, 'editor', 'index.json');

    // ─── Document ─────────────────────────────────────────────────────────────

    /**
     * Load all documents from storage
     *
     * @returns Array of all documents
     */
    private loadDocuments(): Document[] {
        return readJSON<Document[]>(this.documentsIndexPath, []);
    }

    /**
     * Save documents to storage
     *
     * @param documents - Array of documents to save
     */
    private saveDocuments(documents: Document[]): void {
        writeJSON(this.documentsIndexPath, documents);
    }

    /**
     * Get documents with pagination and pinned documents
     *
     * @returns Result containing pinned documents and paginated items
     */
    getDocuments(): Document[] {
        return this.loadDocuments();
    }

    /**
     * Create a new document
     *
     * @param name - Optional name for the document
     * @returns The created document
     */
    createDocument(name?: string): Document {
        const documents = this.loadDocuments();
        const now = Date.now();
        // 用当前的日子做为默认名字，格式为 "2025-01-01 14:00:00"
        const document: Document = {
            id: randomUUID(),
            name: name || new Date(now).toISOString().replace('T', ' ').slice(0, 19),
            pinned: false,
            createdAt: now,
            updatedAt: now,
        };
        documents.push(document);
        this.saveDocuments(documents);

        // Create document directory and empty content file
        const docDir = PATHS.editorDir(document.id);
        if (!fs.existsSync(docDir)) {
            fs.mkdirSync(docDir, { recursive: true });
        }
        fs.writeFileSync(PATHS.editorContent(document.id), '', 'utf-8');

        return document;
    }

    /**
     * Rename a document
     *
     * @param id - The document ID
     * @param name - The new name
     * @returns The updated document
     */
    renameDocument(id: string, name: string): Document {
        const documents = this.loadDocuments();
        const document = documents.find(d => d.id === id);
        if (!document) {
            throw new Error(`Document not found: ${id}`);
        }
        document.name = name;
        document.updatedAt = Date.now();
        this.saveDocuments(documents);
        return document;
    }

    /**
     * Pin or unpin a document
     *
     * @param id - The document ID
     * @returns The updated document
     */
    pinDocument(id: string): Document {
        const documents = this.loadDocuments();
        const document = documents.find(d => d.id === id);
        if (!document) {
            throw new Error(`Document not found: ${id}`);
        }
        document.pinned = !document.pinned;
        document.updatedAt = Date.now();
        this.saveDocuments(documents);
        return document;
    }

    /**
     * Delete a document and its content
     *
     * @param id - The document ID to delete
     */
    deleteDocument(id: string): void {
        const documents = this.loadDocuments();
        const filtered = documents.filter(d => d.id !== id);
        this.saveDocuments(filtered);

        // Delete document directory (cascade delete)
        remove(PATHS.editorDir(id));
    }

    // ─── Content ─────────────────────────────────────────────────────────────

    /**
     * Get document content
     *
     * @param id - The document ID
     * @returns The document content
     */
    getContent(id: string): string {
        const documents = this.loadDocuments();
        if (!documents.find(d => d.id === id)) {
            throw new Error(`Document not found: ${id}`);
        }

        const contentPath = PATHS.editorContent(id);
        if (!fs.existsSync(contentPath)) {
            return '';
        }
        return fs.readFileSync(contentPath, 'utf-8');
    }

    /**
     * Save document content
     *
     * @param id - The document ID
     * @param content - The content to save
     */
    saveContent(id: string, content: string): void {
        const documents = this.loadDocuments();
        const document = documents.find(d => d.id === id);
        if (!document) {
            throw new Error(`Document not found: ${id}`);
        }

        fs.writeFileSync(PATHS.editorContent(id), content, 'utf-8');
        document.updatedAt = Date.now();
        this.saveDocuments(documents);
    }
}
