/* eslint-disable jsdoc/require-jsdoc, @typescript-eslint/no-explicit-any */

import { EventEmitter } from 'node:events';

import { createEvent, EventType } from '@agentscope-ai/agentscope/event';
import { ToolCallBlock } from '@agentscope-ai/agentscope/message';
import { PermissionBehavior, createPermissionContext } from '@agentscope-ai/agentscope/permission';
import type { BackendBase } from '@agentscope-ai/agentscope/tool';
import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';

import {
    buildDingTalkApprovalCardData,
    ChannelConfirmationResultEvent,
    ChannelEvent,
    DingTalkChannel,
    DingTalkOpenAPI,
    NativeDingTalkStreamTransport,
    dingTalkTrackingId,
    dingTalkToolCallId,
    parseDingTalkCardCallback,
    safeDingTalkDownloadUrl,
    type DingTalkAPI,
    type DingTalkStreamTransport,
} from '../src/channel';
import type { BusPayload } from '../src/message-bus';

class FakeAPI implements DingTalkAPI {
    download: [Buffer, string] | null = [Buffer.from('media'), 'image/png'];
    downloads: Array<[string, number]> = [];
    media: Array<[string, Uint8Array, string, string]> = [];
    texts: Array<[string, string]> = [];
    approvals: Array<[string, string, string, Record<string, string>, string | undefined]> = [];
    updates: Array<[string, Record<string, string>]> = [];
    streamId: string | null = 'stream-1';
    streamUpdates: Array<[string, string, string, { finalize?: boolean; isError?: boolean }]> = [];
    streamSuccess = true;
    users: Record<string, unknown>[] = [];

    async downloadMedia(code: string, max: number) {
        this.downloads.push([code, max]);
        return this.download;
    }
    async sendMedia(chat: string, data: Uint8Array, name: string, type: string) {
        this.media.push([chat, data, name, type]);
        return true;
    }
    async sendText(chat: string, text: string) {
        this.texts.push([chat, text]);
        return true;
    }
    async createApprovalCard(
        chat: string,
        approver: string,
        template: string,
        data: Record<string, string>,
        track?: string
    ) {
        this.approvals.push([chat, approver, template, data, track]);
        return track ?? 'track';
    }
    async createStreamingCard() {
        return this.streamId;
    }
    async streamCard(
        track: string,
        key: string,
        content: string,
        options: { finalize?: boolean; isError?: boolean } = {}
    ) {
        this.streamUpdates.push([track, key, content, options]);
        return this.streamSuccess;
    }
    async updateApprovalCard(track: string, data: Record<string, string>) {
        this.updates.push([track, data]);
        return true;
    }
    async searchUsers(_query: string, limit: number) {
        return this.users.slice(0, limit);
    }
}

class FakeStream implements DingTalkStreamTransport {
    handlers: Parameters<DingTalkStreamTransport['listen']>[0] | null = null;
    started = Promise.resolve();
    closed = false;

    async listen(handlers: Parameters<DingTalkStreamTransport['listen']>[0], signal: AbortSignal) {
        this.handlers = handlers;
        handlers.onState?.('connected');
        await new Promise<void>(resolve =>
            signal.addEventListener('abort', () => resolve(), { once: true })
        );
    }
    async close() {
        this.closed = true;
    }
}

function channel(
    options: { api?: FakeAPI; stream?: FakeStream; config?: Record<string, unknown> } = {}
) {
    return new DingTalkChannel(
        'ding-1',
        { client_id: 'client', client_secret: 'secret' },
        { streaming_card_template_id: '', ...options.config },
        { api: options.api ?? new FakeAPI(), stream: options.stream ?? new FakeStream() }
    );
}

function messageEvent(chatId = 'group:cid'): ChannelEvent {
    return new ChannelEvent({
        channelId: 'ding-1',
        channelUserId: 'u-1',
        chatId,
        metadata: { agent_id: 'agent-1', session_id: 'session-1' },
    });
}

async function* replyEvents(text = 'hello'): AsyncIterable<BusPayload> {
    yield createEvent({
        type: EventType.REPLY_START,
        session_id: 'session-1',
        reply_id: 'reply-1',
        name: 'assistant',
    }) as unknown as BusPayload;
    yield createEvent({
        type: EventType.TEXT_BLOCK_START,
        reply_id: 'reply-1',
        block_id: 'text-1',
    }) as unknown as BusPayload;
    yield createEvent({
        type: EventType.TEXT_BLOCK_DELTA,
        reply_id: 'reply-1',
        block_id: 'text-1',
        delta: text,
    }) as unknown as BusPayload;
    yield createEvent({
        type: EventType.TEXT_BLOCK_END,
        reply_id: 'reply-1',
        block_id: 'text-1',
    }) as unknown as BusPayload;
    yield createEvent({
        type: EventType.REPLY_END,
        session_id: 'session-1',
        reply_id: 'reply-1',
    }) as unknown as BusPayload;
}

