/* eslint-disable jsdoc/require-jsdoc */

import { EventType, parseAgentEvent, type AgentEvent } from '@agentscope-ai/agentscope/event';
import {
    appendEvent,
    DataBlockSchema,
    TextBlock,
    TextBlockSchema,
    type DataBlock,
    type Msg,
} from '@agentscope-ai/agentscope/message';
import type { ToolBase } from '@agentscope-ai/agentscope/tool';
import { ReplyFinishedReason } from '@agentscope-ai/agentscope/type';
import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';
import { z } from 'zod';

import type { BusPayload } from '../message-bus';
import type { CredentialBindingConstructor } from './credential-binding';

export const LIVENESS_TTL_SECONDS = 30;
export const NO_TEXT_REPLY = '(Agent returned no text content)';
export const AGENT_ERROR_REPLY =
    '❌ Agent encountered an error. Please check the agent configuration.';

export type ChannelContentBlock = ReturnType<typeof TextBlock> | DataBlock;

export interface ChannelEventOptions {
    channelId: string;
    channelUserId: string;
    channelUserName?: string;
    chatId: string;
    chatName?: string;
    channelMessageId?: string | null;
    content?: ChannelContentBlock[];
    metadata?: Record<string, unknown>;
    receivedAt?: string;
}

/** A normalized inbound message from an IM platform. */
export class ChannelEvent {
    readonly channelId: string;
    readonly channelUserId: string;
    readonly channelUserName: string;
    readonly chatId: string;
    readonly chatName: string;
    readonly channelMessageId: string | null;
    readonly content: ChannelContentBlock[];
    readonly metadata: Record<string, unknown>;
    readonly receivedAt: string;

    constructor(options: ChannelEventOptions) {
        this.channelId = options.channelId;
        this.channelUserId = options.channelUserId;
        this.channelUserName = options.channelUserName ?? '';
        this.chatId = options.chatId;
        this.chatName = options.chatName ?? '';
        this.channelMessageId = options.channelMessageId ?? null;
        this.content = options.content ?? [];
        this.metadata = options.metadata ?? {};
        this.receivedAt = options.receivedAt ?? new Date().toISOString();
    }

    get message(): string {
        return this.content
            .filter((block): block is ReturnType<typeof TextBlock> => block.type === 'text')
            .map(block => block.text)
            .join('');
    }

    toJSON(): Record<string, unknown> {
        return {
            channel_id: this.channelId,
            channel_user_id: this.channelUserId,
            channel_user_name: this.channelUserName,
            chat_id: this.chatId,
            chat_name: this.chatName,
            channel_message_id: this.channelMessageId,
            content: this.content,
            metadata: this.metadata,
            received_at: this.receivedAt,
        };
    }
}

export interface ChannelConfirmationResultEventOptions {
    channelId: string;
    chatId: string;
    channelUserId: string;
    agentId?: string;
    sessionId?: string;
    toolCallId: string;
    approved: boolean;
    actor?: string;
}

/** A user's decision on a pending tool confirmation. */
export class ChannelConfirmationResultEvent {
    readonly channelId: string;
    readonly chatId: string;
    readonly channelUserId: string;
    readonly agentId: string;
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly approved: boolean;
    readonly actor: string;

    constructor(options: ChannelConfirmationResultEventOptions) {
        this.channelId = options.channelId;
        this.chatId = options.chatId;
        this.channelUserId = options.channelUserId;
        this.agentId = options.agentId ?? '';
        this.sessionId = options.sessionId ?? '';
        this.toolCallId = options.toolCallId;
        this.approved = options.approved;
        this.actor = options.actor ?? '';
    }

    toJSON(): Record<string, unknown> {
        return {
            channel_id: this.channelId,
            chat_id: this.chatId,
            channel_user_id: this.channelUserId,
            agent_id: this.agentId,
            session_id: this.sessionId,
            tool_call_id: this.toolCallId,
            approved: this.approved,
            actor: this.actor,
        };
    }
}

/** Mutable live connection state owned by a channel adapter. */
export class ChannelStatus {
    constructor(
        public state = 'stopped',
        public lastError = ''
    ) {}

    toJSON(): Record<string, unknown> {
        return { state: this.state, last_error: this.lastError };
    }
}

/** One node's timestamped report for a channel connection. */
export class ChannelHeartbeat {
    constructor(
        readonly status: ChannelStatus,
        readonly reportedAt: number
    ) {}

    isFresh(now: number): boolean {
        return now - this.reportedAt <= LIVENESS_TTL_SECONDS;
    }

    toJSON(): Record<string, unknown> {
        return { status: this.status, reported_at: this.reportedAt };
    }

    static parse(value: string): ChannelHeartbeat {
        const parsed = ChannelHeartbeatWireSchema.parse(JSON.parse(value));
        return new ChannelHeartbeat(
            new ChannelStatus(parsed.status.state, parsed.status.last_error),
            parsed.reported_at
        );
    }
}

export enum ChatKind {
    GROUP = 'group',
    PRIVATE = 'private',
}

/** Declarative platform send capabilities. */
export class ChannelCapability {
    readonly text: boolean;
    readonly markdown: boolean;
    readonly image: boolean;
    readonly file: boolean;
    readonly interactive: boolean;
    readonly streaming: boolean;
    readonly maxMessageLength: number;

    constructor(options: Partial<ChannelCapability> = {}) {
        this.text = options.text ?? true;
        this.markdown = options.markdown ?? false;
        this.image = options.image ?? false;
        this.file = options.file ?? false;
        this.interactive = options.interactive ?? false;
        this.streaming = options.streaming ?? false;
        this.maxMessageLength = options.maxMessageLength ?? 4000;
    }

