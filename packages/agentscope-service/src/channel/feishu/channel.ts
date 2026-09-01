/* eslint-disable jsdoc/require-jsdoc */

import {
    EventType,
    parseAgentEvent,
    type RequireUserConfirmEvent,
} from '@agentscope-ai/agentscope/event';
import { logger } from '@agentscope-ai/agentscope/logger';
import {
    Base64Source,
    createMsg,
    DataBlock,
    TextBlock,
    type Msg,
} from '@agentscope-ai/agentscope/message';
import type { ToolBase } from '@agentscope-ai/agentscope/tool';
import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';
import { z } from 'zod';

import type { BusPayload } from '../../message-bus';
import {
    ChannelBase,
    ChannelCapability,
    ChannelConfirmationResultEvent,
    ChannelEvent,
    ChannelStatus,
    ChatKind,
    type ChannelContentBlock,
    type ChannelEmitter,
} from '../base';
import {
    buildFeishuActionResponse,
    buildFeishuApprovalCard,
    buildFeishuToast,
    parseFeishuAction,
} from './card-templates';
import { FeishuCredentialBinding } from './credential-binding';
import {
    OfficialFeishuDriver,
    type FeishuCardActionEvent,
    type FeishuNormalizedMessage,
    type FeishuPlatformDriver,
} from './driver';
import {
    FeishuListChatMembers,
    FeishuListChats,
    FeishuSendFile,
    FeishuSendImage,
    FeishuSendMessage,
    type FeishuReceiveIdType,
} from './tools';

const MAX_LENGTH = 4000;
const STREAM_MIN_INTERVAL_MS = 700;
const MAX_CONNECT_ATTEMPTS = 2;
const MEDIA_TYPES = new Set(['image', 'audio', 'media', 'file']);

export const FeishuCredentialsSchema = z.object({
    app_id: z.string().describe('Feishu App ID').meta({ title: 'App ID' }),
    app_secret: z
        .string()
        .describe('Feishu App Secret')
        .meta({ title: 'App Secret', format: 'password' }),
});

export const FeishuConfigSchema = z.object({
    only_at_reply: z
        .boolean()
        .default(true)
        .describe('In group chats, reply only when the bot is @mentioned')
        .meta({ title: 'Reply only when mentioned' }),
    show_tool_process: z
        .boolean()
        .default(false)
        .describe('Show tool calls and results inline in the reply')
        .meta({ title: 'Show tool process' }),
    show_thinking: z
        .boolean()
        .default(false)
        .describe("Show the model's reasoning inline in the reply")
        .meta({ title: 'Show thinking' }),
});

export type FeishuCredentials = z.infer<typeof FeishuCredentialsSchema>;
export type FeishuConfig = z.infer<typeof FeishuConfigSchema>;

export interface FeishuChannelOptions {
    driver?: FeishuPlatformDriver;
    now?: () => number;
    delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/** Feishu/Lark long-connection channel backed by the official Node channel SDK. */
export class FeishuChannel extends ChannelBase {
    static readonly channelType = 'feishu';
    static readonly displayName = 'Feishu (Lark)';
    static readonly description = 'Group and direct-message bot with card interactions.';
    static readonly iconUrl = 'https://www.google.com/s2/favicons?domain=feishu.cn&sz=128';
    static readonly platformBotIdField = 'app_id';
    static readonly credentialsSchema = FeishuCredentialsSchema;
    static readonly configSchema = FeishuConfigSchema;
    static readonly credentialBinding = FeishuCredentialBinding;

    readonly channelId: string;
    readonly status = new ChannelStatus();
    readonly capabilities = new ChannelCapability({
        text: true,
        markdown: true,
        image: true,
        file: true,
        interactive: true,
        streaming: true,
        maxMessageLength: MAX_LENGTH,
    });
    readonly config: FeishuConfig;
    private readonly driver: FeishuPlatformDriver;
    private readonly now: () => number;
    private readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    private readonly stopController = new AbortController();
    private emit: ChannelEmitter | null = null;
    private readonly streamSequences = new Map<string, number>();
    private readonly chatNames = new Map<string, string>();
    private readonly chatKinds = new Map<string, ChatKind>();

