/* eslint-disable jsdoc/require-jsdoc, @typescript-eslint/no-explicit-any */

import type { Agent } from '../agent';
import { EventType, type AgentEvent } from '../event';
import {
    AssistantMsg,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
    UserMsg,
    type Msg,
} from '../message';
import { PermissionBehavior, createPermissionContext } from '../permission';
import type { ToolBase } from '../tool';
import type { AgentStream } from './base';
import {
    DEFAULT_REME_TOOL_INSTRUCTIONS,
    ReMeHttpApp,
    ReMeMiddleware,
    ReMeParameters,
    buildReMeAppConfig,
    extractReMeMemoryTexts,
    extractReMeQueryText,
    type ReMeApp,
    type ReMeResponse,
} from './reme';

class FakeReMeApp implements ReMeApp {
    readonly calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
    readonly components: Array<{ component: string; name: string; model: unknown }> = [];
    searchReturn: string[] = [];
    searchError: Error | null = null;
    autoMemoryError: Error | null = null;
    searchGate: Promise<void> | null = null;
    startCount = 0;
    closeCount = 0;

    constructor(searchReturn: string[] = []) {
        this.searchReturn = searchReturn;
    }

    async start(): Promise<void> {
        this.startCount += 1;
    }

    async close(): Promise<void> {
        this.closeCount += 1;
    }

    async updateComponent(
        component: string,
        name: string,
        options: { model: unknown }
    ): Promise<void> {
        this.components.push({ component, name, model: options.model });
    }

    async runJob(name: string, parameters: Record<string, unknown>): Promise<ReMeResponse> {
        this.calls.push({ name, parameters });
        if (name === 'search') {
            if (this.searchGate) await this.searchGate;
            if (this.searchError) throw this.searchError;
            return {
                success: true,
                metadata: { results: this.searchReturn.map(text => ({ text })) },
            };
        }
        if (name === 'auto_memory') {
            if (this.autoMemoryError) throw this.autoMemoryError;
            return { success: true, answer: 'recorded', metadata: {} };
        }
        return { success: true, metadata: {} };
    }

    get searchCalls(): Record<string, unknown>[] {
        return this.calls.filter(call => call.name === 'search').map(call => call.parameters);
    }

    get autoMemoryCalls(): Record<string, unknown>[] {
        return this.calls.filter(call => call.name === 'auto_memory').map(call => call.parameters);
    }
}

