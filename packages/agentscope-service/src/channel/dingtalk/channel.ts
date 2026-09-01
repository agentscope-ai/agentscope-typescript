/* eslint-disable jsdoc/require-jsdoc */

import path from 'node:path';

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
    type DataBlock as DataBlockType,
    type Msg,
} from '@agentscope-ai/agentscope/message';
import type { ToolBase } from '@agentscope-ai/agentscope/tool';
import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';
import { extension as mimeExtension, lookup as mimeLookup } from 'mime-types';
import { z } from 'zod';

import {
    buildDingTalkApprovalCardData,
    buildResolvedDingTalkCardData,
    dingTalkTrackingId,
    parseDingTalkCardCallback,
} from './card';
import { DingTalkOpenAPI, type DingTalkFetch } from './openapi';
import { NativeDingTalkStreamTransport, type DingTalkStreamTransport } from './stream';
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
    DingTalkListConversations,
    DingTalkListUsers,
    DingTalkSendFile,
    DingTalkSendImage,
    DingTalkSendMessage,
} from './tools';

const GROUP_CONVERSATION = '2';
const MAX_LENGTH = 4000;
const AI_CARD_TEMPLATE_ID = '8aebdfb9-28f4-4a98-98f5-396c3dde41a0.schema';
const AI_CARD_CONTENT_KEY = 'content';
const APPROVAL_CARD_TEMPLATE_ID = '382e4302-551d-4880-bf29-a30acfab2e71.schema';
const STREAM_MIN_INTERVAL_MS = 300;
const STREAM_FALLBACK_NOTICE =
    'Streaming stopped. The complete reply follows as a Markdown message.';
const DEFAULT_MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MEDIA_MESSAGE_TYPES = new Set(['audio', 'file', 'picture', 'richText', 'video']);

export const DingTalkCredentialsSchema = z.object({
    client_id: z
        .string()
        .describe('DingTalk application Client ID (AppKey)')
        .meta({ title: 'Client ID' }),
    client_secret: z
        .string()
        .describe('DingTalk application Client Secret (AppSecret)')
        .meta({ title: 'Client Secret', format: 'password' }),
});

export const DingTalkConfigSchema = z.object({
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
    max_media_bytes: z
        .number()
        .int()
        .min(1)
        .max(100 * 1024 * 1024)
        .default(DEFAULT_MAX_MEDIA_BYTES)
        .describe('Maximum bytes accepted for one inbound or outbound attachment')
        .meta({ title: 'Maximum media size' }),
    approval_card_template_id: z
        .string()
        .default(APPROVAL_CARD_TEMPLATE_ID)
        .describe(
            'DingTalk Card Platform template used for tool approval. Defaults to the published card the channel builds its own layout on; tool calls needing approval stall if it is cleared.'
        )
        .meta({ title: 'Approval card template ID' }),
    streaming_card_template_id: z
        .string()
        .default(AI_CARD_TEMPLATE_ID)
        .describe(
            'DingTalk AI Card template used for streaming replies. Defaults to the public template the official SDK uses; clear it to reply in plain Markdown instead.'
        )
        .meta({ title: 'Streaming card template ID' }),
    streaming_card_key: z
        .string()
        .min(1)
        .default(AI_CARD_CONTENT_KEY)
        .describe('Template variable key of the AI Card streaming component.')
        .meta({ title: 'Streaming card content key' }),
});

export type DingTalkCredentials = z.infer<typeof DingTalkCredentialsSchema>;
export type DingTalkConfig = z.infer<typeof DingTalkConfigSchema>;

export interface DingTalkAPI {
    downloadMedia(downloadCode: string, maxBytes: number): Promise<[Buffer, string] | null>;
    sendMedia(
        chatId: string,
        data: Uint8Array,
        fileName: string,
        mediaType: string
    ): Promise<boolean>;
    sendText(chatId: string, text: string): Promise<boolean>;
    createApprovalCard(
        chatId: string,
        approverId: string,
        templateId: string,
        cardData: Record<string, string>,
        outTrackId?: string
    ): Promise<string | null>;
    createStreamingCard(
        chatId: string,
        templateId: string,
        contentKey: string
    ): Promise<string | null>;
    streamCard(
        outTrackId: string,
        contentKey: string,
        content: string,
        options?: { finalize?: boolean; isError?: boolean }
    ): Promise<boolean>;
    updateApprovalCard(outTrackId: string, cardData: Record<string, string>): Promise<boolean>;
    searchUsers(query: string, limit: number): Promise<Record<string, unknown>[]>;
}

