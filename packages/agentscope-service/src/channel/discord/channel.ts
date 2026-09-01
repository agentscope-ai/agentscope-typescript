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
    OfficialDiscordDriver,
    type DiscordApprovalDecision,
    type DiscordInboundMessage,
    type DiscordPlatformDriver,
} from './driver';

const MAX_LENGTH = 2000;
const MAX_CONNECT_ATTEMPTS = 2;

export const DiscordCredentialsSchema = z.object({
    bot_token: z.string().meta({ title: 'Bot Token', format: 'password' }),
    application_id: z.string().meta({ title: 'Application ID' }),
});

export const DiscordConfigSchema = z.object({
    only_at_reply: z
        .boolean()
        .default(true)
        .describe('In server channels, reply only when the bot is @mentioned')
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

export type DiscordCredentials = z.infer<typeof DiscordCredentialsSchema>;
export type DiscordConfig = z.infer<typeof DiscordConfigSchema>;

export interface DiscordChannelOptions {
    driver?: DiscordPlatformDriver;
    delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/** Discord gateway channel with REST-capable lazy outbound operations. */
export class DiscordChannel extends ChannelBase {
    static readonly channelType = 'discord';
    static readonly displayName = 'Discord';
    static readonly description = 'Bot for Discord servers, channels and DMs.';
    static readonly iconUrl = 'https://www.google.com/s2/favicons?domain=discord.com&sz=128';
    static readonly platformBotIdField = 'application_id';
    static readonly credentialsSchema = DiscordCredentialsSchema;
    static readonly configSchema = DiscordConfigSchema;

    readonly channelId: string;
    readonly status = new ChannelStatus();
    readonly capabilities = new ChannelCapability({
        text: true,
        markdown: true,
        image: true,
        file: true,
        interactive: true,
        maxMessageLength: MAX_LENGTH,
    });
    readonly config: DiscordConfig;
    private readonly driver: DiscordPlatformDriver;
    private readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    private readonly stopController = new AbortController();
    private emit: ChannelEmitter | null = null;

    constructor(
        channelId: string,
        credentials: Record<string, unknown>,
        config: Record<string, unknown>,
        options: DiscordChannelOptions = {}
    ) {
        super();
        const auth = DiscordCredentialsSchema.parse(credentials);
        this.config = DiscordConfigSchema.parse(config);
        this.channelId = channelId;
        this.driver =
            options.driver ?? new OfficialDiscordDriver(auth.bot_token, auth.application_id);
        this.delay = options.delay ?? abortableDelay;
    }

    async startListening(emit: ChannelEmitter, signal?: AbortSignal): Promise<void> {
        this.emit = emit;
        const combined = combineSignals(signal, this.stopController.signal);
        this.status.state = 'connecting';
        this.status.lastError = '';
        let attempts = 0;
        let everConnected = false;
        let backoff = 1_000;
        try {
            while (!combined.aborted) {
                try {
                    await this.driver.listen(
                        {
                            onMessage: message => this.onMessage(message),
                            onApproval: decision => this.onApproval(decision),
                            onReady: () => {
                                everConnected = true;
                                this.status.state = 'connected';
                                this.status.lastError = '';
                            },
                        },
                        combined
                    );
                    if (!combined.aborted) throw new Error('Discord client stopped unexpectedly');
                } catch (error) {
                    if (combined.aborted) break;
                    this.status.state = 'retrying';
                    this.status.lastError = errorMessage(error);
                    logger.error(
                        `Discord '${this.channelId}' client error: ${errorMessage(error)}`
                    );
                }
                if (combined.aborted) break;
                if (!everConnected) {
                    attempts += 1;
                    if (attempts >= MAX_CONNECT_ATTEMPTS) {
                        this.status.state = 'failed';
                        this.status.lastError ||= 'connect failed';
                        await waitForAbort(combined);
                        break;
                    }
                }
                await this.delay(backoff, combined);
                backoff = Math.min(backoff * 2, 30_000);
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
        if (!(await this.driver.resolveChat(event.chatId))) return;
        let reply: Msg | null = null;
        let confirm: RequireUserConfirmEvent | null = null;
        for await (const raw of events) {
            const agentEvent = reply ? this.foldEvent(reply, raw) : parseAgentEvent(raw);
            if (agentEvent.type === EventType.REQUIRE_USER_CONFIRM) {
                confirm = agentEvent;
                break;
            }
            if ('reply_id' in agentEvent && !reply) {
                reply = createMsg({
                    id: agentEvent.reply_id,
                    name: 'assistant',
                    role: 'assistant',
                    content: [],
                });
                this.foldEvent(reply, raw);
            }
            if (agentEvent.type === EventType.REPLY_END) break;
        }
        for (const block of this.render(reply, {
            showThinking: this.config.show_thinking,
            showToolProcess: this.config.show_tool_process,
        })) {
            await this.sendBlock(event.chatId, block);
        }
        if (confirm) await this.presentConfirm(event, confirm);
    }

    async listBotChats(): Promise<Record<string, unknown>[]> {
        return (await this.driver.listTextChannels()).map(chat => ({
            chat_id: chat.id,
            name: chat.name,
        }));
    }

    async chatKind(chatId: string): Promise<ChatKind | null> {
        const chat = await this.driver.resolveChat(chatId);
        return chat ? (chat.kind === 'private' ? ChatKind.PRIVATE : ChatKind.GROUP) : null;
    }

    async chatName(chatId: string): Promise<string> {
        return (await this.driver.resolveChat(chatId))?.name ?? '';
    }

    async onMessage(message: DiscordInboundMessage): Promise<void> {
        if (message.authorId === this.driver.botUserId) return;
        try {
            const isDm = message.guildId === null;
            if (
                !isDm &&
                this.config.only_at_reply &&
                !message.mentionedUserIds.includes(this.driver.botUserId)
            ) {
                return;
            }
            let text = message.content ?? '';
            for (const token of [`<@${this.driver.botUserId}>`, `<@!${this.driver.botUserId}>`]) {
                text = text.split(token).join('');
            }
            text = text.trim();
            const content: ChannelContentBlock[] = [];
            for (const attachment of message.attachments) {
                try {
                    const data = await attachment.read();
                    content.push(
                        DataBlock({
                            source: Base64Source({
                                data: data.toString('base64'),
                                media_type: attachment.contentType ?? 'application/octet-stream',
                            }),
                            name: attachment.filename,
                        })
                    );
                } catch {
                    logger.debug('Discord attachment download failed');
                }
            }
            if (text) content.push(TextBlock({ text }));
            if (!this.emit || content.length === 0) return;
            await this.emit(
                new ChannelEvent({
                    channelId: this.channelId,
                    channelUserId: message.authorId,
                    chatId: message.channelId,
                    channelMessageId: message.id,
                    content,
                    metadata: { chat_type: isDm ? 'dm' : 'guild' },
                })
            );
        } catch (error) {
            logger.error(
                `Discord '${this.channelId}' message handling failed: ${errorMessage(error)}`
            );
        }
    }

    async onApproval(decision: DiscordApprovalDecision): Promise<void> {
        if (!this.emit) return;
        await this.emit(
            new ChannelConfirmationResultEvent({
                channelId: this.channelId,
                chatId: decision.channelId,
                channelUserId: decision.userId,
                agentId: decision.agentId,
                sessionId: decision.sessionId,
                toolCallId: decision.toolCallId,
                approved: decision.approved,
            })
        );
    }

    private async sendBlock(chatId: string, block: ChannelContentBlock): Promise<void> {
        if (block.type === 'text') {
            for (const part of this.splitLongMessage(block.text)) {
                if (part) await this.driver.sendText(chatId, part);
            }
            return;
        }
        if (block.source.type === 'base64') {
            await this.driver.sendFile(
                chatId,
                Buffer.from(block.source.data, 'base64'),
                block.name || 'attachment'
            );
        }
    }

    private async presentConfirm(
        event: ChannelEvent,
        request: RequireUserConfirmEvent
    ): Promise<void> {
        for (const tool of request.tool_calls) {
            await this.driver.sendApproval(
                event.chatId,
                `🛡️ Tool execution needs approval\n**Tool:** \`${tool.name}\`\n` +
                    `**Arguments:** ${String(tool.input).slice(0, 800)}`,
                {
                    toolCallId: tool.id,
                    agentId: String(event.metadata.agent_id ?? ''),
                    sessionId: String(event.metadata.session_id ?? ''),
                }
            );
        }
    }
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
    const controller = new AbortController();
    for (const signal of signals) {
        if (!signal) continue;
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    return controller.signal;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve =>
        signal.addEventListener('abort', () => resolve(), { once: true })
    );
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
        const timer = setTimeout(resolve, milliseconds);
        signal.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true }
        );
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
