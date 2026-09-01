/* eslint-disable jsdoc/require-jsdoc */

import {
    DEFAULT_MEM0_TOOL_INSTRUCTIONS,
    Mem0Middleware,
    extractMem0MemoryTexts,
    extractMem0QueryText,
    mem0ExtractedAnything,
    type Mem0AddOptions,
    type Mem0AsyncClient,
    type Mem0Message,
    type Mem0SearchOptions,
} from './mem0';
import type { Agent } from '../agent';
import { EventType, type AgentEvent } from '../event';
import { AssistantMsg, UserMsg, type Msg } from '../message';
import { PermissionBehavior, createPermissionContext } from '../permission';
import { ToolChunk } from '../tool';

describe('Mem0Middleware Python parity', () => {
    test('query extraction accepts user messages and ignores empty/resumption inputs', () => {
        expect(extractMem0QueryText(null)).toBeNull();
        expect(extractMem0QueryText([])).toBeNull();
        expect(extractMem0QueryText(UserMsg({ name: 'user', content: 'hello' }))).toBe('hello');
        expect(
            extractMem0QueryText([
                UserMsg({ name: 'user', content: 'first' }),
                UserMsg({ name: 'user', content: 'second' }),
                AssistantMsg({ name: 'assistant', content: 'ignored' }),
            ])
        ).toBe('first\nsecond');
        expect(
            extractMem0QueryText({ type: EventType.USER_CONFIRM_RESULT } as AgentEvent)
        ).toBeNull();
        expect(
            extractMem0QueryText({
                type: EventType.EXTERNAL_EXECUTION_RESULT,
            } as AgentEvent)
        ).toBeNull();
    });

    test('memory response helpers tolerate OSS, Platform, and malformed shapes', () => {
        expect(
            extractMem0MemoryTexts({
                results: [{ memory: 'a' }, { text: 'b' }, 'c'],
            })
        ).toEqual(['a', 'b', 'c']);
        expect(extractMem0MemoryTexts([{ memory: 'platform' }])).toEqual(['platform']);
        expect(extractMem0MemoryTexts(null)).toEqual([]);
        expect(extractMem0MemoryTexts({ results: 'bad' })).toEqual([]);
        expect(mem0ExtractedAnything({ results: [{}] })).toBe(true);
        expect(mem0ExtractedAnything([{ id: 'platform' }])).toBe(true);
        expect(mem0ExtractedAnything({ results: [] })).toBe(false);
    });

    test('constructor validates user, mode, and backend construction paths', () => {
        expect(() => new Mem0Middleware({ userId: '', client: new FakeClient() })).toThrow(
            'non-empty'
        );
        expect(
            () =>
                new Mem0Middleware({
                    userId: 'alice',
                    client: new FakeClient(),
                    mode: 'bad' as never,
                })
        ).toThrow('Unknown mode');
        expect(() => new Mem0Middleware({ userId: 'alice' })).toThrow('client');
        expect(
            () =>
                new Mem0Middleware({
                    userId: 'alice',
                    chatModel: {} as never,
                })
        ).toThrow('passed together');
    });

    test('constructor rejects synchronous clients and accepts wrapped async functions', () => {
        const sync = {
            search: () => ({ results: [] }),
            add: () => ({ results: [] }),
        };
        expect(() => new Mem0Middleware({ userId: 'alice', client: sync as never })).toThrow(
            'async mem0 client'
        );

        const asyncSearch = async (): Promise<unknown> => ({ results: [] });
        const asyncAdd = async (): Promise<unknown> => ({ results: [] });
        const wrappedSearch = (() => asyncSearch()) as typeof asyncSearch & {
            __wrapped__?: unknown;
        };
        const wrappedAdd = (() => asyncAdd()) as typeof asyncAdd & {
            __wrapped__?: unknown;
        };
        wrappedSearch.__wrapped__ = asyncSearch;
        wrappedAdd.__wrapped__ = asyncAdd;
        expect(
            () =>
                new Mem0Middleware({
                    userId: 'alice',
                    client: {
                        search: wrappedSearch,
                        add: wrappedAdd,
                    } as never,
                })
        ).not.toThrow();
    });

    test('static control searches, injects after reply start, and writes exchange', async () => {
        const client = new FakeClient({
            results: [{ memory: 'alice loves coffee' }],
        });
        const middleware = new Mem0Middleware({
            client,
            userId: 'alice',
            agentId: 'agent',
            mode: 'static_control',
        });
        const { agent, context } = fakeAgent();
        const yielded = await collect(
            middleware.onReply(
                agent,
                { inputs: UserMsg({ name: 'user', content: 'what do I like?' }) },
                () => replyDownstream('hi alice')
            )
        );

        expect(client.searchCalls).toEqual([
            {
                query: 'what do I like?',
                options: {
                    filters: { user_id: 'alice', agent_id: 'agent' },
                    topK: 5,
                },
            },
        ]);
        expect(client.addCalls).toEqual([
            {
                messages: [
                    { role: 'user', content: 'what do I like?' },
                    { role: 'assistant', content: 'hi alice' },
                ],
                options: { userId: 'alice', agentId: 'agent' },
            },
        ]);
        expect(yielded[0]).toEqual(expect.objectContaining({ type: EventType.REPLY_START }));
        expect(context).toHaveLength(1);
        expect(context[0].name).toBe('memory');
        expect(context[0].role).toBe('assistant');
        expect(context[0].content).toEqual([
            expect.objectContaining({
                type: 'hint',
                hint: expect.stringContaining('alice loves coffee'),
            }),
        ]);
        expect(await middleware.onSystemPrompt(agent, 'base')).toBe('base');
        expect(await middleware.listTools()).toEqual([]);
    });

    test('empty or failed search does not inject but still writes', async () => {
        const empty = new FakeClient({ results: [] });
        const middleware = new Mem0Middleware({
            client: empty,
            userId: 'alice',
            mode: 'static_control',
        });
        const first = fakeAgent();
        await collect(
            middleware.onReply(
                first.agent,
                { inputs: UserMsg({ name: 'user', content: 'hi' }) },
                () => replyDownstream('ok')
            )
        );
        expect(first.context).toEqual([]);
        expect(empty.addCalls).toHaveLength(1);

        const failing = new FakeClient();
        failing.searchError = new Error('mem0 down');
        const second = fakeAgent();
        await collect(
            new Mem0Middleware({
                client: failing,
                userId: 'alice',
                mode: 'static_control',
            }).onReply(second.agent, { inputs: UserMsg({ name: 'user', content: 'hi' }) }, () =>
                replyDownstream('still works')
            )
        );
        expect(second.context).toEqual([]);
        expect(failing.addCalls).toHaveLength(1);
    });

    test('search scope, threshold, and per-call topK match Python semantics', async () => {
        const client = new FakeClient();
        const middleware = new Mem0Middleware({
            client,
            userId: 'alice',
            agentId: 'agent',
            scopeSearchByAgent: false,
            topK: 9,
            threshold: 0.75,
        });

        await middleware.searchMemory('query', {
            userId: 'alice',
            agentId: middleware.searchAgentId,
            topK: 3,
        });

        expect(client.searchCalls[0]).toEqual({
            query: 'query',
            options: {
                filters: { user_id: 'alice' },
                topK: 3,
                threshold: 0.75,
            },
        });
        expect(middleware.topK).toBe(9);
    });

    test('agent control only exposes tools and appends prompt instructions', async () => {
        const client = new FakeClient({ results: [{ memory: 'unused' }] });
        const middleware = new Mem0Middleware({
            client,
            userId: 'alice',
            mode: 'agent_control',
        });
        const { agent, context } = fakeAgent();
        await collect(
            middleware.onReply(agent, { inputs: UserMsg({ name: 'user', content: 'hello' }) }, () =>
                replyDownstream('ok')
            )
        );

        expect(client.searchCalls).toEqual([]);
        expect(client.addCalls).toEqual([]);
        expect(context).toEqual([]);
        expect(await middleware.onSystemPrompt(agent, 'base')).toBe(
            'base\n\n' + DEFAULT_MEM0_TOOL_INSTRUCTIONS
        );
        expect((await middleware.listTools()).map(tool => tool.name)).toEqual([
            'search_memory',
            'add_memory',
        ]);
    });

    test('search tool runs keywords concurrently, deduplicates, and honors limit', async () => {
        const client = new FakeClient({
            results: [{ memory: 'shared' }, { memory: 'unique' }],
        });
        const middleware = new Mem0Middleware({
            client,
            userId: 'alice',
            agentId: 'agent',
            mode: 'agent_control',
        });
        const search = (await middleware.listTools())[0];
        const result = (await search.call({
            keywords: ['one', 'two'],
            limit: 3,
        })) as ToolChunk;
        const output = textOf(result);

        expect(output).toBe('- shared\n- unique');
        expect(client.searchCalls).toEqual([
            {
                query: 'one',
                options: {
                    filters: { user_id: 'alice', agent_id: 'agent' },
                    topK: 3,
                },
            },
            {
                query: 'two',
                options: {
                    filters: { user_id: 'alice', agent_id: 'agent' },
                    topK: 3,
                },
            },
        ]);
        await expect(search.checkPermissions({}, createPermissionContext())).resolves.toEqual(
            expect.objectContaining({ behavior: PermissionBehavior.ALLOW })
        );
    });

    test('search tool handles empty queries, no matches, and failures', async () => {
        const client = new FakeClient({ results: [] });
        const middleware = new Mem0Middleware({
            client,
            userId: 'alice',
            mode: 'agent_control',
        });
        const search = (await middleware.listTools())[0];
        expect(textOf((await search.call({ keywords: [] })) as ToolChunk)).toContain('no keywords');
        expect(textOf((await search.call({ keywords: ['q'] })) as ToolChunk)).toContain(
            'no relevant'
        );
        client.searchError = new Error('mem0 down');
        const failure = (await search.call({ keywords: ['q'] })) as ToolChunk;
        expect(failure.state).toBe('error');
        expect(textOf(failure)).toContain('mem0 down');
    });

    test('add tool uses two-tier fallback and never persists thinking', async () => {
        const client = new FakeClient();
        client.addReturns = [{ results: [] }, { results: [{ id: 'm1', memory: 'saved' }] }];
        const middleware = new Mem0Middleware({
            client,
            userId: 'alice',
            mode: 'agent_control',
        });
        const add = (await middleware.listTools())[1];
        const result = (await add.call({
            thinking: 'private rationale',
            content: ['likes coffee'],
        })) as ToolChunk;

        expect(textOf(result)).toContain('Successfully recorded');
        expect(textOf(result)).toContain('private rationale');
        expect(client.addCalls).toEqual([
            {
                messages: [{ role: 'user', content: 'likes coffee', name: 'user' }],
                options: { userId: 'alice' },
            },
            {
                messages: [{ role: 'user', content: 'likes coffee', name: 'user' }],
                options: { userId: 'alice', infer: false },
            },
        ]);
        expect(JSON.stringify(client.addCalls)).not.toContain('private rationale');
    });

    test('add tool returns error chunks for empty content and backend failure', async () => {
        const client = new FakeClient();
        const middleware = new Mem0Middleware({
            client,
            userId: 'alice',
            mode: 'agent_control',
        });
        const add = (await middleware.listTools())[1];
        const empty = (await add.call({ thinking: '', content: [] })) as ToolChunk;
        expect(empty.state).toBe('error');
        expect(textOf(empty)).toContain('nothing to record');

        client.addError = new Error('write down');
        const failure = (await add.call({
            thinking: '',
            content: ['fact'],
        })) as ToolChunk;
        expect(failure.state).toBe('error');
        expect(textOf(failure)).toContain('write down');
    });

    test('both mode combines automatic hooks and tools', async () => {
        const client = new FakeClient({
            results: [{ memory: 'auto-injected' }],
        });
        const middleware = new Mem0Middleware({
            client,
            userId: 'alice',
            mode: 'both',
        });
        const { agent, context } = fakeAgent();
        await collect(
            middleware.onReply(agent, { inputs: UserMsg({ name: 'user', content: 'hi' }) }, () =>
                replyDownstream('ok')
            )
        );

        expect(client.searchCalls).toHaveLength(1);
        expect(client.addCalls).toHaveLength(1);
        expect(context[0].content[0]).toEqual(
            expect.objectContaining({
                type: 'hint',
                hint: expect.stringContaining('auto-injected'),
            })
        );
        expect((await middleware.listTools()).map(tool => tool.name)).toEqual([
            'search_memory',
            'add_memory',
        ]);
        expect(await middleware.onSystemPrompt(agent, 'base')).toContain('search_memory');
    });
});