    toJSON(): Record<string, unknown> {
        return {
            text: this.text,
            markdown: this.markdown,
            image: this.image,
            file: this.file,
            interactive: this.interactive,
            streaming: this.streaming,
            max_message_length: this.maxMessageLength,
        };
    }
}

export type ChannelInboundEvent = ChannelEvent | ChannelConfirmationResultEvent;
export type ChannelEmitter = (event: ChannelInboundEvent) => Promise<void>;

/** Static metadata and validators carried by a channel implementation class. */
export interface ChannelConstructor {
    new (
        channelId: string,
        credentials: Record<string, unknown>,
        config: Record<string, unknown>
    ): ChannelBase;
    readonly channelType: string;
    readonly displayName: string;
    readonly platformBotIdField: string;
    readonly description?: string;
    readonly iconUrl?: string;
    readonly credentialsSchema: z.ZodType<Record<string, unknown>>;
    readonly configSchema: z.ZodType<Record<string, unknown>>;
    readonly credentialBinding?: CredentialBindingConstructor | null;
}

/** Base contract shared by every platform channel. */
export abstract class ChannelBase {
    static readonly channelType: string = '';
    static readonly displayName: string = '';
    static readonly platformBotIdField: string = '';
    static readonly description: string = '';
    static readonly iconUrl: string = '';
    static readonly credentialsSchema: z.ZodType<Record<string, unknown>> = z.object({});
    static readonly configSchema: z.ZodType<Record<string, unknown>> = z.object({});
    static readonly credentialBinding: CredentialBindingConstructor | null = null;

    readonly capabilities = new ChannelCapability();
    readonly status = new ChannelStatus();

    abstract readonly channelId: string;

    get displayName(): string {
        const constructor = this.constructor as ChannelConstructor;
        return constructor.displayName || constructor.channelType;
    }

    abstract startListening(emit: ChannelEmitter, signal?: AbortSignal): Promise<void>;

    abstract sendResponse(event: ChannelEvent, events: AsyncIterable<BusPayload>): Promise<void>;

    async close(): Promise<void> {}

    async sendReaction(_event: ChannelEvent, _emojiType: string): Promise<string | null> {
        return null;
    }

    async removeReaction(_event: ChannelEvent, _reactionId: string): Promise<void> {}

    async listBotChats(): Promise<Record<string, unknown>[]> {
        return [];
    }

    async chatKind(_chatId: string): Promise<ChatKind | null> {
        return null;
    }

    async chatName(_chatId: string): Promise<string> {
        return '';
    }

    async listTools(_workspace: WorkspaceBase): Promise<ToolBase[]> {
        return [];
    }

    protected render(
        reply: Msg | null,
        options: { showThinking?: boolean; showToolProcess?: boolean } = {}
    ): ChannelContentBlock[] {
        if (!reply) return [];
        const parts: string[] = [];
        const data: DataBlock[] = [];
        for (const block of reply.content) {
            if (block.type === 'text') parts.push(block.text);
            else if (block.type === 'data') data.push(block);
            else if (block.type === 'thinking' && options.showThinking) {
                parts.push(`💭 ${block.thinking}`);
            } else if (block.type === 'tool_call' && options.showToolProcess) {
                parts.push(`🔧 Calling tool: ${block.name}`);
            } else if (
                block.type === 'tool_result' &&
                options.showToolProcess &&
                typeof block.output === 'string'
            ) {
                parts.push(block.output);
            }
        }
        let text = parts
            .filter(part => part.trim())
            .join('\n\n')
            .trim();
        if (reply.finished_reason === ReplyFinishedReason.ERROR) text ||= AGENT_ERROR_REPLY;
        else if (!text && data.length === 0) text = NO_TEXT_REPLY;
        return [...(text ? [TextBlock({ text })] : []), ...data];
    }

    protected splitLongMessage(text: string): string[] {
        const limit = this.capabilities.maxMessageLength;
        if (text.length <= limit) return [text];
        const chunks: string[] = [];
        for (let offset = 0; offset < text.length; offset += limit) {
            chunks.push(text.slice(offset, offset + limit));
        }
        return chunks;
    }

    protected foldEvent(reply: Msg, raw: BusPayload): AgentEvent {
        const event = parseAgentEvent(raw);
        if (event.type !== EventType.REPLY_START) appendEvent(reply, event);
        return event;
    }
}

const ChannelEventWireSchema = z.object({
    channel_id: z.string(),
    channel_user_id: z.string(),
    channel_user_name: z.string().default(''),
    chat_id: z.string(),
    chat_name: z.string().default(''),
    channel_message_id: z.string().nullable().default(null),
    content: z.array(z.union([TextBlockSchema, DataBlockSchema])).default([]),
    metadata: z.record(z.string(), z.unknown()).default({}),
    received_at: z.string().default(() => new Date().toISOString()),
});

const ChannelHeartbeatWireSchema = z.object({
    status: z.object({ state: z.string().default('stopped'), last_error: z.string().default('') }),
    reported_at: z.number(),
});

export function parseChannelEvent(input: unknown): ChannelEvent {
    const value = ChannelEventWireSchema.parse(input);
    return new ChannelEvent({
        channelId: value.channel_id,
        channelUserId: value.channel_user_id,
        channelUserName: value.channel_user_name,
        chatId: value.chat_id,
        chatName: value.chat_name,
        channelMessageId: value.channel_message_id,
        content: value.content,
        metadata: value.metadata,
        receivedAt: value.received_at,
    });
}
