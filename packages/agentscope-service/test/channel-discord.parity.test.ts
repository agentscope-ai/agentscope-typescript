/* eslint-disable jsdoc/require-jsdoc */

import { createEvent, EventType } from '@agentscope-ai/agentscope/event';
import { ToolCallBlock } from '@agentscope-ai/agentscope/message';

import {
    ChannelConfirmationResultEvent,
    ChannelEvent,
    ChatKind,
    DiscordChannel,
    DiscordConfigSchema,
    DiscordCredentialsSchema,
    type DiscordApprovalDecision,
    type DiscordChatInfo,
    type DiscordDriverHandlers,
    type DiscordPlatformDriver,
} from '../src/channel';
import type { BusPayload } from '../src/message-bus';

class FakeDiscordDriver implements DiscordPlatformDriver {
    readonly botUserId = 'bot-1';
    handlers: DiscordDriverHandlers | null = null;
    texts: Array<[string, string]> = [];
    files: Array<[string, Buffer, string]> = [];
    approvals: Array<
        [string, string, Omit<DiscordApprovalDecision, 'channelId' | 'userId' | 'approved'>]
    > = [];
    chats = [
        { id: '10', name: 'Guild#general' },
        { id: '11', name: 'Guild#support' },
    ];
    resolved = new Map<string, DiscordChatInfo>([
        ['10', { id: '10', name: 'general', kind: 'group' }],
        ['20', { id: '20', name: '', kind: 'private' }],
    ]);
    failListen = 0;
    ready = true;
    closed = false;

    async listen(handlers: DiscordDriverHandlers, signal: AbortSignal): Promise<void> {
        this.handlers = handlers;
        if (this.failListen > 0) {
            this.failListen -= 1;
            throw new Error('invalid token');
        }
        if (this.ready) handlers.onReady();
        await new Promise<void>(resolve => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
        });
    }

    async close(): Promise<void> {
        this.closed = true;
    }

    async sendText(channelId: string, text: string): Promise<boolean> {
        this.texts.push([channelId, text]);
        return this.resolved.has(channelId);
    }

    async sendFile(channelId: string, data: Uint8Array, fileName: string): Promise<boolean> {
        this.files.push([channelId, Buffer.from(data), fileName]);
        return this.resolved.has(channelId);
    }

    async sendApproval(
        channelId: string,
        content: string,
        decision: Omit<DiscordApprovalDecision, 'channelId' | 'userId' | 'approved'>
    ): Promise<boolean> {
        this.approvals.push([channelId, content, decision]);
        return this.resolved.has(channelId);
    }

    async resolveChat(channelId: string): Promise<DiscordChatInfo | null> {
        return this.resolved.get(channelId) ?? null;
    }

    async listTextChannels(): Promise<Array<{ id: string; name: string }>> {
        return this.chats;
    }
}

function channel(
    driver = new FakeDiscordDriver(),
    config: Record<string, unknown> = {}
): DiscordChannel {
    return new DiscordChannel(
        'discord-1',
        { bot_token: 'token', application_id: 'bot-1' },
        config,
        { driver, delay: async () => {} }
    );
}

function inbound(overrides: Record<string, unknown> = {}) {
    return {
        id: 'm-1',
        channelId: '10',
        authorId: 'user-1',
        content: '<@bot-1> hello',
        guildId: 'guild-1',
        mentionedUserIds: ['bot-1'],
        attachments: [],
        ...overrides,
    };
}

function targetEvent(): ChannelEvent {
    return new ChannelEvent({
        channelId: 'discord-1',
        channelUserId: 'user-1',
        chatId: '10',
        channelMessageId: 'm-1',
        metadata: { agent_id: 'agent-1', session_id: 'session-1' },
    });
}

async function* richReply(): AsyncIterable<BusPayload> {
    yield createEvent({
        type: EventType.REPLY_START,
        session_id: 's',
        reply_id: 'r',
        name: 'assistant',
    }) as unknown as BusPayload;
    yield createEvent({
        type: EventType.TEXT_BLOCK_START,
        reply_id: 'r',
        block_id: 't',
    }) as unknown as BusPayload;
    yield createEvent({
        type: EventType.TEXT_BLOCK_DELTA,
        reply_id: 'r',
        block_id: 't',
        delta: 'x'.repeat(2001),
    }) as unknown as BusPayload;
    yield createEvent({
        type: EventType.TEXT_BLOCK_END,
        reply_id: 'r',
        block_id: 't',
    }) as unknown as BusPayload;
    yield createEvent({
        type: EventType.DATA_BLOCK_START,
        reply_id: 'r',
        block_id: 'd',
        media_type: 'application/pdf',
    }) as unknown as BusPayload;
    yield createEvent({
        type: EventType.DATA_BLOCK_DELTA,
        reply_id: 'r',
        block_id: 'd',
        data: Buffer.from('pdf').toString('base64'),
        media_type: 'application/pdf',
    }) as unknown as BusPayload;
    yield createEvent({
        type: EventType.DATA_BLOCK_END,
        reply_id: 'r',
        block_id: 'd',
    }) as unknown as BusPayload;
    yield createEvent({
        type: EventType.REPLY_END,
        session_id: 's',
        reply_id: 'r',
    }) as unknown as BusPayload;
}

