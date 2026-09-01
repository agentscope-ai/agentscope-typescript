/* eslint-disable jsdoc/require-jsdoc */

import type {
    CardActionEvent,
    ChatInfo,
    LarkChannel,
    NormalizedMessage,
    SendInput,
    SendOptions,
} from '@larksuite/channel';

export type FeishuNormalizedMessage = NormalizedMessage;
export type FeishuCardActionEvent = CardActionEvent;

export interface FeishuDriverHandlers {
    onMessage(message: FeishuNormalizedMessage): Promise<void>;
    onCardAction(event: FeishuCardActionEvent): Promise<Record<string, unknown>>;
    onState?(state: 'connecting' | 'connected' | 'retrying', error?: string): void;
}

export interface FeishuPlatformDriver {
    listen(handlers: FeishuDriverHandlers, signal: AbortSignal): Promise<void>;
    close(): Promise<void>;
    send(
        to: string,
        input: SendInput,
        options?: SendOptions
    ): Promise<Record<string, unknown> | null>;
    createCard(card: Record<string, unknown>): Promise<string | null>;
    updateCard(cardId: string, card: Record<string, unknown>, sequence: number): Promise<boolean>;
    addReaction(messageId: string, emojiType: string): Promise<string | null>;
    removeReaction(messageId: string, reactionId: string): Promise<void>;
    downloadResource(
        messageId: string,
        fileKey: string,
        type: 'image' | 'file'
    ): Promise<{ buffer: Buffer; contentType?: string } | null>;
    listChats(): Promise<Array<{ id: string; name: string }>>;
    getChatInfo(chatId: string): Promise<ChatInfo | null>;
    getChatMembers(chatId: string): Promise<Array<{ id: string; name?: string }>>;
}

export interface OfficialFeishuDriverOptions {
    appId: string;
    appSecret: string;
    onlyAtReply: boolean;
}

/** Lazy wrapper around the official Node channel SDK. */
export class OfficialFeishuDriver implements FeishuPlatformDriver {
    private readonly options: OfficialFeishuDriverOptions;
    private channel: LarkChannel | null = null;
    private unsubscribers: Array<() => void> = [];

    constructor(options: OfficialFeishuDriverOptions) {
        this.options = options;
    }

    async listen(handlers: FeishuDriverHandlers, signal: AbortSignal): Promise<void> {
        handlers.onState?.('connecting');
        const channel = await this.ensureChannel();
        this.unsubscribers.push(
            channel.on('message', message => handlers.onMessage(message)),
            channel.on('cardAction', event => handlers.onCardAction(event)),
            channel.on('reconnecting', () => handlers.onState?.('retrying')),
            channel.on('reconnected', () => handlers.onState?.('connected')),
            channel.on('error', error => handlers.onState?.('retrying', error.message))
        );
        await channel.connect();
        handlers.onState?.('connected');
        await waitForAbort(signal);
    }

    async close(): Promise<void> {
        for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
        if (this.channel) await this.channel.disconnect();
        this.channel = null;
    }

    async send(
        to: string,
        input: SendInput,
        options?: SendOptions
    ): Promise<Record<string, unknown> | null> {
        try {
            const result = await (await this.ensureChannel()).send(to, input, options);
            return { code: 0, data: { message_id: result.messageId, chunk_ids: result.chunkIds } };
        } catch (error) {
            return { code: -1, msg: errorMessage(error) };
        }
    }

    async createCard(card: Record<string, unknown>): Promise<string | null> {
        try {
            return (await (await this.ensureChannel()).createCard(card)).cardId;
        } catch {
            return null;
        }
    }

    async updateCard(
        cardId: string,
        card: Record<string, unknown>,
        sequence: number
    ): Promise<boolean> {
        try {
            await (await this.ensureChannel()).updateCardById(cardId, card, sequence);
            return true;
        } catch {
            return false;
        }
    }

    async addReaction(messageId: string, emojiType: string): Promise<string | null> {
        try {
            return await (await this.ensureChannel()).addReaction(messageId, emojiType);
        } catch {
            return null;
        }
    }

    async removeReaction(messageId: string, reactionId: string): Promise<void> {
        try {
            await (await this.ensureChannel()).removeReaction(messageId, reactionId);
        } catch {
            // Python treats reaction removal as best-effort.
        }
    }

    async downloadResource(
        messageId: string,
        fileKey: string,
        type: 'image' | 'file'
    ): Promise<{ buffer: Buffer; contentType?: string } | null> {
        try {
            return await (
                await this.ensureChannel()
            ).downloadResourceWithMeta(messageId, fileKey, type);
        } catch {
            return null;
        }
    }

    async listChats(): Promise<Array<{ id: string; name: string }>> {
        try {
            return await (await this.ensureChannel()).listChats({ pageSize: 50, maxPages: 100 });
        } catch {
            return [];
        }
    }

    async getChatInfo(chatId: string): Promise<ChatInfo | null> {
        try {
            return await (await this.ensureChannel()).getChatInfo(chatId);
        } catch {
            return null;
        }
    }

    async getChatMembers(chatId: string): Promise<Array<{ id: string; name?: string }>> {
        try {
            return await (
                await this.ensureChannel()
            ).getChatMembers(chatId, {
                pageSize: 100,
                maxPages: 100,
                idType: 'open_id',
            });
        } catch {
            return [];
        }
    }

    private async ensureChannel(): Promise<LarkChannel> {
        if (this.channel) return this.channel;
        try {
            const { createLarkChannel } = await import('@larksuite/channel');
            this.channel = createLarkChannel({
                appId: this.options.appId,
                appSecret: this.options.appSecret,
                includeRawEvent: true,
                resolveSenderNames: true,
                resolveChatMode: true,
                policy: {
                    requireMention: this.options.onlyAtReply,
                    dmMode: 'open',
                },
                outbound: { textChunkLimit: 4000 },
                source: 'agentscope-typescript',
            });
            return this.channel;
        } catch (error) {
            throw new Error(
                `Feishu channel requires the optional '@larksuite/channel' package: ${errorMessage(error)}`
            );
        }
    }
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