describe('ReMe helpers and configuration Python parity', () => {
    test('query extraction returns null for none and empty inputs', () => {
        expect(extractReMeQueryText(null)).toBeNull();
        expect(extractReMeQueryText([])).toBeNull();
    });

    test('query extraction reads one user message', () => {
        expect(extractReMeQueryText(UserMsg({ name: 'user', content: 'hello world' }))).toBe(
            'hello world'
        );
    });

    test('query extraction joins user messages and ignores assistant messages', () => {
        expect(
            extractReMeQueryText([
                UserMsg({ name: 'user', content: 'first' }),
                AssistantMsg({ name: 'assistant', content: 'ignored' }),
                UserMsg({ name: 'user', content: 'second' }),
            ])
        ).toBe('first\nsecond');
    });

    test('query extraction ignores HITL resumption events', () => {
        expect(
            extractReMeQueryText({ type: EventType.USER_CONFIRM_RESULT } as AgentEvent)
        ).toBeNull();
        expect(
            extractReMeQueryText({ type: EventType.EXTERNAL_EXECUTION_RESULT } as AgentEvent)
        ).toBeNull();
    });

    test('memory extraction unwraps standard metadata results', () => {
        expect(
            extractReMeMemoryTexts({
                answer: '',
                success: true,
                metadata: {
                    results: [
                        { text: 'a', path: 'daily/1.md', score: 0.9 },
                        { text: 'b', path: 'daily/2.md', score: 0.8 },
                    ],
                },
            })
        ).toEqual(['a', 'b']);
    });

    test('memory extraction accepts unwrapped results', () => {
        expect(extractReMeMemoryTexts({ results: [{ text: 'only' }] })).toEqual(['only']);
    });

    test('memory extraction accepts dicts, fallbacks, and strings', () => {
        expect(extractReMeMemoryTexts([{ memory: 'm' }, { content: 'c' }, 'raw'])).toEqual([
            'm',
            'c',
            'raw',
        ]);
    });

    test('memory extraction normalizes malformed values to empty', () => {
        expect(extractReMeMemoryTexts(null)).toEqual([]);
        expect(extractReMeMemoryTexts({ metadata: { results: 'nope' } })).toEqual([]);
    });

    test('parameters preserve defaults, aliases, and mode validation', () => {
        expect(new ReMeParameters().toJSON()).toEqual({
            chat_model: null,
            embedding_model: null,
            mode: 'both',
            top_k: 5,
        });
        expect(new ReMeParameters({ top_k: 11, mode: 'static_control' }).topK).toBe(11);
        expect(() => new ReMeParameters({ mode: 'garbage' as never })).toThrow('Unknown mode');
    });

    test('session id is read live and never stored as middleware state', () => {
        const middleware = new ReMeMiddleware({ app: new FakeReMeApp() });
        const agent = fakeAgent('sess-xyz');
        expect(ReMeMiddleware.sessionIdOf(agent)).toBe('sess-xyz');
        agent.state.sessionId = 'sess-next';
        expect(ReMeMiddleware.sessionIdOf(agent)).toBe('sess-next');
        expect(middleware).not.toHaveProperty('sessionId');
    });

    test('minimal config owns exactly the Python memory jobs and components', () => {
        const config = buildReMeAppConfig({ workspaceDir: '/real/ws' }) as any;
        expect(config.workspace_dir).toBe('/real/ws');
        expect(config.enable_logo).toBe(false);
        expect(config.log_to_console).toBe(false);
        expect(Object.keys(config.jobs).sort()).toEqual(
            [
                'index_update_loop',
                'search',
                'reindex',
                'auto_memory',
                'dream_cron',
                'auto_dream',
                'node_search',
                'daily_list',
                'frontmatter_update',
                'frontmatter_read',
                'move',
                'read',
                'write',
                'daily_write',
                'edit',
            ].sort()
        );
        expect(config.jobs.dream_cron.steps).toEqual(config.jobs.auto_dream.steps);
        expect(config.jobs.index_update_loop.watch_dirs).toEqual(['daily_dir', 'digest_dir']);
        expect(config.jobs.reindex.watch_dirs).toEqual(['daily_dir', 'digest_dir']);
        expect(Object.keys(config.components.file_catalog)).toEqual(['dream']);
        expect(config.components).not.toHaveProperty('as_embedding');
        expect(config.components.file_store.default.embedding_store).toBe('');
    });

    test('embedding dimensions enable the internal vector store', () => {
        const config = buildReMeAppConfig({
            workspaceDir: '/real/ws',
            embeddingDimensions: 1024,
        }) as any;
        expect(config.components.file_store.default.embedding_store).toBe('default');
        expect(config.components.as_embedding.default.dimensions).toBe(1024);
        expect(config.components.embedding_store.default).toEqual({
            backend: 'local',
            as_embedding: 'default',
            enable_cache: true,
            max_cache_size: 3000,
            max_input_length: 8192,
            max_batch_size: 10,
        });
    });
});

