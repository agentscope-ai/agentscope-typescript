/* eslint-disable jsdoc/require-jsdoc, @typescript-eslint/no-explicit-any */

import { createEvent, EventType } from '@agentscope-ai/agentscope/event';
import { ToolCallBlock } from '@agentscope-ai/agentscope/message';
import { createPermissionContext, PermissionBehavior } from '@agentscope-ai/agentscope/permission';
import type { BackendBase } from '@agentscope-ai/agentscope/tool';
import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';
import type {
    CardActionEvent,
    ChatInfo,
    NormalizedMessage,
    SendInput,
    SendOptions,
} from '@larksuite/channel';

import {
    buildFeishuActionResponse,
    buildFeishuApprovalCard,
    ChannelConfirmationResultEvent,
    ChannelEvent,
    FeishuChannel,
    parseFeishuAction,
    type FeishuDriverHandlers,
    type FeishuPlatformDriver,
} from '../src/channel';
import type { BusPayload } from '../src/message-bus';

class FakeFeishuDriver implements FeishuPlatformDriver {
    handlers: FeishuDriverHandlers | null = null;
    sends: Array<[string, SendInput, SendOptions | undefined]> = [];
    cards: Record<string, unknown>[] = [];
    updates: Array<[string, Record<string, unknown>, number]> = [];
    downloads = new Map<string, { buffer: Buffer; contentType?: string }>();
    chats = [{ id: 'oc-1', name: 'Product' }];
    info: ChatInfo | null = {
        chatId: 'oc-1',
        name: 'Product',
        chatType: 'group',
    };
    members = [{ id: 'ou-1', name: 'Alice' }];
    reactions: Array<[string, string]> = [];
    removed: Array<[string, string]> = [];
    closed = false;
    failListen = 0;
    updateSuccess = true;

    async listen(handlers: FeishuDriverHandlers, signal: AbortSignal) {
        this.handlers = handlers;
        if (this.failListen > 0) {
            this.failListen -= 1;
            throw new Error('bad credentials');
        }
        handlers.onState?.('connected');
        await new Promise<void>(resolve =>
            signal.addEventListener('abort', () => resolve(), { once: true })
        );
    }
    async close() {
        this.closed = true;
    }
    async send(to: string, input: SendInput, options?: SendOptions) {
        this.sends.push([to, input, options]);
        return { code: 0, data: { message_id: `m-${this.sends.length}` } };
    }
    async createCard(card: Record<string, unknown>): Promise<string | null> {
        this.cards.push(card);
        return 'card-1';
    }
    async updateCard(id: string, card: Record<string, unknown>, sequence: number) {
        this.updates.push([id, card, sequence]);
        return this.updateSuccess;
    }
    async addReaction(messageId: string, emoji: string) {
        this.reactions.push([messageId, emoji]);
        return 'reaction-1';
    }
    async removeReaction(messageId: string, reactionId: string) {
        this.removed.push([messageId, reactionId]);
    }
    async downloadResource(_messageId: string, key: string) {
        return this.downloads.get(key) ?? null;
    }
    async listChats() {
        return this.chats;
    }
    async getChatInfo(_chatId: string) {
        return this.info;
    }
    async getChatMembers(_chatId: string) {
        return this.members;
    }
}

function channel(driver = new FakeFeishuDriver(), options: Record<string, unknown> = {}) {
    return new FeishuChannel('feishu-1', { app_id: 'app', app_secret: 'secret' }, options, {
        driver,
        now: () => 1_000,
        delay: async () => {},
    });
}

function normalized(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
    return {
        messageId: 'm-1',
        chatId: 'oc-1',
        chatType: 'group',
        senderId: 'ou-1',
        senderName: 'Alice',
        content: 'hello',
        rawContentType: 'text',
        resources: [],
        mentions: [],
        mentionAll: false,
        mentionedBot: true,
        createTime: 1,
        raw: { header: { tenant_key: 'tenant' } },
        ...overrides,
    };
}

function event(): ChannelEvent {
    return new ChannelEvent({
        channelId: 'feishu-1',
        channelUserId: 'ou-1',
        chatId: 'oc-1',
        channelMessageId: 'm-1',
        metadata: { agent_id: 'agent-1', session_id: 'session-1' },
    });
}