    constructor(
        channelId: string,
        credentials: Record<string, unknown>,
        config: Record<string, unknown>,
        options: FeishuChannelOptions = {}
    ) {
        super();
        const auth = FeishuCredentialsSchema.parse(credentials);
        this.config = FeishuConfigSchema.parse(config);
        this.channelId = channelId;
        this.driver =
            options.driver ??
            new OfficialFeishuDriver({
                appId: auth.app_id,
                appSecret: auth.app_secret,
                onlyAtReply: this.config.only_at_reply,
            });
        this.now = options.now ?? (() => Date.now());
        this.delay = options.delay ?? abortableDelay;
    }

    async startListening(emit: ChannelEmitter, signal?: AbortSignal): Promise<void> {
        this.emit = emit;
        const combined = combineSignals(signal, this.stopController.signal);
        this.status.state = 'connecting';
        this.status.lastError = '';
        let attempts = 0;
        let backoff = 1_000;
        try {
            while (!combined.aborted) {
                try {
                    await this.driver.listen(
                        {
                            onMessage: message => this.onMessage(message),
                            onCardAction: event => this.onCardAction(event),
                            onState: (state, error) => {
                                this.status.state = state;
                                this.status.lastError = error ?? '';
                            },
                        },
                        combined
                    );
                    if (!combined.aborted) throw new Error('Feishu channel stopped unexpectedly');
                } catch (error) {
                    if (combined.aborted) break;
                    attempts += 1;
                    this.status.state = attempts >= MAX_CONNECT_ATTEMPTS ? 'failed' : 'retrying';
                    this.status.lastError = errorMessage(error);
                    logger.error(
                        `Feishu WS '${this.channelId}' connect failed: ${errorMessage(error)}`
                    );
                    if (attempts >= MAX_CONNECT_ATTEMPTS) {
                        await waitForAbort(combined);
                        break;
                    }
                    await this.delay(backoff, combined);
                    backoff = Math.min(backoff * 2, 30_000);
                }
            }
        } finally {
            await this.driver.close();
            this.status.state = 'stopped';
        }
    }

    async close(): Promise<void> {
        this.stopController.abort();
        await this.driver.close();
        this.status.state = 'stopped';
    }

    async sendResponse(event: ChannelEvent, events: AsyncIterable<BusPayload>): Promise<void> {
        let reply: Msg | null = null;
        let confirm: RequireUserConfirmEvent | null = null;
        let cardId: string | null = null;
        let cardOpenFailed = false;
        let lastUpdate = 0;
        for await (const raw of events) {
            const agentEvent = reply ? this.foldEvent(reply, raw) : parseAgentEvent(raw);
            if (agentEvent.type === EventType.REQUIRE_USER_CONFIRM) {
                confirm = agentEvent;
                break;
            }
            if ('reply_id' in agentEvent && !reply) {
                reply = createMsg({
                    id: agentEvent.reply_id,
                    name:
                        'name' in agentEvent ? String(agentEvent.name || 'assistant') : 'assistant',
                    role: 'assistant',
                    content: [],
                });
                this.foldEvent(reply, raw);
            }
            if (agentEvent.type === EventType.REPLY_END) break;
            if (cardOpenFailed || !reply) continue;
            const text = textFromBlocks(
                this.render(reply, {
                    showThinking: this.config.show_thinking,
                    showToolProcess: this.config.show_tool_process,
                })
            );
            if (!text) continue;
            if (!cardId) {
                cardId = await this.openStreamingCard(event);
                if (!cardId) {
                    cardOpenFailed = true;
                    continue;
                }
            }
            const now = this.now();
            if (now - lastUpdate >= STREAM_MIN_INTERVAL_MS) {
                lastUpdate = now;
                await this.pushStreamingCard(cardId, text, false);
            }
        }

        const blocks = this.render(reply, {
            showThinking: this.config.show_thinking,
            showToolProcess: this.config.show_tool_process,
        });
        const text = textFromBlocks(blocks);
        if (cardId) {
            await this.pushStreamingCard(cardId, text, true);
        } else if (text) {
            for (const part of this.splitLongMessage(text)) {
                await this.driver.send(
                    event.chatId,
                    { text: part },
                    event.channelMessageId ? { replyTo: event.channelMessageId } : undefined
                );
            }
        }
        if (cardId) this.streamSequences.delete(cardId);
        for (const block of blocks) {
            if (block.type !== 'data' || block.source.type !== 'base64') continue;
            const data = Buffer.from(block.source.data, 'base64');
            if (block.source.media_type.startsWith('image/')) {
                await this.sendImageTo(event.chatId, 'chat_id', data);
            } else {
                await this.sendFileTo(event.chatId, 'chat_id', data, block.name || 'file');
            }
        }
        if (confirm) await this.presentConfirm(event, confirm);
    }