export interface DingTalkChannelOptions {
    api?: DingTalkAPI;
    stream?: DingTalkStreamTransport;
    fetch?: DingTalkFetch;
    now?: () => number;
}

/** DingTalk enterprise application robot channel. */
export class DingTalkChannel extends ChannelBase {
    static readonly channelType = 'dingtalk';
    static readonly displayName = 'DingTalk';
    static readonly description = 'Enterprise robot for DingTalk groups and direct messages.';
    static readonly iconUrl = 'https://www.google.com/s2/favicons?domain=dingtalk.com&sz=128';
    static readonly platformBotIdField = 'client_id';
    static readonly credentialsSchema = DingTalkCredentialsSchema;
    static readonly configSchema = DingTalkConfigSchema;

    readonly channelId: string;
    readonly status = new ChannelStatus();
    readonly capabilities: ChannelCapability;
    readonly config: DingTalkConfig;
    private readonly api: DingTalkAPI;
    private readonly stream: DingTalkStreamTransport;
    private readonly now: () => number;
    private emit: ChannelEmitter | null = null;
    private readonly chatNames = new Map<string, string>();

    constructor(
        channelId: string,
        credentials: Record<string, unknown>,
        config: Record<string, unknown>,
        options: DingTalkChannelOptions = {}
    ) {
        super();
        const auth = DingTalkCredentialsSchema.parse(credentials);
        this.config = DingTalkConfigSchema.parse(config);
        this.channelId = channelId;
        this.capabilities = new ChannelCapability({
            text: true,
            markdown: true,
            image: true,
            file: true,
            interactive: true,
            streaming: Boolean(this.config.streaming_card_template_id),
            maxMessageLength: MAX_LENGTH,
        });
        this.api =
            options.api ??
            new DingTalkOpenAPI({
                clientId: auth.client_id,
                clientSecret: auth.client_secret,
                fetch: options.fetch,
            });
        this.stream =
            options.stream ??
            new NativeDingTalkStreamTransport({
                clientId: auth.client_id,
                clientSecret: auth.client_secret,
                fetch: options.fetch,
            });
        this.now = options.now ?? (() => Date.now());
    }

    async startListening(emit: ChannelEmitter, signal: AbortSignal = new AbortController().signal) {
        this.emit = emit;
        this.status.state = 'connecting';
        this.status.lastError = '';
        try {
            await this.stream.listen(
                {
                    onMessage: payload => this.onCallback(payload),
                    onCardAction: payload => this.onCardCallback(payload),
                    onState: (state, error) => {
                        this.status.state = state;
                        this.status.lastError = error ?? '';
                    },
                },
                signal
            );
            if (!signal.aborted) throw new Error('DingTalk Stream client stopped unexpectedly');
        } catch (error) {
            if (signal.aborted) return;
            this.status.state = 'failed';
            this.status.lastError = errorMessage(error);
            logger.error(
                `DingTalk '${this.channelId}' Stream client failed: ${errorMessage(error)}`
            );
            await waitForAbort(signal);
        } finally {
            await this.stream.close();
            this.status.state = 'stopped';
        }
    }

    async close(): Promise<void> {
        await this.stream.close();
        this.status.state = 'stopped';
    }