async function* replyEvents(text = 'hello'): AsyncIterable<BusPayload> {
    yield createEvent({
        type: EventType.REPLY_START,
        session_id: 's',
        reply_id: 'r',
        name: 'a',
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
        delta: text,
    }) as unknown as BusPayload;
    yield createEvent({
        type: EventType.TEXT_BLOCK_END,
        reply_id: 'r',
        block_id: 't',
    }) as unknown as BusPayload;
    yield createEvent({
        type: EventType.REPLY_END,
        session_id: 's',
        reply_id: 'r',
    }) as unknown as BusPayload;
}

async function* confirmEvents(): AsyncIterable<BusPayload> {
    yield createEvent({
        type: EventType.REPLY_START,
        session_id: 's',
        reply_id: 'r',
        name: 'a',
    }) as unknown as BusPayload;
    yield createEvent({
        type: EventType.REQUIRE_USER_CONFIRM,
        reply_id: 'r',
        tool_calls: [ToolCallBlock({ id: 'tool-1', name: 'Bash', input: '{"x":1}' })],
    }) as unknown as BusPayload;
}

describe('Feishu approval card parity', () => {
    test('round-trips routing fields and truncates the displayed summary', () => {
        const card = buildFeishuApprovalCard({
            toolCallId: 'tool-1',
            chatId: 'oc-1',
            toolName: 'Bash',
            summary: 'x'.repeat(900),
            agentId: 'agent-1',
            sessionId: 'session-1',
        });
        const actions = (card.elements as any[])[2].actions as any[];
        expect(String((card.elements as any[])[0].content)).toHaveLength(832);
        expect(parseFeishuAction(actions[0].value)).toEqual({
            toolCallId: 'tool-1',
            chatId: 'oc-1',
            approved: true,
            agentId: 'agent-1',
            sessionId: 'session-1',
        });
        expect(parseFeishuAction(JSON.stringify(actions[1].value))?.approved).toBe(false);
    });

    test('rejects unrelated actions and builds in-place resolved responses', () => {
        expect(parseFeishuAction({ type: 'other' })).toBeNull();
        expect(buildFeishuActionResponse(false)).toMatchObject({
            toast: { type: 'info', content: 'Denied' },
            card: { type: 'raw', data: { header: { template: 'red' } } },
        });
    });
});