async function* confirmEvents(): AsyncIterable<BusPayload> {
    yield createEvent({
        type: EventType.REPLY_START,
        session_id: 'session-1',
        reply_id: 'reply-1',
        name: 'assistant',
    }) as unknown as BusPayload;
    yield createEvent({
        type: EventType.REQUIRE_USER_CONFIRM,
        reply_id: 'reply-1',
        tool_calls: [ToolCallBlock({ id: 'tool-1', name: 'SendMessage', input: '{}' })],
    }) as unknown as BusPayload;
}

describe('DingTalk card parity', () => {
    test('uses a unique fixed-width prefix and recovers the tool call id', () => {
        const first = dingTalkTrackingId('call-1');
        const second = dingTalkTrackingId('call-1');
        expect(first).not.toBe(second);
        expect(dingTalkToolCallId(first)).toBe('call-1');
    });

    test('truncates UTF-8 card values within the platform budget', () => {
        const data = buildDingTalkApprovalCardData(
            ToolCallBlock({ id: 'tool', name: 'Bash', input: '中'.repeat(800) }),
            'Friday'
        );
        expect(Buffer.byteLength(data.input)).toBeLessThanOrEqual(903);
        expect(data.input.endsWith('…')).toBe(true);
        expect(data.status).toBe('pending');
    });

    test.each([
        ['agree', true],
        ['approved', true],
        ['reject', false],
    ])('parses %s callback aliases and space routing', (action, approved) => {
        const decision = parseDingTalkCardCallback({
            outTrackId: dingTalkTrackingId('call-x'),
            userId: 'staff-1',
            spaceType: 'im',
            spaceId: 'cid-group',
            content: JSON.stringify({ cardPrivateData: { params: { id: action } } }),
        });
        expect(decision).toMatchObject({
            toolCallId: 'call-x',
            chatId: 'group:cid-group',
            userId: 'staff-1',
            approved,
        });
    });

    test('rejects malformed or unrelated card callbacks', () => {
        expect(parseDingTalkCardCallback(null)).toBeNull();
        expect(parseDingTalkCardCallback({ content: '{}' })).toBeNull();
    });
});

describe('DingTalk OpenAPI parity', () => {
    test('accepts HTTPS, upgrades DingTalk OSS HTTP, and rejects unsafe URLs', () => {
        expect(safeDingTalkDownloadUrl('https://media.example/file')).toBe(
            'https://media.example/file'
        );
        expect(safeDingTalkDownloadUrl('http://bucket.oss-cn-test.aliyuncs.com/file?sig=x')).toBe(
            'https://bucket.oss-cn-test.aliyuncs.com/file?sig=x'
        );
        expect(safeDingTalkDownloadUrl('http://media.example/file')).toBeNull();
        expect(safeDingTalkDownloadUrl('https://127.0.0.1/file')).toBeNull();
        expect(safeDingTalkDownloadUrl('https://[::1]/file')).toBeNull();
        expect(safeDingTalkDownloadUrl('https://192.0.2.1/file')).toBeNull();
        expect(safeDingTalkDownloadUrl('https://[2001:db8::1]/file')).toBeNull();
        expect(safeDingTalkDownloadUrl('https://8.8.8.8/file')).toBe('https://8.8.8.8/file');
    });

    test('caches access tokens and sends group Markdown using exact wire fields', async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = [];
        const fetcher = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            calls.push({ url, init });
            if (url.endsWith('/oauth2/accessToken')) {
                return Response.json({ accessToken: 'token', expireIn: 7200 });
            }
            return Response.json({ processQueryKey: 'ok' });
        });
        const api = new DingTalkOpenAPI({
            clientId: 'client',
            clientSecret: 'secret',
            fetch: fetcher,
        });

        await expect(api.sendText('group:cid-1', 'hello')).resolves.toBe(true);
        await expect(api.sendText('group:cid-1', 'again')).resolves.toBe(true);

        expect(calls.filter(call => call.url.endsWith('/oauth2/accessToken'))).toHaveLength(1);
        const body = JSON.parse(String(calls[1].init?.body));
        expect(body).toEqual({
            robotCode: 'client',
            msgKey: 'sampleMarkdown',
            msgParam: JSON.stringify({ title: 'AgentScope', text: 'hello' }),
            openConversationId: 'cid-1',
        });
    });

    test('reports DingTalk error bodies and rejects unsupported file types', async () => {
        const fetcher = jest.fn(async (input: string | URL | Request) => {
            if (String(input).endsWith('/oauth2/accessToken')) {
                return Response.json({ accessToken: 'token', expireIn: 7200 });
            }
            return new Response('{"message":"photoURL invalid"}', { status: 400 });
        });
        const api = new DingTalkOpenAPI({
            clientId: 'client',
            clientSecret: 'secret',
            fetch: fetcher,
        });
        await expect(api.sendText('user:u-1', 'hello')).resolves.toBe(false);
        await expect(
            api.sendMedia('user:u-1', Buffer.from('x'), 'note.txt', 'text/plain')
        ).resolves.toBe(false);
    });

    test('enforces declared and streamed download limits', async () => {
        const responses = [
            Response.json({ accessToken: 'token', expireIn: 7200 }),
            Response.json({ downloadUrl: 'https://media.example/file' }),
            new Response('abcdef', {
                headers: { 'content-length': '6', 'content-type': 'text/plain' },
            }),
        ];
        const api = new DingTalkOpenAPI({
            clientId: 'client',
            clientSecret: 'secret',
            fetch: async () => responses.shift()!,
        });
        await expect(api.downloadMedia('code', 5)).resolves.toBeNull();
    });
});