describe('ReMe app lifecycle and HTTP protocol', () => {
    test('app is built lazily, starts once, and closes idempotently', async () => {
        const app = new FakeReMeApp();
        let factoryCalls = 0;
        const middleware = new ReMeMiddleware({
            appFactory: config => {
                factoryCalls += 1;
                expect(config).toEqual(expect.objectContaining({ workspace_dir: '.reme' }));
                return app;
            },
        });

        await middleware.searchMemory('one');
        await middleware.searchMemory('two');
        expect(factoryCalls).toBe(1);
        expect(app.startCount).toBe(1);
        await middleware.close();
        await middleware.close();
        expect(app.closeCount).toBe(1);
    });

    test('configured chat and embedding models inject before start', async () => {
        const app = new FakeReMeApp();
        const chatModel = { modelName: 'chat' } as any;
        const embeddingModel = { dimensions: 1024 } as any;
        const middleware = new ReMeMiddleware({
            app,
            parameters: { chatModel, embeddingModel },
        });

        await middleware.searchMemory('q');
        expect(app.components).toEqual([
            { component: 'as_llm', name: 'default', model: chatModel },
            { component: 'as_embedding', name: 'default', model: embeddingModel },
        ]);
        expect(app.startCount).toBe(1);
    });

    test('omitted models do not inject components', async () => {
        const app = new FakeReMeApp();
        await new ReMeMiddleware({ app }).searchMemory('q');
        expect(app.components).toEqual([]);
    });

    test('failed job response raises the Python-compatible error', async () => {
        const app = new FakeReMeApp();
        app.runJob = async () => ({ success: false, answer: 'down' });
        await expect(new ReMeMiddleware({ app }).searchMemory('q')).rejects.toThrow(
            "ReMe 'search' failed: down"
        );
    });

    test('HTTP app posts to the official job route and normalizes success', async () => {
        const fetchMock = jest.fn(
            async () =>
                new Response(
                    JSON.stringify({ success: true, answer: 'ok', metadata: { results: [] } }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                )
        );
        const app = new ReMeHttpApp({ endpoint: 'http://localhost:2333/', fetch: fetchMock });
        const result = await app.runJob('search', { query: 'alice', limit: 5 });

        expect(fetchMock).toHaveBeenCalledWith(
            'http://localhost:2333/search',
            expect.objectContaining({
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: 'alice', limit: 5 }),
            })
        );
        expect(result).toEqual({
            success: true,
            status: 200,
            answer: 'ok',
            metadata: { results: [] },
        });
    });

    test('HTTP app normalizes HTTP and ReMe failures', async () => {
        const app = new ReMeHttpApp({
            fetch: async () =>
                new Response(JSON.stringify({ success: false, answer: 'bad job' }), {
                    status: 503,
                    headers: { 'Content-Type': 'application/json' },
                }),
        });
        await expect(app.runJob('search', {})).resolves.toEqual({
            success: false,
            status: 503,
            answer: 'bad job',
            metadata: {},
        });
    });

    test('HTTP driver explains why in-process model injection needs a custom app', async () => {
        await expect(
            new ReMeHttpApp().updateComponent('as_llm', 'default', {} as any)
        ).rejects.toThrow('cannot inject in-process');
    });
});