async function* confirmReply(): AsyncIterable<BusPayload> {
    yield createEvent({
        type: EventType.REQUIRE_USER_CONFIRM,
        reply_id: 'r',
        tool_calls: [
            ToolCallBlock({ id: 'tool-1', name: 'Bash', input: 'x'.repeat(900) }),
            ToolCallBlock({ id: 'tool-2', name: 'Read', input: '{}' }),
        ],
    }) as unknown as BusPayload;
}

describe('Discord schemas and metadata parity', () => {
    test('matches Python defaults and declared capabilities', () => {
        expect(
            DiscordCredentialsSchema.parse({
                bot_token: 'token',
                application_id: 'app',
            })
        ).toEqual({ bot_token: 'token', application_id: 'app' });
        expect(DiscordConfigSchema.parse({})).toEqual({
            only_at_reply: true,
            show_tool_process: false,
            show_thinking: false,
        });
        const adapter = channel();
        expect({
            type: DiscordChannel.channelType,
            display: DiscordChannel.displayName,
            botField: DiscordChannel.platformBotIdField,
            capabilities: adapter.capabilities.toJSON(),
        }).toEqual({
            type: 'discord',
            display: 'Discord',
            botField: 'application_id',
            capabilities: {
                text: true,
                markdown: true,
                image: true,
                file: true,
                interactive: true,
                streaming: false,
                max_message_length: 2000,
            },
        });
    });
});