    async sendReaction(event: ChannelEvent, emojiType: string): Promise<string | null> {
        return event.channelMessageId
            ? this.driver.addReaction(event.channelMessageId, emojiType)
            : null;
    }

    async removeReaction(event: ChannelEvent, reactionId: string): Promise<void> {
        if (event.channelMessageId) {
            await this.driver.removeReaction(event.channelMessageId, reactionId);
        }
    }

    async chatName(chatId: string): Promise<string> {
        if (!chatId) return '';
        const cached = this.chatNames.get(chatId);
        if (cached) return cached;
        const info = await this.driver.getChatInfo(chatId);
        const name = info?.name ?? '';
        if (name) this.chatNames.set(chatId, name);
        return name;
    }

    async chatKind(chatId: string): Promise<ChatKind | null> {
        if (!chatId) return null;
        const cached = this.chatKinds.get(chatId);
        if (cached) return cached;
        const info = await this.driver.getChatInfo(chatId);
        const kind = info?.chatType === 'p2p' ? ChatKind.PRIVATE : info ? ChatKind.GROUP : null;
        if (kind) this.chatKinds.set(chatId, kind);
        return kind;
    }

    async listBotChats(): Promise<Record<string, unknown>[]> {
        const chats = await this.driver.listChats();
        return Promise.all(
            chats.map(async chat => ({
                chat_id: chat.id,
                name: chat.name,
                chat_type: (await this.driver.getChatInfo(chat.id))?.chatType ?? '',
            }))
        );
    }

    async listChatMembers(chatId: string): Promise<Record<string, unknown>[]> {
        return (await this.driver.getChatMembers(chatId)).map(member => ({
            open_id: member.id,
            name: member.name ?? '',
        }));
    }

    async listTools(workspace: WorkspaceBase): Promise<ToolBase[]> {
        const backend = workspace.getBackend();
        return [
            new FeishuListChats(this, backend),
            new FeishuListChatMembers(this, backend),
            new FeishuSendMessage(this, backend),
            new FeishuSendFile(this, backend),
            new FeishuSendImage(this, backend),
        ];
    }

    async sendMessageTo(
        receiveId: string,
        receiveIdType: FeishuReceiveIdType,
        text: string
    ): Promise<Record<string, unknown> | null> {
        return this.driver.send(receiveId, { text }, receiveIdType === 'chat_id' ? undefined : {});
    }

    async sendFileTo(
        receiveId: string,
        _receiveIdType: FeishuReceiveIdType,
        data: Uint8Array,
        fileName: string
    ): Promise<Record<string, unknown> | null> {
        return this.driver.send(receiveId, { file: { source: Buffer.from(data), fileName } });
    }

    async sendImageTo(
        receiveId: string,
        _receiveIdType: FeishuReceiveIdType,
        data: Uint8Array
    ): Promise<Record<string, unknown> | null> {
        return this.driver.send(receiveId, { image: { source: Buffer.from(data) } });
    }