describe('DingTalk channel parity', () => {
    test('normalizes group/private messages, mention gate, names, and routing metadata', async () => {
        const api = new FakeAPI();
        const stream = new FakeStream();
        const adapter = channel({ api, stream });
        const events: ChannelEvent[] = [];
        const controller = new AbortController();
        const listening = adapter.startListening(async event => {
            if (event instanceof ChannelEvent) events.push(event);
        }, controller.signal);
        await Promise.resolve();
        await stream.handlers!.onMessage({
            conversationType: '2',
            conversationId: 'cid',
            conversationTitle: 'Engineering',
            senderStaffId: 'u-1',
            senderNick: 'Alice',
            msgId: 'm-1',
            msgtype: 'text',
            text: { content: ' hello ' },
            isInAtList: true,
        });
        await stream.handlers!.onMessage({
            conversationType: '2',
            conversationId: 'cid',
            senderStaffId: 'u-1',
            msgtype: 'text',
            text: { content: 'ignored' },
            isInAtList: false,
        });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            channelUserId: 'u-1',
            channelUserName: 'Alice',
            chatId: 'group:cid',
            chatName: 'Engineering',
            channelMessageId: 'm-1',
            metadata: { chat_type: 'group', conversation_type: '2' },
        });
        expect(events[0].message).toBe('hello');
        expect(await adapter.chatKind('group:cid')).toBe('group');
        expect(await adapter.chatName('group:cid')).toBe('Engineering');
        controller.abort();
        await listening;
    });

    test('downloads picture/file/audio/rich text and preserves ordering', async () => {
        const api = new FakeAPI();
        const adapter = channel({ api });
        const emitted: ChannelEvent[] = [];
        Object.defineProperty(adapter, 'emit', {
            value: async (event: ChannelEvent) => emitted.push(event),
        });
        await adapter.onCallback({
            conversationType: '2',
            conversationId: 'cid',
            senderStaffId: 'u',
            msgtype: 'richText',
            content: { richText: [{ text: 'before' }, { downloadCode: 'img' }, { text: 'after' }] },
        });
        expect(emitted[0].content.map(block => block.type)).toEqual(['text', 'data', 'text']);
        expect(api.downloads[0][0]).toBe('img');
    });

    test('streams configured replies and falls back to Markdown on card failure', async () => {
        const api = new FakeAPI();
        const adapter = channel({ api, config: { streaming_card_template_id: 'ai.schema' } });
        await adapter.sendResponse(messageEvent(), replyEvents('hello'));
        expect(api.streamUpdates.at(-1)).toMatchObject([
            'stream-1',
            'content',
            'hello',
            { finalize: true },
        ]);
        expect(api.texts).toEqual([]);

        const failed = new FakeAPI();
        failed.streamId = null;
        const fallback = channel({
            api: failed,
            config: { streaming_card_template_id: 'ai.schema' },
        });
        await fallback.sendResponse(messageEvent('user:u'), replyEvents('complete'));
        expect(failed.texts).toEqual([['user:u', 'complete']]);
    });

    test('uploads base64 data and presents approval cards with self-correlating tracks', async () => {
        const api = new FakeAPI();
        const adapter = channel({ api });
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
        await adapter.sendResponse(messageEvent(), imageEvents());
        await adapter.sendResponse(messageEvent(), confirmEvents());
        expect(Buffer.from(api.media[0][1])).toEqual(Buffer.from('png'));
        expect(api.media[0].slice(2)).toEqual(['image.png', 'image/png']);
        expect(dingTalkToolCallId(api.approvals[0][4]!)).toBe('tool-1');
    });

    test('emits authoritative approval decisions and settles cards', async () => {
        const api = new FakeAPI();
        const stream = new FakeStream();
        const adapter = channel({ api, stream });
        const emitted: ChannelConfirmationResultEvent[] = [];
        const controller = new AbortController();
        const listening = adapter.startListening(async event => {
            if (event instanceof ChannelConfirmationResultEvent) emitted.push(event);
        }, controller.signal);
        await Promise.resolve();
        await stream.handlers!.onCardAction({
            outTrackId: 'track',
            userId: 'u-1',
            content: JSON.stringify({
                cardPrivateData: {
                    params: {
                        action: 'deny',
                        toolCallId: 'tool-1',
                        chatId: 'group:cid',
                        agentId: 'agent-1',
                        sessionId: 'session-1',
                    },
                },
            }),
        });
        expect(emitted[0]).toMatchObject({
            toolCallId: 'tool-1',
            chatId: 'group:cid',
            approved: false,
            actor: 'u-1',
        });
        expect(api.updates[0][1].status).toBe('denied');
        controller.abort();
        await listening;
    });

    test('exposes discovery/send tools with Python permission policy', async () => {
        const api = new FakeAPI();
        api.users = [{ user_id: 'u-2', name: 'Bob', title: 'Engineer', department_ids: [1] }];
        const adapter = channel({ api });
        await adapter.onCallback({
            conversationType: '2',
            conversationId: 'cid',
            conversationTitle: 'Finance',
            senderStaffId: 'u',
            msgtype: 'text',
            text: { content: 'x' },
            isInAtList: true,
        });
        const backend = { readFile: async () => Buffer.from('pdf') } as unknown as BackendBase;
        const workspace = { getBackend: () => backend } as unknown as WorkspaceBase;
        const tools = await adapter.listTools(workspace);
        expect(tools.map(tool => tool.name)).toEqual([
            'ListConversations',
            'ListUsers',
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
        expect(
            JSON.parse(
                ((await tools[1].call({ query: 'Bob', limit: 10 })) as any).content[0].text
            )[0]
        ).toMatchObject({ target: 'user:u-2', name: 'Bob' });
    });
});