describe('ReMe static control and automatic write-back', () => {
    test('retrieves, injects after user input, and writes the exchange', async () => {
        const app = new FakeReMeApp(['alice loves coffee']);
        const middleware = new ReMeMiddleware({
            app,
            parameters: { mode: 'static_control' },
        });
        const agent = fakeAgent('alice-001');
        const turn = await startTurn(middleware, agent, 'remind me what I like', [
            AssistantMsg({ name: 'agent', content: 'hi alice' }),
        ]);

        await injectReadyRetrieval(middleware, agent);
        await turn.finish();

        expect(app.searchCalls).toEqual([{ query: 'remind me what I like', limit: 5 }]);
        expect(app.autoMemoryCalls).toHaveLength(1);
        expect(app.autoMemoryCalls[0].session_id).toBe('alice-001');
        const written = app.autoMemoryCalls[0].messages as Msg[];
        expect(written.map(messageText)).toEqual(['remind me what I like', 'hi alice']);
        expect(agent.state.context.map(message => message.name)).toEqual([
            'user',
            'memory',
            'agent',
        ]);
        const memory = agent.state.context[1];
        expect(memory.role).toBe('assistant');
        expect(memory.content[0]).toEqual(
            expect.objectContaining({
                type: 'hint',
                hint: expect.stringContaining('alice loves coffee'),
            })
        );
        expect(await middleware.onSystemPrompt(agent, 'base system prompt')).toBe(
            'base system prompt'
        );
        expect(await middleware.listTools()).toEqual([]);
    });

    test('write-back includes the full turn increment and excludes memory hints', async () => {
        const app = new FakeReMeApp(['remembered fact']);
        const middleware = new ReMeMiddleware({
            app,
            parameters: { mode: 'static_control' },
        });
        const agent = fakeAgent('s-multi');
        const toolExchange = AssistantMsg({
            name: 'agent',
            content: [
                ToolCallBlock({ id: 'call-1', name: 'echo', input: '{"text":"ping"}' }),
                ToolResultBlock({
                    id: 'call-1',
                    name: 'echo',
                    output: [TextBlock({ text: 'echo: ping' })],
                    state: 'success',
                }),
                TextBlock({ text: 'final answer' }),
            ],
        });
        const turn = await startTurn(middleware, agent, 'use the echo tool then answer', [
            toolExchange,
        ]);
        await injectReadyRetrieval(middleware, agent);
        await turn.finish();

        const written = app.autoMemoryCalls[0].messages as Msg[];
        expect(written.some(message => message.name === 'memory')).toBe(false);
        expect(written.flatMap(message => message.content.map(block => block.type))).toEqual(
            expect.arrayContaining(['text', 'tool_call', 'tool_result'])
        );
        expect(written.map(messageText)).toContain('use the echo tool then answer');
        expect(written.map(messageText).join('\n')).toContain('final answer');
    });

    test('sequential turns write only each turn increment', async () => {
        const app = new FakeReMeApp();
        const middleware = new ReMeMiddleware({
            app,
            parameters: { mode: 'static_control' },
        });
        const agent = fakeAgent('s-seq');
        await (
            await startTurn(middleware, agent, 'first question', [
                AssistantMsg({ name: 'agent', content: 'first answer' }),
            ])
        ).finish();
        await (
            await startTurn(middleware, agent, 'second question', [
                AssistantMsg({ name: 'agent', content: 'second answer' }),
            ])
        ).finish();

        expect(app.autoMemoryCalls).toHaveLength(2);
        expect((app.autoMemoryCalls[0].messages as Msg[]).map(messageText)).toEqual([
            'first question',
            'first answer',
        ]);
        expect((app.autoMemoryCalls[1].messages as Msg[]).map(messageText)).toEqual([
            'second question',
            'second answer',
        ]);
    });

    test('empty memories do not inject a synthetic message', async () => {
        const app = new FakeReMeApp();
        const middleware = new ReMeMiddleware({
            app,
            parameters: { mode: 'static_control' },
        });
        const agent = fakeAgent();
        const turn = await startTurn(middleware, agent, 'hi', [
            AssistantMsg({ name: 'agent', content: 'ok' }),
        ]);
        await injectReadyRetrieval(middleware, agent);
        await turn.finish();
        expect(agent.state.context.some(message => message.name === 'memory')).toBe(false);
        expect(app.searchCalls).toHaveLength(1);
    });

    test('search failure does not break reply or automatic write-back', async () => {
        const app = new FakeReMeApp();
        app.searchError = new Error('reme down');
        const middleware = new ReMeMiddleware({
            app,
            parameters: { mode: 'static_control' },
        });
        const agent = fakeAgent();
        const turn = await startTurn(middleware, agent, 'ping', [
            AssistantMsg({ name: 'agent', content: 'still works' }),
        ]);
        await injectReadyRetrieval(middleware, agent);
        await expect(turn.finish()).resolves.toBeUndefined();
        expect(app.autoMemoryCalls).toHaveLength(1);
    });

    test('missing session id skips write-back', async () => {
        const app = new FakeReMeApp();
        const middleware = new ReMeMiddleware({ app });
        const agent = fakeAgent(null);
        await (
            await startTurn(middleware, agent, 'hello', [
                AssistantMsg({ name: 'agent', content: 'world' }),
            ])
        ).finish();
        expect(app.autoMemoryCalls).toEqual([]);
    });

    test('shared middleware writes each live agent session independently', async () => {
        const app = new FakeReMeApp();
        const middleware = new ReMeMiddleware({ app });
        await (
            await startTurn(middleware, fakeAgent('sess-a'), 'hi from a', [
                AssistantMsg({ name: 'a', content: 'r1' }),
            ])
        ).finish();
        await (
            await startTurn(middleware, fakeAgent('sess-b'), 'hi from b', [
                AssistantMsg({ name: 'b', content: 'r2' }),
            ])
        ).finish();
        expect(app.autoMemoryCalls.map(call => call.session_id)).toEqual(['sess-a', 'sess-b']);
    });

    test('concurrent sessions keep independent retrieval tasks', async () => {
        const app = new FakeReMeApp(['shared fact']);
        const middleware = new ReMeMiddleware({ app });
        const agentA = fakeAgent('sess-a');
        const agentB = fakeAgent('sess-b');
        const [turnA, turnB] = await Promise.all([
            startTurn(middleware, agentA, 'a asks', [
                AssistantMsg({ name: 'a', content: 'done-a' }),
            ]),
            startTurn(middleware, agentB, 'b asks', [
                AssistantMsg({ name: 'b', content: 'done-b' }),
            ]),
        ]);
        await flushAsync();
        await Promise.all([
            collect(middleware.onReasoning(agentA, {}, emptyStream)),
            collect(middleware.onReasoning(agentB, {}, emptyStream)),
        ]);
        await Promise.all([turnA.finish(), turnB.finish()]);

        expect(agentA.state.context.filter(message => message.name === 'memory')).toHaveLength(1);
        expect(agentB.state.context.filter(message => message.name === 'memory')).toHaveLength(1);
        expect((middleware as any).retrievalTasks.size).toBe(0);
    });

    test('write-back failure is swallowed after a successful reply', async () => {
        const app = new FakeReMeApp();
        app.autoMemoryError = new Error('write down');
        const middleware = new ReMeMiddleware({ app });
        const turn = await startTurn(middleware, fakeAgent('s'), 'hello', [
            AssistantMsg({ name: 'agent', content: 'world' }),
        ]);
        await expect(turn.finish()).resolves.toBeUndefined();
    });
});

