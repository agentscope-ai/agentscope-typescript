/* eslint-disable jsdoc/require-jsdoc */

import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';

import { createApp } from '../src/app';
import {
    getChatService,
    getCurrentUserId,
    getKnowledgeBaseManager,
    getStorage,
    ServiceDependencyError,
} from '../src/dependencies';
import { InMemoryMessageBus } from '../src/message-bus';
import { InMemoryStorage } from '../src/storage';
import { WorkspaceManagerBase } from '../src/workspace-manager';

class RecordingStorage extends InMemoryStorage {
    constructor(
        private readonly events: string[],
        private readonly failOpen = false
    ) {
        super();
    }

    override async open(): Promise<this> {
        this.events.push('storage:open');
        if (this.failOpen) throw new Error('storage failed');
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

class RecordingWorkspaceManager extends WorkspaceManagerBase {
    constructor(private readonly events: string[]) {
        super();
    }

    override async open(): Promise<this> {
        this.events.push('workspace:open');
        return this;
    }

    async getWorkspace(): Promise<WorkspaceBase> {
        throw new Error('not used');
    }

    async close(): Promise<void> {}

    async closeAll(): Promise<void> {
        this.events.push('workspace:close');
    }
}

describe('AgentScope service composition root', () => {
    test('constructs services on open and releases resources in reverse order', async () => {
        const events: string[] = [];
        const storage = new RecordingStorage(events);
        const bus = new RecordingBus(events);
        const workspaceManager = new RecordingWorkspaceManager(events);
        const app = createApp({
            storage,
            messageBus: bus,
            workspaceManager,
            enableScheduler: false,
            additionalResources: [
                {
                    async open() {
                        events.push('extra:open');
                    },
                    async close() {
                        events.push('extra:close');
                    },
                },
            ],
            downloadSecret: 'secret',
            title: 'Custom',
            version: '1.2.3',
        });

        expect(app.started).toBe(false);
        expect(() => app.services).toThrow('not started');
        await app.open();
        expect(await app.open()).toBe(app);
        expect(app.started).toBe(true);
        expect(getStorage(app)).toBe(storage);
        expect(getChatService(app)).toBe(app.services.chat);
        expect(app.downloadSecret).toBe('secret');
        expect([app.title, app.version]).toEqual(['Custom', '1.2.3']);
        expect(events).toEqual(['storage:open', 'bus:open', 'workspace:open', 'extra:open']);

        await app.close();
        await app.close();
        expect(app.started).toBe(false);
        expect(events).toEqual([
            'storage:open',
            'bus:open',
            'workspace:open',
            'extra:open',
            'extra:close',
            'workspace:close',
            'bus:close',
            'storage:close',
        ]);
    });

    test('rolls back already-opened resources when later startup fails', async () => {
        const events: string[] = [];
        const app = createApp({
            storage: new RecordingStorage(events),
            messageBus: new RecordingBus(events),
            workspaceManager: new RecordingWorkspaceManager(events),
            enableScheduler: false,
            additionalResources: [
                {
                    async open() {
                        events.push('first:open');
                    },
                    async close() {
                        events.push('first:close');
                    },
                },
                {
                    async open() {
                        events.push('second:open');
                        throw new Error('startup failed');
                    },
                },
            ],
        });

        await expect(app.open()).rejects.toThrow('startup failed');
        expect(app.started).toBe(false);
        expect(events).toEqual([
            'storage:open',
            'bus:open',
            'workspace:open',
            'first:open',
            'second:open',
            'first:close',
            'workspace:close',
            'bus:close',
            'storage:close',
        ]);
    });

    test('serializes overlapping open and close calls', async () => {
        const events: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const app = createApp({
            storage: new RecordingStorage(events),
            messageBus: new RecordingBus(events),
            workspaceManager: new RecordingWorkspaceManager(events),
            enableScheduler: false,
            additionalResources: [
                {
                    async open() {
                        events.push('extra:opening');
                        await gate;
                        events.push('extra:open');
                    },
                    async close() {
                        events.push('extra:close');
                    },
                },
            ],
        });
        const opening = app.open();
        const closing = app.close();
        release();
        await Promise.all([opening, closing]);
        expect(app.started).toBe(false);
        expect(events.slice(-4)).toEqual([
            'extra:close',
            'workspace:close',
            'bus:close',
            'storage:close',
        ]);
    });

    test('validates templates, dependencies, and temporary header identity', () => {
        const events: string[] = [];
        const options = {
            storage: new RecordingStorage(events),
            messageBus: new RecordingBus(events),
            workspaceManager: new RecordingWorkspaceManager(events),
        };
        expect(getCurrentUserId(new Headers({ 'X-User-ID': 'alice' }))).toBe('alice');
        expect(getCurrentUserId({ 'x-user-id': ['bob'] })).toBe('bob');
        expect(() => getCurrentUserId({})).toThrow(ServiceDependencyError);
        const app = createApp(options);
        expect(() => getKnowledgeBaseManager(app)).toThrow(ServiceDependencyError);
        expect(() =>
            createApp({
                ...options,
                customSubagentTemplates: [
                    { type: 'coder', description: 'one', systemPromptTemplate: 'one' },
                    { type: 'coder', description: 'two', systemPromptTemplate: 'two' },
                ],
            })
        ).toThrow('Duplicate sub_agent_template');
    });
});