    async onMessage(message: FeishuNormalizedMessage): Promise<void> {
        try {
            if (message.chatType === 'group') {
                this.chatKinds.set(message.chatId, ChatKind.GROUP);
            } else if (message.chatType === 'p2p') {
                this.chatKinds.set(message.chatId, ChatKind.PRIVATE);
            }
            const content = await this.normalizeContent(message);
            if (content.length === 0 || !this.emit) return;
            const chatName =
                message.chatType === 'group' ? await this.chatName(message.chatId) : '';
            await this.emit(
                new ChannelEvent({
                    channelId: this.channelId,
                    channelUserId: message.senderId,
                    channelUserName: message.senderName ?? '',
                    chatId: message.chatId,
                    chatName,
                    channelMessageId: message.messageId,
                    content,
                    metadata: {
                        chat_type: message.chatType,
                        tenant_key: extractTenantKey(message.raw),
                    },
                })
            );
        } catch (error) {
            logger.error(
                `Feishu '${this.channelId}' message handling failed: ${errorMessage(error)}`
            );
        }
    }

    async onCardAction(event: FeishuCardActionEvent): Promise<Record<string, unknown>> {
        const decision = parseFeishuAction(event.action.value);
        if (!decision) return buildFeishuToast(false);
        if (this.emit) {
            await this.emit(
                new ChannelConfirmationResultEvent({
                    channelId: this.channelId,
                    chatId: decision.chatId,
                    channelUserId: event.operator.openId,
                    agentId: decision.agentId,
                    sessionId: decision.sessionId,
                    toolCallId: decision.toolCallId,
                    approved: decision.approved,
                })
            );
        }
        return buildFeishuActionResponse(decision.approved);
    }

    private async openStreamingCard(event: ChannelEvent): Promise<string | null> {
        const cardId = await this.driver.createCard(streamingCard('', true));
        if (!cardId) return null;
        const sent = await this.driver.send(
            event.chatId,
            { cardId },
            event.channelMessageId ? { replyTo: event.channelMessageId } : undefined
        );
        if (!sent || Number(sent.code) !== 0) return null;
        this.streamSequences.set(cardId, 0);
        return cardId;
    }

    private async pushStreamingCard(
        cardId: string,
        text: string,
        finalize: boolean
    ): Promise<boolean> {
        const sequence = (this.streamSequences.get(cardId) ?? 0) + 1;
        this.streamSequences.set(cardId, sequence);
        return this.driver.updateCard(cardId, streamingCard(text, !finalize), sequence);
    }

    private async presentConfirm(
        event: ChannelEvent,
        request: RequireUserConfirmEvent
    ): Promise<void> {
        for (const tool of request.tool_calls) {
            await this.driver.send(
                event.chatId,
                {
                    card: buildFeishuApprovalCard({
                        toolCallId: tool.id,
                        chatId: event.chatId,
                        toolName: tool.name,
                        summary: tool.input.slice(0, 800),
                        agentId: String(event.metadata.agent_id ?? ''),
                        sessionId: String(event.metadata.session_id ?? ''),
                    }),
                },
                event.channelMessageId ? { replyTo: event.channelMessageId } : undefined
            );
        }
    }

    private async normalizeContent(
        message: FeishuNormalizedMessage
    ): Promise<ChannelContentBlock[]> {
        if (message.rawContentType === 'post') {
            const post = extractPost(message.raw);
            if (post) return this.parsePost(post, message.messageId);
        }
        if (message.rawContentType !== 'text' && !MEDIA_TYPES.has(message.rawContentType)) {
            await this.driver.send(
                message.chatId,
                { text: `Unsupported message type: ${message.rawContentType}.` },
                message.messageId ? { replyTo: message.messageId } : undefined
            );
            return [];
        }
        const blocks: ChannelContentBlock[] = [];
        for (const resource of message.resources) {
            const type = resource.type === 'image' ? 'image' : 'file';
            const downloaded = await this.driver.downloadResource(
                message.messageId,
                resource.fileKey,
                type
            );
            if (!downloaded) continue;
            blocks.push(
                DataBlock({
                    source: Base64Source({
                        data: downloaded.buffer.toString('base64'),
                        media_type: downloaded.contentType ?? defaultFeishuMime(resource.type),
                    }),
                    name: resource.fileName ?? resource.type,
                })
            );
        }
        if (MEDIA_TYPES.has(message.rawContentType)) return blocks;
        let text = (extractRawFeishuText(message.raw) ?? message.content).trim();
        if (message.chatType === 'group' && this.config.only_at_reply) {
            for (const key of extractRawFeishuMentionKeys(message.raw)) {
                text = text.split(key).join('').trim();
            }
        }
        if (text) blocks.push(TextBlock({ text }));
        return blocks;
    }

