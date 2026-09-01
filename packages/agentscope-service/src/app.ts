/* eslint-disable jsdoc/require-jsdoc */

import { randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { Agent } from '@agentscope-ai/agentscope/agent';
import { CredentialFactory } from '@agentscope-ai/agentscope/credential';
import { ApproxTokenChunker, TextParser, type ChunkerBase } from '@agentscope-ai/agentscope/rag';
import { VERSION } from '@agentscope-ai/agentscope/version';

import { DenyAllResourceAccessPolicy } from './access';
import type { AgentScopeServiceAppOptions, SubAgentTemplate } from './app-types';
import { ChannelClients, ChannelTypeRegistry } from './channel';
import type { MCPHubBase, SkillHubBase } from './hub';
import { AsyncLifecycleStack } from './lifespan';
import {
    BackgroundTaskManager,
    CancelDispatcher,
    ChatRunRegistry,
    SchedulerManager,
    WakeupDispatcher,
} from './manager';
import type { MessageBus } from './message-bus';
import { LocalBlobStore, type BlobStoreBase, type KnowledgeBaseManagerBase } from './rag';
import {
    ChatService,
    ChannelService,
    CredentialBindingService,
    IndexSweeper,
    IndexTaskConsumer,
    IndexWorker,
    KnowledgeBaseService,
    ResourceAccessService,
    SessionService,
    WorkspaceService,
} from './service';
import type { ParserRegistry } from './service/index-worker';
import type { StorageBase } from './storage';
import type { WorkspaceManagerBase } from './workspace-manager';

export interface AgentScopeManagers {
    backgroundTasks: BackgroundTaskManager;
    chatRuns: ChatRunRegistry;
    scheduler: SchedulerManager;
    wakeups: WakeupDispatcher;
    cancellations: CancelDispatcher;
}

export interface AgentScopeServices {
    resourceAccess: ResourceAccessService;
    chat: ChatService;
    session: SessionService;
    workspace: WorkspaceService;
    knowledgeBase: KnowledgeBaseService | null;
    channel: ChannelService;
    credentialBinding: CredentialBindingService;
}

/** Framework-independent AgentScope service composition root. */
export class AgentScopeServiceApp {
    readonly storage: StorageBase;
    readonly messageBus: MessageBus;
    readonly workspaceManager: WorkspaceManagerBase;
    readonly knowledgeBaseManager: KnowledgeBaseManagerBase | null;
    readonly knowledgeParsers: ParserRegistry | null;
    readonly knowledgeChunkers: Array<
        new (parameters?: Record<string, unknown>) => ChunkerBase<object>
    > | null;
    readonly blobStore: BlobStoreBase | null;
    readonly downloadSecret: string;
    readonly title: string;
    readonly version: string;
    readonly customSubagentTemplates: Readonly<Record<string, SubAgentTemplate>>;
    readonly extraAgentMiddlewares: AgentScopeServiceAppOptions['extraAgentMiddlewares'];
    readonly extraAgentTools: AgentScopeServiceAppOptions['extraAgentTools'];
    readonly channelClients: AgentScopeServiceAppOptions['channelClients'];
    readonly channelTypeRegistry: ChannelTypeRegistry;
    readonly mcpHubs: ReadonlyMap<string, MCPHubBase>;
    readonly skillHubs: ReadonlyMap<string, SkillHubBase>;

    private readonly options: AgentScopeServiceAppOptions;
    private stack: AsyncLifecycleStack | null = null;
    private runtimeManagers: AgentScopeManagers | null = null;
    private runtimeServices: AgentScopeServices | null = null;
    private opening: Promise<this> | null = null;
    private closing: Promise<void> | null = null;

    constructor(options: AgentScopeServiceAppOptions) {
        this.options = options;
        this.storage = options.storage;
        this.messageBus = options.messageBus;
        this.workspaceManager = options.workspaceManager;
        this.workspaceManager.bindStorage(this.storage);
        this.knowledgeBaseManager = options.knowledgeBaseManager ?? null;
        this.knowledgeParsers = this.knowledgeBaseManager
            ? (options.knowledgeParsers ?? [new TextParser()])
            : (options.knowledgeParsers ?? null);
        this.knowledgeChunkers = this.knowledgeBaseManager
            ? (options.knowledgeChunkers ?? [ApproxTokenChunker])
            : (options.knowledgeChunkers ?? null);
        this.blobStore = this.knowledgeBaseManager
            ? (options.blobStore ?? new LocalBlobStore('./blobs'))
            : (options.blobStore ?? null);
        this.downloadSecret = options.downloadSecret ?? randomBytes(32).toString('base64url');
        this.title = options.title ?? 'AgentScope';
        this.version = options.version ?? VERSION;
        this.customSubagentTemplates = indexTemplates(options.customSubagentTemplates ?? []);
        this.extraAgentMiddlewares = options.extraAgentMiddlewares ?? null;
        this.extraAgentTools = options.extraAgentTools ?? null;
        this.channelTypeRegistry = new ChannelTypeRegistry(options.channels ?? []);
        this.channelClients =
            options.channelClients ??
            new ChannelClients(this.storage, this.messageBus, this.channelTypeRegistry);
        this.mcpHubs = indexHubs(options.mcpHubs ?? [], 'MCP');
        this.skillHubs = indexHubs(options.skillHubs ?? [], 'skill');
        validateChunkers(this.knowledgeChunkers ?? []);
        for (const credential of options.extraCredentials ?? []) {
            CredentialFactory.registerCredential(credential);
        }
    }

    get started(): boolean {
        return this.stack !== null;
    }

    get managers(): AgentScopeManagers {
        if (!this.runtimeManagers) throw new Error('AgentScope service app is not started.');
        return this.runtimeManagers;
    }

    get services(): AgentScopeServices {
        if (!this.runtimeServices) throw new Error('AgentScope service app is not started.');
        return this.runtimeServices;
    }

    async open(): Promise<this> {
        if (this.closing) await this.closing;
        if (this.stack) return this;
        if (this.opening) return this.opening;
        this.opening = this.openImpl();
        try {
            return await this.opening;
        } finally {
            this.opening = null;
        }
    }

    async close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closing = this.closeImpl();
        try {
            await this.closing;
        } finally {
            this.closing = null;
        }
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }

    private async openImpl(): Promise<this> {
        const stack = new AsyncLifecycleStack();
        try {
            await this.storage.open();
            stack.defer(() => this.storage.close());
            await this.messageBus.open();
            stack.defer(() => this.messageBus.close());
            await this.workspaceManager.open();
            stack.defer(() => this.workspaceManager.closeManager());
            if (this.knowledgeBaseManager) {
                await this.knowledgeBaseManager.open();
                stack.defer(() => this.knowledgeBaseManager!.close());
            }
            if (this.blobStore) {
                await this.blobStore.openStore();
                stack.defer(() => this.blobStore!.closeStore());
            }
            for (const resource of this.options.additionalResources ?? []) {
                await resource.open?.();
                stack.defer(async () => resource.close?.());
            }
            for (const hub of [...this.mcpHubs.values(), ...this.skillHubs.values()]) {
                await hub.open();
                stack.defer(() => hub.close());
            }
            if (this.channelClients instanceof ChannelClients) {
                const channelClients = this.channelClients;
                await channelClients.open();
                stack.defer(() => channelClients.close());
            }

            const backgroundTasks = await new BackgroundTaskManager(this.messageBus).open();
            stack.defer(() => backgroundTasks.close());
            const chatRuns = await new ChatRunRegistry().open();
            stack.defer(() => chatRuns.close());
            const scheduler = await new SchedulerManager(
                this.storage,
                this.messageBus,
                this.workspaceManager,
                { enabled: this.options.enableScheduler ?? true }
            ).open();
            stack.defer(() => scheduler.close());

            const resourceAccess = new ResourceAccessService(
                this.storage,
                this.options.resourceAccessPolicy ?? new DenyAllResourceAccessPolicy()
            );
            const chat = new ChatService(
                this.storage,
                this.workspaceManager,
                scheduler,
                backgroundTasks,
                this.messageBus,
                resourceAccess,
                {
                    knowledgeBaseManager: this.knowledgeBaseManager,
                    extraAgentMiddlewares: this.options.extraAgentMiddlewares,
                    extraAgentTools: this.options.extraAgentTools,
                    customSubagentTemplates: this.customSubagentTemplates,
                    agentClass: this.options.agentClass ?? Agent,
                    extraProjectors: this.options.extraProjectors,
                    channelClients: this.options.channelClients,
                }
            );
            const session = new SessionService(
                this.storage,
                this.messageBus,
                this.workspaceManager
            );
            const workspace = new WorkspaceService(
                this.storage,
                this.workspaceManager,
                this.downloadSecret
            );
            const channel = new ChannelService(
                this.storage,
                this.messageBus,
                this.channelTypeRegistry
            );
            const credentialBinding = new CredentialBindingService(
                this.messageBus,
                this.channelTypeRegistry
            );
            let knowledgeBase: KnowledgeBaseService | null = null;

            if (
                this.knowledgeBaseManager &&
                this.blobStore &&
                this.knowledgeParsers &&
                this.knowledgeChunkers
            ) {
                if (this.options.enableIndexWorker ?? true) {
                    const worker = new IndexWorker(
                        this.storage,
                        this.blobStore,
                        this.knowledgeBaseManager,
                        this.knowledgeParsers,
                        `${hostname()}:${randomUUID().slice(0, 8)}`,
                        { chunkers: this.knowledgeChunkers }
                    );
                    const consumer = await new IndexTaskConsumer(this.messageBus, worker).start();
                    stack.defer(() => consumer.stop());
                }
                const sweeper = new IndexSweeper(this.storage, this.messageBus);
                await sweeper.start();
                stack.defer(() => sweeper.stop());
                knowledgeBase = new KnowledgeBaseService(
                    this.storage,
                    this.knowledgeBaseManager,
                    this.blobStore,
                    this.messageBus,
                    resourceAccess,
                    this.knowledgeChunkers
                );
            }

            const wakeups = await new WakeupDispatcher(
                this.messageBus,
                this.storage,
                chat,
                chatRuns
            ).open();
            stack.defer(() => wakeups.close());
            const cancellations = await new CancelDispatcher(
                this.messageBus,
                chatRuns,
                backgroundTasks
            ).open();
            stack.defer(() => cancellations.close());

            this.runtimeManagers = {
                backgroundTasks,
                chatRuns,
                scheduler,
                wakeups,
                cancellations,
            };
            this.runtimeServices = {
                resourceAccess,
                chat,
                session,
                workspace,
                knowledgeBase,
                channel,
                credentialBinding,
            };
            this.stack = stack;
            return this;
        } catch (error) {
            await stack.close().catch(() => undefined);
            throw error;
        }
    }

    private async closeImpl(): Promise<void> {
        if (this.opening) await this.opening.catch(() => undefined);
        const stack = this.stack;
        this.stack = null;
        this.runtimeManagers = null;
        this.runtimeServices = null;
        await stack?.close();
    }
}