    async sendResponse(event: ChannelEvent, events: AsyncIterable<BusPayload>): Promise<void> {
        let reply: Msg | null = null;
        let confirm: RequireUserConfirmEvent | null = null;
        let streamRef: string | null = null;
        let streamFailed = false;
        let lastStreamUpdate = 0;
        for await (const raw of events) {
            const agentEvent = this.parseAndFold(raw, reply);
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
            if (
                !this.capabilities.streaming ||
                streamFailed ||
                !reply ||
                !this.hasStreamingText(reply)
            ) {
                continue;
            }
            const text = textFromBlocks(
                this.render(reply, {
                    showThinking: this.config.show_thinking,
                    showToolProcess: this.config.show_tool_process,
                })
            );
            if (!text) continue;
            if (!streamRef) {
                streamRef = await this.api.createStreamingCard(
                    event.chatId,
                    this.config.streaming_card_template_id,
                    this.config.streaming_card_key
                );
                if (!streamRef) {
                    streamFailed = true;
                    continue;
                }
            }
            const now = this.now();
            if (now - lastStreamUpdate >= STREAM_MIN_INTERVAL_MS) {
                lastStreamUpdate = now;
                if (!(await this.updateStreamingCard(streamRef, text))) streamFailed = true;
            }
        }

        const blocks = this.render(reply, {
            showThinking: this.config.show_thinking,
            showToolProcess: this.config.show_tool_process,
        });
        const text = textFromBlocks(blocks);
        const streamed = await this.finishStreamingCard(streamRef, text);
        for (const block of blocks) {
            if (block.type === 'text') {
                if (streamed) continue;
                for (const part of this.splitLongMessage(block.text)) {
                    if (part) await this.api.sendText(event.chatId, part);
                }
            } else {
                await this.sendData(event.chatId, block);
            }
        }
        if (confirm) await this.presentConfirm(event, confirm, reply?.name ?? '');
    }

    async chatKind(chatId: string): Promise<ChatKind | null> {
        if (chatId.startsWith('group:')) return ChatKind.GROUP;
        if (chatId.startsWith('user:')) return ChatKind.PRIVATE;
        return null;
    }

    async chatName(chatId: string): Promise<string> {
        return this.chatNames.get(chatId) ?? '';
    }

    async listBotChats(): Promise<Record<string, unknown>[]> {
        return [...this.chatNames].map(([chatId, name]) => ({
            chat_id: chatId,
            name,
            chat_type: chatId.startsWith('group:') ? 'group' : 'private',
        }));
    }

    async listTools(workspace: WorkspaceBase): Promise<ToolBase[]> {
        const backend = workspace.getBackend();
        return [
            new DingTalkListConversations(this, backend),
            new DingTalkListUsers(this, backend),
            new DingTalkSendMessage(this, backend),
            new DingTalkSendFile(this, backend),
            new DingTalkSendImage(this, backend),
        ];
    }

    async searchUsers(query: string, limit = 20): Promise<Record<string, unknown>[]> {
        return this.api.searchUsers(query, limit);
    }

    async sendMessageTo(target: string, text: string): Promise<boolean> {
        return this.api.sendText(target, text);
    }

    async sendFileTo(target: string, data: Uint8Array, fileName: string): Promise<boolean> {
        if (data.byteLength > this.config.max_media_bytes) {
            logger.warning('DingTalk outbound media exceeds the size limit');
            return false;
        }
        return this.api.sendMedia(target, data, safeFileName(fileName), 'application/octet-stream');
    }

    async sendImageTo(target: string, data: Uint8Array, fileName: string): Promise<boolean> {
        if (data.byteLength > this.config.max_media_bytes) {
            logger.warning('DingTalk outbound media exceeds the size limit');
            return false;
        }
        const name = safeFileName(fileName);
        const mediaType = String(mimeLookup(name) || '');
        if (!mediaType.startsWith('image/')) {
            logger.warning('DingTalk SendImage requires an image file');
            return false;
        }
        return this.api.sendMedia(target, data, name, mediaType);
    }

    async onCardCallback(payload: Record<string, unknown>): Promise<void> {
        const decision = parseDingTalkCardCallback(payload);
        if (!decision) {
            logger.warning(
                `DingTalk '${this.channelId}' ignored a card callback on '${String(payload.outTrackId ?? '')}'`
            );
            return;
        }
        if (this.emit) {
            await this.emit(
                new ChannelConfirmationResultEvent({
                    channelId: this.channelId,
                    chatId: decision.chatId,
                    channelUserId: decision.userId,
                    agentId: decision.agentId,
                    sessionId: decision.sessionId,
                    toolCallId: decision.toolCallId,
                    approved: decision.approved,
                    actor: decision.userId,
                })
            );
        }
        await this.api.updateApprovalCard(
            decision.outTrackId,
            buildResolvedDingTalkCardData(decision.approved)
        );
    }