    private async parsePost(
        content: Record<string, unknown>,
        messageId: string
    ): Promise<ChannelContentBlock[]> {
        const blocks: ChannelContentBlock[] = [];
        let text = typeof content.title === 'string' && content.title ? `${content.title}\n` : '';
        const flush = () => {
            const shown = text.trim();
            text = '';
            if (shown) blocks.push(TextBlock({ text: shown }));
        };
        for (const rawRow of Array.isArray(content.content) ? content.content : []) {
            for (const rawElement of Array.isArray(rawRow) ? rawRow : []) {
                const element = asRecord(rawElement);
                const tag = String(element.tag ?? '');
                if (tag === 'text') text += String(element.text ?? '');
                else if (tag === 'a') text += String(element.text ?? element.href ?? '');
                else if (tag === 'img' || tag === 'media') {
                    const key = String(element.image_key ?? element.file_key ?? '');
                    if (!key) continue;
                    flush();
                    const downloaded = await this.driver.downloadResource(
                        messageId,
                        key,
                        tag === 'img' ? 'image' : 'file'
                    );
                    if (downloaded) {
                        blocks.push(
                            DataBlock({
                                source: Base64Source({
                                    data: downloaded.buffer.toString('base64'),
                                    media_type:
                                        downloaded.contentType ??
                                        (tag === 'img' ? 'image/png' : 'video/mp4'),
                                }),
                                name: tag,
                            })
                        );
                    }
                }
            }
            text += '\n';
        }
        flush();
        return blocks;
    }
}

function streamingCard(text: string, streaming: boolean): Record<string, unknown> {
    return {
        schema: '2.0',
        config: { streaming_mode: streaming },
        body: {
            elements: [{ tag: 'markdown', element_id: 'md', content: text }],
        },
    };
}

function textFromBlocks(blocks: ChannelContentBlock[]): string {
    return blocks
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
}

function defaultFeishuMime(type: string): string {
    return (
        {
            image: 'image/png',
            audio: 'audio/ogg',
            video: 'video/mp4',
        }[type] ?? 'application/octet-stream'
    );
}

function extractPost(raw: unknown): Record<string, unknown> | null {
    const message = extractRawFeishuMessage(raw);
    const value = message.content;
    if (typeof value !== 'string') return null;
    try {
        return asRecord(JSON.parse(value));
    } catch {
        return null;
    }
}

function extractRawFeishuText(raw: unknown): string | null {
    const value = extractRawFeishuMessage(raw).content;
    if (typeof value !== 'string') return null;
    try {
        const parsed = asRecord(JSON.parse(value));
        return typeof parsed.text === 'string' ? parsed.text : null;
    } catch {
        return null;
    }
}

function extractRawFeishuMentionKeys(raw: unknown): string[] {
    const mentions = extractRawFeishuMessage(raw).mentions;
    if (!Array.isArray(mentions)) return [];
    return mentions.map(value => String(asRecord(value).key ?? '')).filter(Boolean);
}

function extractRawFeishuMessage(raw: unknown): Record<string, unknown> {
    const root = asRecord(raw);
    const event = asRecord(root.event);
    return asRecord(event.message ?? root.message);
}

function extractTenantKey(raw: unknown): string {
    const root = asRecord(raw);
    return String(asRecord(root.header).tenant_key ?? '');
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function combineSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
    if (!first) return second;
    if (first.aborted || second.aborted) return AbortSignal.abort();
    const controller = new AbortController();
    const abort = () => controller.abort();
    first.addEventListener('abort', abort, { once: true });
    second.addEventListener('abort', abort, { once: true });
    return controller.signal;
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>(resolve =>
        signal.addEventListener('abort', () => resolve(), { once: true })
    );
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>(resolve => {
        const timer = setTimeout(done, milliseconds);
        function done() {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        }
        signal.addEventListener('abort', done, { once: true });
    });
}