describe('Feishu channel parity', () => {
    test('normalizes text with names, chat kind/title, and tenant metadata', async () => {
        const driver = new FakeFeishuDriver();
        const adapter = channel(driver);
        const emitted: ChannelEvent[] = [];
        const controller = new AbortController();
        const listening = adapter.startListening(async value => {
            if (value instanceof ChannelEvent) emitted.push(value);
        }, controller.signal);
        await Promise.resolve();
        await driver.handlers!.onMessage(normalized());
        expect(emitted[0]).toMatchObject({
            channelUserId: 'ou-1',
            channelUserName: 'Alice',
            chatId: 'oc-1',
            chatName: 'Product',
            channelMessageId: 'm-1',
            metadata: { chat_type: 'group', tenant_key: 'tenant' },
        });
        expect(emitted[0].message).toBe('hello');
        expect(await adapter.chatKind('oc-1')).toBe('group');
        expect(await adapter.chatName('oc-1')).toBe('Product');
        controller.abort();
        await listening;
    });

    test('uses raw Feishu text and mirrors Python mention stripping', async () => {
        const driver = new FakeFeishuDriver();
        const adapter = channel(driver);
        const emitted: ChannelEvent[] = [];
        const controller = new AbortController();
        const listening = adapter.startListening(async value => {
            if (value instanceof ChannelEvent) emitted.push(value);
        }, controller.signal);
        await Promise.resolve();
        await driver.handlers!.onMessage(
            normalized({
                content: 'hello @Bob',
                raw: {
                    header: { tenant_key: 'tenant' },
                    event: {
                        message: {
                            content: JSON.stringify({ text: '@_bot hello @_user' }),
                            mentions: [{ key: '@_bot' }, { key: '@_user' }],
                        },
                    },
                },
            })
        );
        expect(emitted.map(value => value.message)).toEqual(['hello']);
        controller.abort();
        await listening;
    });

    test('downloads media with response MIME and preserves rich-post order', async () => {
        const driver = new FakeFeishuDriver();
        driver.downloads.set('img-1', { buffer: Buffer.from('png'), contentType: 'image/png' });
        const adapter = channel(driver);
        const emitted: ChannelEvent[] = [];
        const controller = new AbortController();
        const listening = adapter.startListening(async value => {
            if (value instanceof ChannelEvent) emitted.push(value);
        }, controller.signal);
        await Promise.resolve();
        await driver.handlers!.onMessage(
            normalized({
                content: '',
                rawContentType: 'post',
                raw: {
                    header: { tenant_key: 'tenant' },
                    event: {
                        message: {
                            content: JSON.stringify({
                                title: 'Title',
                                content: [
                                    [
                                        { tag: 'text', text: 'before' },
                                        { tag: 'img', image_key: 'img-1' },
                                        { tag: 'a', text: 'after' },
                                    ],
                                ],
                            }),
                        },
                    },
                },
            })
        );
        expect(emitted[0].content.map(block => block.type)).toEqual(['text', 'data', 'text']);
        expect(emitted[0].message).toBe('Title\nbeforeafter');
        expect(Buffer.from((emitted[0].content[1] as any).source.data, 'base64')).toEqual(
            Buffer.from('png')
        );
        controller.abort();
        await listening;
    });

    test('emits media without SDK placeholder text and replies to unsupported types', async () => {
        const driver = new FakeFeishuDriver();
        driver.downloads.set('file-1', { buffer: Buffer.from('file') });
        const adapter = channel(driver);
        const emitted: ChannelEvent[] = [];
        const controller = new AbortController();
        const listening = adapter.startListening(async value => {
            if (value instanceof ChannelEvent) emitted.push(value);
        }, controller.signal);
        await Promise.resolve();
        await driver.handlers!.onMessage(
            normalized({
                content: '<file key="file-1"/>',
                rawContentType: 'file',
                resources: [{ type: 'file', fileKey: 'file-1', fileName: 'note.txt' }],
            })
        );
        await driver.handlers!.onMessage(
            normalized({ content: '[unsupported message]', rawContentType: 'location' })
        );
        expect(emitted.map(value => value.content.map(block => block.type))).toEqual([['data']]);
        expect(driver.sends).toEqual([
            ['oc-1', { text: 'Unsupported message type: location.' }, { replyTo: 'm-1' }],
        ]);
        controller.abort();
        await listening;
    });

    test('creates, updates, and finalizes a streaming CardKit card', async () => {
        const driver = new FakeFeishuDriver();
        const adapter = channel(driver);
        await adapter.sendResponse(event(), replyEvents('hello'));
        expect(driver.cards[0]).toMatchObject({ schema: '2.0', config: { streaming_mode: true } });
        expect(driver.sends[0]).toMatchObject(['oc-1', { cardId: 'card-1' }, { replyTo: 'm-1' }]);
        expect(driver.updates.at(-1)).toEqual([
            'card-1',
            {
                schema: '2.0',
                config: { streaming_mode: false },
                body: {
                    elements: [{ tag: 'markdown', element_id: 'md', content: 'hello' }],
                },
            },
            2,
        ]);
        expect(driver.updates.map(update => update[2])).toEqual([1, 2]);
    });

    test('falls back to chunked text if CardKit creation fails', async () => {
        const driver = new FakeFeishuDriver();
        driver.createCard = async () => null;
        const adapter = channel(driver);
        await adapter.sendResponse(event(), replyEvents('hello'));
        expect(driver.sends).toEqual([['oc-1', { text: 'hello' }, { replyTo: 'm-1' }]]);
    });

    test('does not duplicate text when an opened CardKit update is rejected', async () => {
        const driver = new FakeFeishuDriver();
        driver.updateSuccess = false;
        const adapter = channel(driver);
        await adapter.sendResponse(event(), replyEvents('hello'));
        expect(driver.sends).toEqual([['oc-1', { cardId: 'card-1' }, { replyTo: 'm-1' }]]);
        expect(driver.updates).toHaveLength(2);
    });

    test('uploads reply data blocks and sends one approval card per tool', async () => {
        const driver = new FakeFeishuDriver();
        const adapter = channel(driver);
        async function* imageEvents(): AsyncIterable<BusPayload> {
            yield createEvent({
                type: EventType.REPLY_START,
                session_id: 's',
                reply_id: 'r',
                name: 'a',
            }) as unknown as BusPayload;
            yield createEvent({
                type: EventType.DATA_BLOCK_START,
                reply_id: 'r',
                block_id: 'd',
                media_type: 'image/png',
            }) as unknown as BusPayload;
            yield createEvent({
                type: EventType.DATA_BLOCK_DELTA,
                reply_id: 'r',
                block_id: 'd',
                data: Buffer.from('png').toString('base64'),
                media_type: 'image/png',
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
        await adapter.sendResponse(event(), imageEvents());
        await adapter.sendResponse(event(), confirmEvents());
        expect(driver.sends.some(([, input]) => 'image' in input)).toBe(true);
        const cardSend = driver.sends.find(([, input]) => 'card' in input)!;
        const values = ((cardSend[1] as any).card.elements[2].actions as any[]).map(a => a.value);
        expect(values[0]).toMatchObject({
            tool_call_id: 'tool-1',
            chat_id: 'oc-1',
            agent_id: 'agent-1',
            session_id: 'session-1',
        });
    });

    test('card clicks emit a resume event and return a toast plus settled card', async () => {
        const driver = new FakeFeishuDriver();
        const adapter = channel(driver);
        const emitted: ChannelConfirmationResultEvent[] = [];
        const controller = new AbortController();
        const listening = adapter.startListening(async value => {
            if (value instanceof ChannelConfirmationResultEvent) emitted.push(value);
        }, controller.signal);
        await Promise.resolve();
        const response = await driver.handlers!.onCardAction({
            messageId: 'm',
            chatId: 'oc-1',
            operator: { openId: 'ou-1' },
            action: {
                tag: 'button',
                value: {
                    type: 'tool_guard_approval',
                    action: 'approve',
                    tool_call_id: 'tool-1',
                    chat_id: 'oc-1',
                    agent_id: 'agent-1',
                    session_id: 'session-1',
                },
            },
        } as CardActionEvent);
        expect(emitted[0]).toMatchObject({
            channelUserId: 'ou-1',
            toolCallId: 'tool-1',
            approved: true,
            agentId: 'agent-1',
            sessionId: 'session-1',
        });
        expect(response).toMatchObject({ toast: { content: 'Allowed' }, card: { type: 'raw' } });
        controller.abort();
        await listening;
    });

    test('supports reactions, chat/member discovery, target sends, and tool permissions', async () => {
        const driver = new FakeFeishuDriver();
        const adapter = channel(driver);
        await expect(adapter.sendReaction(event(), 'OnIt')).resolves.toBe('reaction-1');
        await adapter.removeReaction(event(), 'reaction-1');
        expect(driver.removed).toEqual([['m-1', 'reaction-1']]);
        expect(await adapter.listBotChats()).toEqual([
            { chat_id: 'oc-1', name: 'Product', chat_type: 'group' },
        ]);
        expect(await adapter.listChatMembers('oc-1')).toEqual([{ open_id: 'ou-1', name: 'Alice' }]);

        const backend = { readFile: async () => Buffer.from('file') } as unknown as BackendBase;
        const tools = await adapter.listTools({
            getBackend: () => backend,
        } as unknown as WorkspaceBase);
        expect(tools.map(tool => tool.name)).toEqual([
            'ListChats',
            'ListChatMembers',
            'SendMessage',
            'SendFile',
            'SendImage',
        ]);
        expect((await tools[0].checkPermissions({}, createPermissionContext())).behavior).toBe(
            PermissionBehavior.ALLOW
        );
        expect((await tools[2].checkPermissions({}, createPermissionContext())).behavior).toBe(
            PermissionBehavior.ASK
        );
        const result = await tools[0].call({ query: 'prod' });
        expect(JSON.parse((result as any).content[0].text)).toEqual([
            { receive_id: 'oc-1', receive_id_type: 'chat_id', name: 'Product' },
        ]);
    });

    test('parks as failed after two initial connection failures and closes cleanly', async () => {
        const driver = new FakeFeishuDriver();
        driver.failListen = 2;
        const adapter = channel(driver);
        const controller = new AbortController();
        const listening = adapter.startListening(async () => {}, controller.signal);
        for (let index = 0; index < 20 && adapter.status.state !== 'failed'; index += 1) {
            await Promise.resolve();
        }
        expect(adapter.status).toMatchObject({ state: 'failed', lastError: 'bad credentials' });
        controller.abort();
        await listening;
        expect(driver.closed).toBe(true);
        expect(adapter.status.state).toBe('stopped');
    });
});
