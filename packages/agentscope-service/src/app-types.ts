import type { AgentOptions } from '@agentscope-ai/agentscope/agent';
import type { CredentialClass } from '@agentscope-ai/agentscope/credential';
import type { MiddlewareBase } from '@agentscope-ai/agentscope/middleware';
import type { ChunkerBase, ParserBase } from '@agentscope-ai/agentscope/rag';
import type { ToolBase } from '@agentscope-ai/agentscope/tool';
import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';

import type { ResourceAccessPolicyBase } from './access';
import type { MessageBus } from './message-bus';
import type { BlobStoreBase, KnowledgeBaseManagerBase } from './rag';
import type { ChannelClientsLike, EventProjector } from './service/chat-service';
import type { StorageBase } from './storage';
import type { SubAgentTemplate } from './tool';
import type { WorkspaceManagerBase } from './workspace-manager';

export type AgentMiddlewareFactory = (
    userId: string,
    agentId: string,
    sessionId: string,
    workspace?: WorkspaceBase
) => Promise<MiddlewareBase[]>;

export type AgentToolFactory = (
    userId: string,
    agentId: string,
    sessionId: string
) => Promise<ToolBase[]>;

export interface ServiceLifecycleResource {
    open?(): Promise<unknown>;
    close?(): Promise<void>;
}

export interface AgentScopeServiceAppOptions {
    storage: StorageBase;
    messageBus: MessageBus;
    workspaceManager: WorkspaceManagerBase;
    knowledgeBaseManager?: KnowledgeBaseManagerBase | null;
    knowledgeParsers?: ParserBase[] | Record<string, ParserBase> | null;
    knowledgeChunkers?: Array<
        new (parameters?: Record<string, unknown>) => ChunkerBase<object>
    > | null;
    blobStore?: BlobStoreBase | null;
    enableIndexWorker?: boolean;
    enableScheduler?: boolean;
    extraCredentials?: CredentialClass[];
    extraAgentMiddlewares?: AgentMiddlewareFactory | null;
    extraAgentTools?: AgentToolFactory | null;
    customSubagentTemplates?: SubAgentTemplate[];
    agentClass?: new (options: AgentOptions) => import('@agentscope-ai/agentscope/agent').Agent;
    resourceAccessPolicy?: ResourceAccessPolicyBase | null;
    extraProjectors?: EventProjector[];
    channelClients?: ChannelClientsLike | null;
    additionalResources?: ServiceLifecycleResource[];
    downloadSecret?: string | null;
    title?: string;
    version?: string;
}

export type { EventProjector, SubAgentTemplate };