describe('DingTalk native Stream transport', () => {
    test('retries an initial handshake failure until connected or aborted', async () => {
        class Socket extends EventEmitter {
            send() {}
            close() {
                this.emit('close');
            }
        }
        const socket = new Socket();
        const controller = new AbortController();
        let requests = 0;
        const transport = new NativeDingTalkStreamTransport({
            clientId: 'client',
            clientSecret: 'secret',
            reconnectDelayMs: 0,
            fetch: async () => {
                requests += 1;
                return requests === 1
                    ? new Response('denied', { status: 401 })
                    : Response.json({ endpoint: 'wss://example.test/stream', ticket: 'ticket' });
            },
            createWebSocket: async () => {
                setImmediate(() => {
                    socket.emit('open');
                    controller.abort();
                });
                return socket;
            },
        });
        const states: string[] = [];
        await transport.listen(
            {
                onMessage: async () => {},
                onCardAction: async () => {},
                onState: state => states.push(state),
            },
            controller.signal
        );
        expect({ requests, states }).toEqual({
            requests: 2,
            states: ['connecting', 'connecting', 'connecting', 'connected'],
        });
    });

    test('opens with callback subscriptions, routes payloads, acks, and aborts cleanly', async () => {
        class Socket extends EventEmitter {
            sent: string[] = [];
            send(value: string) {
                this.sent.push(value);
            }
            close() {
                this.emit('close');
            }
            ping() {}
        }
        const socket = new Socket();
        const handshake = jest.fn(async (_input: unknown, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            expect(body.subscriptions).toEqual([
                { type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' },
                { type: 'CALLBACK', topic: '/v1.0/card/instances/callback' },
            ]);
            return Response.json({ endpoint: 'wss://example.test/stream', ticket: 'ticket' });
        });
        const controller = new AbortController();
        const received: Record<string, unknown>[] = [];
        const transport = new NativeDingTalkStreamTransport({
            clientId: 'client',
            clientSecret: 'secret',
            fetch: handshake,
            createWebSocket: async url => {
                expect(url).toBe('wss://example.test/stream?ticket=ticket');
                queueMicrotask(() => socket.emit('open'));
                return socket as any;
            },
        });
        const listening = transport.listen(
            {
                onMessage: async payload => {
                    received.push(payload);
                    controller.abort();
                },
                onCardAction: async () => {},
            },
            controller.signal
        );
        await new Promise<void>(resolve => socket.once('open', resolve));
        socket.emit(
            'message',
            Buffer.from(
                JSON.stringify({
                    type: 'CALLBACK',
                    headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'm' },
                    data: JSON.stringify({ text: { content: 'hello' } }),
                })
            )
        );
        await listening;
        expect(received).toEqual([{ text: { content: 'hello' } }]);
        expect(JSON.parse(socket.sent[0])).toMatchObject({
            code: 200,
            headers: { messageId: 'm' },
        });
    });
});