describe('Discord channel parity', () => {
    test('normalizes mentioned guild text and removes both mention forms', async () => {
        const driver = new FakeDiscordDriver();
        const adapter = channel(driver);
        const emitted: ChannelEvent[] = [];
        const controller = new AbortController();
        const listening = adapter.startListening(async value => {
            if (value instanceof ChannelEvent) emitted.push(value);
        }, controller.signal);
        await Promise.resolve();
        await driver.handlers!.onMessage(inbound({ content: '<@bot-1> hi <@!bot-1>' }));
        expect(
            emitted.map(value => ({
                ...value.toJSON(),
                content: value.content.map(block =>
                    block.type === 'text'
                        ? { type: block.type, text: block.text }
                        : { type: block.type, source: block.source, name: block.name }
                ),
            }))
        ).toEqual([
            {
                channel_id: 'discord-1',
                channel_user_id: 'user-1',
                channel_user_name: '',
                chat_id: '10',
                chat_name: '',
                channel_message_id: 'm-1',
                content: [{ type: 'text', text: 'hi' }],
                metadata: { chat_type: 'guild' },
                received_at: emitted[0].receivedAt,
            },
        ]);
        controller.abort();
        await listening;
    });

    test('ignores own and unmentioned guild messages but accepts unmentioned DMs', async () => {
        const driver = new FakeDiscordDriver();
        const adapter = channel(driver);
        const emitted: ChannelEvent[] = [];
        const controller = new AbortController();
        const listening = adapter.startListening(async value => {
            if (value instanceof ChannelEvent) emitted.push(value);
        }, controller.signal);
        await Promise.resolve();
        await driver.handlers!.onMessage(inbound({ authorId: 'bot-1' }));
        await driver.handlers!.onMessage(inbound({ mentionedUserIds: [], content: 'server' }));
        await driver.handlers!.onMessage(
            inbound({ channelId: '20', guildId: null, mentionedUserIds: [], content: 'dm' })
        );
        expect(
            emitted.map(value => ({ message: value.message, metadata: value.metadata }))
        ).toEqual([{ message: 'dm', metadata: { chat_type: 'dm' } }]);
        controller.abort();
        await listening;
    });

    test('downloads attachments before text and skips failed downloads', async () => {
        const driver = new FakeDiscordDriver();
        const adapter = channel(driver);
        const emitted: ChannelEvent[] = [];
        const controller = new AbortController();
        const listening = adapter.startListening(async value => {
            if (value instanceof ChannelEvent) emitted.push(value);
        }, controller.signal);
        await Promise.resolve();
        await driver.handlers!.onMessage(
            inbound({
                content: '<@bot-1> caption',
                attachments: [
                    {
                        filename: 'image.png',
                        contentType: 'image/png',
                        read: async () => Buffer.from('png'),
                    },
                    {
                        filename: 'bad.bin',
                        read: async () => {
                            throw new Error('download failed');
                        },
                    },
                ],
            })
        );
        expect(
            emitted[0].content.map(block =>
                block.type === 'text'
                    ? { type: block.type, text: block.text }
                    : { type: block.type, source: block.source, name: block.name }
            )
        ).toEqual([
            {
                type: 'data',
                source: {
                    type: 'base64',
                    data: Buffer.from('png').toString('base64'),
                    media_type: 'image/png',
                },
                name: 'image.png',
            },
            { type: 'text', text: 'caption' },
        ]);
        controller.abort();
        await listening;
    });

    test('splits text at 2000 and sends base64 blocks as named files', async () => {
        const driver = new FakeDiscordDriver();
        const adapter = channel(driver);
        await adapter.sendResponse(targetEvent(), richReply());
        expect(driver.texts.map(([chatId, text]) => [chatId, text.length])).toEqual([
            ['10', 2000],
            ['10', 1],
        ]);
        expect(driver.files).toEqual([['10', Buffer.from('pdf'), 'attachment']]);
    });

    test('returns before consuming events when the target channel cannot be resolved', async () => {
        const driver = new FakeDiscordDriver();
        const adapter = channel(driver);
        let consumed = false;
        async function* events(): AsyncIterable<BusPayload> {
            consumed = true;
            yield* richReply();
        }
        await adapter.sendResponse(
            new ChannelEvent({
                channelId: 'discord-1',
                channelUserId: 'user-1',
                chatId: 'missing',
            }),
            events()
        );
        expect({ consumed, texts: driver.texts, files: driver.files }).toEqual({
            consumed: false,
            texts: [],
            files: [],
        });
    });

    test('sends one approval per tool with pinned routing and truncated arguments', async () => {
        const driver = new FakeDiscordDriver();
        const adapter = channel(driver);
        await adapter.sendResponse(targetEvent(), confirmReply());
        expect(
            driver.approvals.map(([chatId, content, decision]) => ({
                chatId,
                contentLength: content.length,
                endsWith: content.endsWith('x'.repeat(800)),
                decision,
            }))
        ).toEqual([
            {
                chatId: '10',
                contentLength: 866,
                endsWith: true,
                decision: {
                    toolCallId: 'tool-1',
                    agentId: 'agent-1',
                    sessionId: 'session-1',
                },
            },
            {
                chatId: '10',
                contentLength: 68,
                endsWith: false,
                decision: {
                    toolCallId: 'tool-2',
                    agentId: 'agent-1',
                    sessionId: 'session-1',
                },
            },
        ]);
    });

    test('emits approval decisions with exact resume routing', async () => {
        const driver = new FakeDiscordDriver();
        const adapter = channel(driver);
        const emitted: ChannelConfirmationResultEvent[] = [];
        const controller = new AbortController();
        const listening = adapter.startListening(async value => {
            if (value instanceof ChannelConfirmationResultEvent) emitted.push(value);
        }, controller.signal);
        await Promise.resolve();
        await driver.handlers!.onApproval({
            channelId: '10',
            userId: 'user-1',
            toolCallId: 'tool-1',
            approved: false,
            agentId: 'agent-1',
            sessionId: 'session-1',
        });
        expect(emitted.map(value => value.toJSON())).toEqual([
            {
                channel_id: 'discord-1',
                chat_id: '10',
                channel_user_id: 'user-1',
                agent_id: 'agent-1',
                session_id: 'session-1',
                tool_call_id: 'tool-1',
                approved: false,
                actor: '',
            },
        ]);
        controller.abort();
        await listening;
    });

    test('discovers text chats and resolves names and kinds through REST semantics', async () => {
        const adapter = channel();
        expect(await adapter.listBotChats()).toEqual([
            { chat_id: '10', name: 'Guild#general' },
            { chat_id: '11', name: 'Guild#support' },
        ]);
        expect(await adapter.chatKind('10')).toBe(ChatKind.GROUP);
        expect(await adapter.chatKind('20')).toBe(ChatKind.PRIVATE);
        expect(await adapter.chatKind('bad')).toBeNull();
        expect(await adapter.chatName('10')).toBe('general');
        expect(await adapter.chatName('20')).toBe('');
    });

    test('parks failed after two initial failures and closes on abort', async () => {
        const driver = new FakeDiscordDriver();
        driver.failListen = 2;
        const adapter = channel(driver);
        const controller = new AbortController();
        const listening = adapter.startListening(async () => {}, controller.signal);
        for (let index = 0; index < 20 && adapter.status.state !== 'failed'; index += 1) {
            await Promise.resolve();
        }
        expect(adapter.status).toMatchObject({ state: 'failed', lastError: 'invalid token' });
        controller.abort();
        await listening;
        expect(driver.closed).toBe(true);
        expect(adapter.status.state).toBe('stopped');
    });
});