describe('ReMe agent control and both mode', () => {
    test('agent control exposes only memory_search and appends the tool prompt', async () => {
        const middleware = new ReMeMiddleware({
            app: new FakeReMeApp(),
            parameters: { mode: 'agent_control' },
        });
        const tools = await middleware.listTools();
        expect(tools.map(tool => tool.name)).toEqual(['memory_search']);
        expect(tools.map(tool => tool.name)).not.toContain('add_memory');
        expect(await middleware.onSystemPrompt(fakeAgent(), 'base')).toBe(
            'base\n\n' + DEFAULT_REME_TOOL_INSTRUCTIONS
        );
    });

    test('middleware never mutates the agent toolkit itself', async () => {
        const middleware = new ReMeMiddleware({
            app: new FakeReMeApp(),
            parameters: { mode: 'agent_control' },
        });
        const agent = fakeAgent();
        (agent as any).toolkit = { tools: [] as ToolBase[] };
        await (
            await startTurn(middleware, agent, 'hello', [
                AssistantMsg({ name: 'agent', content: 'ok' }),
            ])
        ).finish();
        expect((agent as any).toolkit.tools).toEqual([]);
    });

    test('memory_search invokes ReMe with an explicit limit', async () => {
        const app = new FakeReMeApp(['first fact', 'second fact']);
        const middleware = new ReMeMiddleware({
            app,
            parameters: { mode: 'agent_control' },
        });
        const tool = (await middleware.listTools())[0];
        const result = await tool.call({ query: 'what does alice like?', limit: 3 });
        expect(result).not.toHaveProperty('next');
        expect((result as any).content[0].text).toBe('- first fact\n- second fact');
        expect(app.searchCalls).toEqual([{ query: 'what does alice like?', limit: 3 }]);
    });

    test('memory_search schema and omitted limit use topK', async () => {
        const app = new FakeReMeApp(['fact']);
        const middleware = new ReMeMiddleware({
            app,
            parameters: { mode: 'agent_control', topK: 11 },
        });
        const tool = (await middleware.listTools())[0];
        expect((tool.inputSchema as any).properties.limit.default).toBe(11);
        await tool.call({ query: 'q' });
        expect(app.searchCalls).toEqual([{ query: 'q', limit: 11 }]);
    });

    test('memory_search handles empty query and no results', async () => {
        const app = new FakeReMeApp();
        const tool = (
            await new ReMeMiddleware({
                app,
                parameters: { mode: 'agent_control' },
            }).listTools()
        )[0];
        expect(((await tool.call({ query: '' })) as any).content[0].text).toContain('no query');
        expect(((await tool.call({ query: 'anything' })) as any).content[0].text).toContain(
            'no relevant memories'
        );
    });

    test('memory_search failure returns an error ToolChunk', async () => {
        const app = new FakeReMeApp();
        app.searchError = new Error('reme down');
        const tool = (
            await new ReMeMiddleware({
                app,
                parameters: { mode: 'agent_control' },
            }).listTools()
        )[0];
        const result = await tool.call({ query: 'q', limit: 5 });
        expect(result).toEqual(
            expect.objectContaining({
                state: 'error',
                content: [expect.objectContaining({ text: expect.stringContaining('reme down') })],
            })
        );
    });

    test('memory_search auto-allows permission checks', async () => {
        const tool = (
            await new ReMeMiddleware({
                app: new FakeReMeApp(),
                parameters: { mode: 'agent_control' },
            }).listTools()
        )[0];
        const decision = await tool.checkPermissions({}, createPermissionContext());
        expect(decision.behavior).toBe(PermissionBehavior.ALLOW);
    });

    test('agent control skips auto-retrieval but still writes automatically', async () => {
        const app = new FakeReMeApp(['unused']);
        const middleware = new ReMeMiddleware({
            app,
            parameters: { mode: 'agent_control' },
        });
        await (
            await startTurn(middleware, fakeAgent('alice-001'), 'remember I like tea', [
                AssistantMsg({ name: 'agent', content: 'sure thing' }),
            ])
        ).finish();
        expect(app.searchCalls).toEqual([]);
        expect(app.autoMemoryCalls).toHaveLength(1);
        expect((app.autoMemoryCalls[0].messages as Msg[]).map(messageText)).toEqual([
            'remember I like tea',
            'sure thing',
        ]);
    });

    test('both mode injects memory, exposes search, and appends instructions', async () => {
        const app = new FakeReMeApp(['auto-injected']);
        const middleware = new ReMeMiddleware({ app, parameters: { mode: 'both' } });
        const agent = fakeAgent();
        const turn = await startTurn(middleware, agent, 'hi', [
            AssistantMsg({ name: 'agent', content: 'ok' }),
        ]);
        await injectReadyRetrieval(middleware, agent);
        await turn.finish();

        expect(app.searchCalls).toHaveLength(1);
        expect(app.autoMemoryCalls).toHaveLength(1);
        expect(agent.state.context.find(message => message.name === 'memory')?.content[0]).toEqual(
            expect.objectContaining({ hint: expect.stringContaining('auto-injected') })
        );
        expect((await middleware.listTools()).map(tool => tool.name)).toEqual(['memory_search']);
        expect(await middleware.onSystemPrompt(agent, 'base')).toContain('memory_search');
    });
});

