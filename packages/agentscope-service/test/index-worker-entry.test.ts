/* eslint-disable jsdoc/require-jsdoc */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
    DocumentSummary,
    VectorRecord,
    VectorSearchResult,
} from '@agentscope-ai/agentscope/rag';
import { TextParser, VectorStoreBase } from '@agentscope-ai/agentscope/rag';
import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';

import { createApp } from '../src/app';
import { getKnowledgeBaseService } from '../src/dependencies';
import { InMemoryMessageBus } from '../src/message-bus';
import {
    CollectionPerKbManager,
    LocalBlobStore,
    runWorkerFromEnvironment,
    runWorker,
} from '../src/rag';
import { InMemoryStorage } from '../src/storage';
import { WorkspaceManagerBase } from '../src/workspace-manager';

class RecordingVectorStore extends VectorStoreBase {
    constructor(private readonly events: string[]) {
        super();
    }

    override async close(): Promise<void> {
        this.events.push('vector:close');
    }

    async createCollection(): Promise<void> {}
    async deleteCollection(): Promise<void> {}
    async hasCollection(): Promise<boolean> {
        return false;
    }
    async insert(_collection: string, _records: VectorRecord[]): Promise<void> {}
    async delete(): Promise<void> {}
    async search(): Promise<VectorSearchResult[]> {
        return [];
    }
    async listDocuments(): Promise<DocumentSummary[]> {
        return [];
    }
}

class RecordingStorage extends InMemoryStorage {
    constructor(private readonly events: string[]) {
        super();
    }

    override async open(): Promise<this> {
        this.events.push('storage:open');
        return this;
    }

    override async close(): Promise<void> {
        this.events.push('storage:close');
    }
}

class RecordingBus extends InMemoryMessageBus {
    constructor(private readonly events: string[]) {
        super();
    }

    override async open(): Promise<this> {
        this.events.push('bus:open');
        return this;
    }

    override async close(): Promise<void> {
        this.events.push('bus:close');
        await super.close();
    }
}

class NoopWorkspaceManager extends WorkspaceManagerBase {
    async getWorkspace(): Promise<WorkspaceBase> {
        throw new Error('not used');
    }
    async close(): Promise<void> {}
    async closeAll(): Promise<void> {}
}

describe('out-of-process index worker entry', () => {
    let temporaryDirectory: string;

    beforeEach(async () => {
        temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentscope-worker-'));
    });

    afterEach(async () => {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    });

    test('enters every backend and releases them when cancelled', async () => {
        const events: string[] = [];
        const storage = new RecordingStorage(events);
        const bus = new RecordingBus(events);
        const vectorStore = new RecordingVectorStore(events);
        await runWorker({
            storage,
            messageBus: bus,
            blobStore: new LocalBlobStore(temporaryDirectory),
            knowledgeBaseManager: new CollectionPerKbManager(storage, vectorStore),
            parsers: [new TextParser()],
            nodeId: 'test-node',
            signal: AbortSignal.abort(),
        });
        expect(events).toEqual([
            'storage:open',
            'bus:open',
            'vector:close',
            'bus:close',
            'storage:close',
        ]);
    });

    test('keeps KB services enabled in dedicated-worker mode', async () => {
        const events: string[] = [];
        const storage = new RecordingStorage(events);
        const app = createApp({
            storage,
            messageBus: new RecordingBus(events),
            workspaceManager: new NoopWorkspaceManager(),
            knowledgeBaseManager: new CollectionPerKbManager(
                storage,
                new RecordingVectorStore(events)
            ),
            blobStore: new LocalBlobStore(temporaryDirectory),
            enableIndexWorker: false,
            enableScheduler: false,
        });
        await app.open();
        expect(getKnowledgeBaseService(app)).toBe(app.services.knowledgeBase);
        expect(app.knowledgeParsers).toHaveLength(1);
        expect(app.knowledgeChunkers).toHaveLength(1);
        await app.close();
    });

    test('requires an explicit deployment bootstrap', async () => {
        await expect(runWorkerFromEnvironment({})).rejects.toThrow(
            'AGENTSCOPE_WORKER_BOOTSTRAP is required'
        );
    });
});