function indexHubs<T extends MCPHubBase | SkillHubBase>(
    hubs: T[],
    kind: string
): ReadonlyMap<string, T> {
    const indexed = new Map<string, T>();
    for (const hub of hubs) {
        if (indexed.has(hub.hubId)) {
            throw new Error(`Duplicate ${kind} hub id '${hub.hubId}'.`);
        }
        indexed.set(hub.hubId, hub);
    }
    return indexed;
}

export function createApp(options: AgentScopeServiceAppOptions): AgentScopeServiceApp {
    return new AgentScopeServiceApp(options);
}

export const create_app = createApp;

function indexTemplates(templates: SubAgentTemplate[]): Readonly<Record<string, SubAgentTemplate>> {
    const indexed: Record<string, SubAgentTemplate> = {};
    const duplicates = new Set<string>();
    for (const template of templates) {
        if (template.type in indexed) duplicates.add(template.type);
        indexed[template.type] = template;
    }
    if (duplicates.size > 0) {
        throw new Error(
            `Duplicate sub_agent_template type(s): ${JSON.stringify([...duplicates].sort())}`
        );
    }
    return Object.freeze(indexed);
}

function validateChunkers(
    chunkers: Array<new (parameters?: Record<string, unknown>) => ChunkerBase<object>>
): void {
    const seen = new Map<string, string>();
    for (const Chunker of chunkers) {
        const type = new Chunker({}).chunkerType;
        const previous = seen.get(type);
        if (previous) {
            throw new Error(`Duplicate chunkerType '${type}': ${previous} and ${Chunker.name}.`);
        }
        seen.set(type, Chunker.name);
    }
}