class FakeClient implements Mem0AsyncClient {
    readonly searchCalls: Array<{ query: string; options: Mem0SearchOptions }> = [];
    readonly addCalls: Array<{ messages: Mem0Message[]; options: Mem0AddOptions }> = [];
    searchReturn: unknown;
    addReturns: unknown[] = [{ results: [] }];
    searchError: Error | null = null;
    addError: Error | null = null;

    constructor(searchReturn: unknown = { results: [] }) {
        this.searchReturn = searchReturn;
    }

    async search(query: string, options: Mem0SearchOptions): Promise<unknown> {
        if (this.searchError) throw this.searchError;
        this.searchCalls.push({ query, options });
        return this.searchReturn;
    }

    async add(messages: Mem0Message[], options: Mem0AddOptions): Promise<unknown> {
        if (this.addError) throw this.addError;
        this.addCalls.push({ messages, options });
        return this.addReturns.shift() ?? { results: [] };
    }
}

function fakeAgent(): { agent: Agent; context: Msg[] } {
    const context: Msg[] = [];
    return {
        context,
        agent: {
            name: 'agent',
            state: { context },
        } as unknown as Agent,
    };
}

async function* replyDownstream(text: string): AsyncGenerator<AgentEvent | Msg, void> {
    yield {
        type: EventType.REPLY_START,
        id: 'event',
        created_at: '2026-09-01T00:00:00.000Z',
        session_id: 'session',
        reply_id: 'reply',
        name: 'agent',
        role: 'assistant',
    };
    yield AssistantMsg({ name: 'agent', content: text });
}

async function collect(stream: AsyncIterable<AgentEvent | Msg>): Promise<Array<AgentEvent | Msg>> {
    const result: Array<AgentEvent | Msg> = [];
    for await (const item of stream) result.push(item);
    return result;
}

function textOf(chunk: ToolChunk): string {
    const block = chunk.content[0];
    return block?.type === 'text' ? block.text : '';
}