    async onCallback(payload: Record<string, unknown>): Promise<void> {
        const conversationType = String(payload.conversationType ?? '');
        const isGroup = conversationType === GROUP_CONVERSATION;
        if (isGroup && this.config.only_at_reply && payload.isInAtList === false) return;
        const userId = String(payload.senderStaffId ?? payload.senderId ?? '');
        const conversationId = String(payload.conversationId ?? '');
        const targetId = isGroup ? conversationId : userId;
        if (!userId || !targetId) {
            logger.warning(
                `DingTalk '${this.channelId}' ignored message without stable sender/target`
            );
            return;
        }
        const chatId = `${isGroup ? 'group' : 'user'}:${targetId}`;
        const title = String(payload.conversationTitle ?? '');
        const senderName = String(payload.senderNick ?? '');
        this.chatNames.set(chatId, isGroup ? title : senderName);
        const content = await this.parseContent(payload);
        if (content.length === 0 || !this.emit) return;
        await this.emit(
            new ChannelEvent({
                channelId: this.channelId,
                channelUserId: userId,
                channelUserName: senderName,
                chatId,
                chatName: isGroup ? title : '',
                channelMessageId: String(payload.msgId ?? '') || null,
                content,
                metadata: {
                    chat_type: isGroup ? 'group' : 'private',
                    conversation_type: conversationType,
                },
            })
        );
    }

    private parseAndFold(raw: BusPayload, reply: Msg | null) {
        return reply ? this.foldEvent(reply, raw) : parseAgentEvent(raw);
    }

    private hasStreamingText(reply: Msg): boolean {
        return reply.content.some(block => {
            if (block.type === 'text') return Boolean(block.text.trim());
            if (block.type === 'thinking')
                return this.config.show_thinking && Boolean(block.thinking.trim());
            if (block.type === 'tool_call') return this.config.show_tool_process;
            return (
                block.type === 'tool_result' &&
                this.config.show_tool_process &&
                typeof block.output === 'string' &&
                Boolean(block.output.trim())
            );
        });
    }

    private updateStreamingCard(
        outTrackId: string,
        text: string,
        options: { finalize?: boolean; isError?: boolean } = {}
    ): Promise<boolean> {
        return this.api.streamCard(outTrackId, this.config.streaming_card_key, text, options);
    }

    private async finishStreamingCard(outTrackId: string | null, text: string): Promise<boolean> {
        if (!outTrackId || !text) return false;
        const updated = await this.updateStreamingCard(outTrackId, text, { finalize: true });
        if (!updated) {
            await this.updateStreamingCard(outTrackId, STREAM_FALLBACK_NOTICE, {
                finalize: true,
                isError: true,
            });
        }
        return updated;
    }

    private async presentConfirm(
        event: ChannelEvent,
        request: RequireUserConfirmEvent,
        agentName: string
    ): Promise<void> {
        const templateId = this.config.approval_card_template_id;
        if (!templateId) {
            logger.error(`DingTalk '${this.channelId}' cannot deliver tool approval cards`);
            await this.api.sendText(
                event.chatId,
                '无法展示工具审批卡片：审批卡片模板为空，请管理员配置。'
            );
            return;
        }
        const approverId = event.chatId.startsWith('user:') ? event.chatId.slice(5) : '';
        for (const tool of request.tool_calls) {
            const track = await this.api.createApprovalCard(
                event.chatId,
                approverId,
                templateId,
                buildDingTalkApprovalCardData(tool, agentName),
                dingTalkTrackingId(tool.id)
            );
            if (!track) {
                await this.api.sendText(
                    event.chatId,
                    '工具审批卡片投放失败，请管理员检查卡片模板与应用权限。'
                );
            }
        }
    }