function fakeAgent(sessionId: string | null = 'session'): Agent {
    return {
        state: { sessionId, context: [] as Msg[] },
    } as unknown as Agent;
}

async function startTurn(
    middleware: ReMeMiddleware,
    agent: Agent,
    userText: string,
    assistantMessages: Msg[]
): Promise<{ finish: () => Promise<void> }> {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    const input = UserMsg({ name: 'user', content: userText });
    const next = async function* (): AgentStream {
        agent.state.context.push(input);
        yield { type: EventType.REPLY_START } as AgentEvent;
        await gate;
        for (const message of assistantMessages) {
            agent.state.context.push(message);
        }
        if (assistantMessages.length) yield assistantMessages.at(-1)!;
    };
    const stream = middleware.onReply(agent, { inputs: input }, next);
    const first = await stream.next();
    expect(first.done).toBe(false);
    return {
        finish: async () => {
            release();
            while (!(await stream.next()).done) {
                // Drain the reply stream so the middleware finally block runs.
            }
        },
    };
}

async function injectReadyRetrieval(middleware: ReMeMiddleware, agent: Agent): Promise<void> {
    await flushAsync();
    await collect(middleware.onReasoning(agent, {}, emptyStream));
}

async function flushAsync(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
}

async function* emptyStream(): AgentStream {}

async function collect(stream: AgentStream): Promise<Array<AgentEvent | Msg>> {
    const values: Array<AgentEvent | Msg> = [];
    for await (const value of stream) values.push(value);
    return values;
}

function messageText(message: Msg): string {
    return message.content
        .flatMap(block => {
            if (block.type === 'text') return [block.text];
            if (block.type === 'tool_result') {
                if (typeof block.output === 'string') return [block.output];
                return block.output.flatMap(output =>
                    output.type === 'text' ? [output.text] : []
                );
            }
            return [];
        })
        .join('\n');
}