    private async parseContent(payload: Record<string, unknown>) {
        const messageType = String(payload.msgtype ?? '');
        if (messageType === 'text') {
            const text = String(asRecord(payload.text).content ?? '').trim();
            return text ? [TextBlock({ text })] : [];
        }
        if (!MEDIA_MESSAGE_TYPES.has(messageType)) return [];
        const content = asRecord(payload.content);
        if (messageType === 'richText') return this.parseRichText(content);
        const blocks: Array<ReturnType<typeof TextBlock> | DataBlockType> = [];
        const recognition = String(content.recognition ?? '').trim();
        if (recognition) blocks.push(TextBlock({ text: recognition }));
        const downloadCode = String(content.downloadCode ?? '');
        if (!downloadCode) return blocks;
        const [fileName, fallbackType] = mediaDescription(messageType, content);
        const block = await this.downloadMedia(downloadCode, fileName, fallbackType);
        if (block) blocks.push(block);
        else if (blocks.length === 0) {
            blocks.push(TextBlock({ text: `Unable to download DingTalk file: ${fileName}` }));
        }
        return blocks;
    }

    private async parseRichText(content: Record<string, unknown>) {
        const blocks: Array<ReturnType<typeof TextBlock> | DataBlockType> = [];
        const items = Array.isArray(content.richText) ? content.richText : [];
        for (const raw of items) {
            const item = asRecord(raw);
            const text = String(item.text ?? '').trim();
            if (text) blocks.push(TextBlock({ text }));
            const downloadCode = String(item.downloadCode ?? '');
            if (downloadCode) {
                const block = await this.downloadMedia(downloadCode, 'image', 'image/jpeg');
                if (block) blocks.push(block);
            }
        }
        return blocks;
    }

    private async downloadMedia(
        downloadCode: string,
        fileName: string,
        fallbackType: string
    ): Promise<DataBlockType | null> {
        const result = await this.api.downloadMedia(downloadCode, this.config.max_media_bytes);
        if (!result) return null;
        const [data, responseType] = result;
        const mediaType =
            !responseType || responseType === 'application/octet-stream'
                ? fallbackType
                : responseType;
        return DataBlock({
            source: Base64Source({ data: data.toString('base64'), media_type: mediaType }),
            name: fileName,
        });
    }

    private async sendData(chatId: string, block: DataBlockType): Promise<boolean> {
        if (block.source.type !== 'base64') {
            logger.warning('DingTalk cannot send URL data blocks as files');
            return false;
        }
        let data: Buffer;
        try {
            data = Buffer.from(block.source.data, 'base64');
            if (
                data.toString('base64').replace(/=+$/, '') !== block.source.data.replace(/=+$/, '')
            ) {
                throw new Error('invalid base64');
            }
        } catch {
            logger.warning('DingTalk received invalid base64 output');
            return false;
        }
        if (data.byteLength > this.config.max_media_bytes) {
            logger.warning('DingTalk outbound media exceeds the size limit');
            return false;
        }
        const mediaType = block.source.media_type || 'application/octet-stream';
        const fallbackName = mediaType.startsWith('image/')
            ? 'image.png'
            : `file${extensionForMediaType(mediaType)}`;
        return this.api.sendMedia(
            chatId,
            data,
            safeFileName(block.name || fallbackName),
            mediaType
        );
    }
}

function textFromBlocks(blocks: ChannelContentBlock[]): string {
    return blocks
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
}

function mediaDescription(messageType: string, content: Record<string, unknown>): [string, string] {
    if (messageType === 'picture') return ['image', 'image/jpeg'];
    if (messageType === 'video') {
        const suffix = String(content.videoType ?? 'mp4').toLowerCase();
        return [`video.${suffix}`, `video/${suffix}`];
    }
    if (messageType === 'audio') return ['audio', 'audio/mpeg'];
    const fileName = safeFileName(String(content.fileName ?? 'file'));
    return [fileName, String(mimeLookup(fileName) || 'application/octet-stream')];
}

function safeFileName(fileName: string): string {
    return path.posix.basename(fileName.replaceAll('\\', '/')) || 'file';
}

function extensionForMediaType(mediaType: string): string {
    const extension = mimeExtension(mediaType);
    return extension ? `.${extension}` : '';
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>(resolve =>
        signal.addEventListener('abort', () => resolve(), { once: true })
    );
}
