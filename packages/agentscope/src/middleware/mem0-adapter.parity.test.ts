/* eslint-disable jsdoc/require-jsdoc */

import {
    AgentScopeEmbedding,
    AgentScopeLLM,
    buildMem0Config,
    convertMessagesToAgentScope,
    parseChatResponse,
    registerAgentScopeMem0Providers,
    type Mem0OssModule,
} from './mem0-adapter';
import type { EmbeddingModelBase } from '../embedding';
import { TextBlock, ThinkingBlock, ToolCallBlock, getTextContent, type Msg } from '../message';
import { ChatResponse } from '../model';
import type { ChatModelBase } from '../model';

describe('AgentScope mem0 adapter Python parity', () => {
    test('converts system, user, and assistant roles and drops unknown roles', () => {
        const messages = convertMessagesToAgentScope([
            { role: 'system', content: 'sys' },
            { role: 'tool', content: 'drop' },
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'answer' },
        ]);

        expect(messages.map(message => message.role)).toEqual(['system', 'user', 'assistant']);
        expect(getTextContent(messages[1])).toBe('hello');
    });

    test('parses text and thinking blocks in Python order', () => {
        const response = new ChatResponse({
            content: [ThinkingBlock({ thinking: 'hmm' }), TextBlock({ text: 'final' })],
            isLast: true,
        });

        expect(parseChatResponse(response, false)).toBe('[Thinking: hmm]\nfinal');
    });

    test('parses JSON tool arguments and preserves malformed input', () => {
        const response = new ChatResponse({
            content: [
                TextBlock({ text: 'calling' }),
                ToolCallBlock({ id: 'one', name: 'lookup', input: '{"q":"alice"}' }),
                ToolCallBlock({ id: 'two', name: 'raw', input: 'not json' }),
            ],
            isLast: true,
        });

        expect(parseChatResponse(response, true)).toEqual({
            content: 'calling',
            tool_calls: [
                { name: 'lookup', arguments: { q: 'alice' } },
                { name: 'raw', arguments: 'not json' },
            ],
        });
        expect(parseChatResponse(new ChatResponse({ content: [], isLast: true }), true)).toEqual({
            content: '',
            tool_calls: [],
        });
    });

    test('LLM adapter validates config and rejects unusable messages', async () => {
        expect(() => new AgentScopeLLM()).toThrow('requires model');
        expect(() => new AgentScopeLLM({ model: {} })).toThrow(TypeError);
        const adapter = new AgentScopeLLM({ model: chatModelReturning('ok') });
        await expect(
            adapter.generateResponse([{ role: 'tool', content: 'ignored' }])
        ).rejects.toThrow('no usable messages');
    });

    test('LLM adapter routes messages and tools through AgentScope', async () => {
        const calls: Array<{ messages: Msg[]; tools?: unknown }> = [];
        const model = {
            call: jest.fn(async (options: { messages: Msg[]; tools?: unknown }) => {
                calls.push(options);
                return new ChatResponse({
                    content: [
                        ToolCallBlock({
                            id: 'call',
                            name: 'search',
                            input: '{"q":"x"}',
                        }),
                    ],
                    isLast: true,
                });
            }),
            generateStructuredOutput: jest.fn(),
        } as unknown as ChatModelBase;
        const adapter = new AgentScopeLLM({ model });

        await expect(
            adapter.generateResponse(
                [
                    { role: 'system', content: 'sys' },
                    { role: 'user', content: 'find x' },
                ],
                undefined,
                [{ name: 'search' }]
            )
        ).resolves.toEqual({
            content: '',
            tool_calls: [{ name: 'search', arguments: { q: 'x' } }],
        });
        expect(calls[0].messages.map(message => message.role)).toEqual(['system', 'user']);
        expect(calls[0].tools).toEqual([{ name: 'search' }]);
    });

    test('LLM adapter drains streams and uses the final chunk', async () => {
        const model = {
            call: jest.fn(async () =>
                (async function* () {
                    yield new ChatResponse({
                        content: [TextBlock({ text: 'part' })],
                        isLast: false,
                    });
                    yield new ChatResponse({
                        content: [TextBlock({ text: 'final' })],
                        isLast: true,
                    });
                })()
            ),
            generateStructuredOutput: jest.fn(),
        } as unknown as ChatModelBase;

        await expect(
            new AgentScopeLLM({ model }).generateResponse([{ role: 'user', content: 'stream' }])
        ).resolves.toBe('final');
    });

    test('LLM generateChat uses mem0 native camel-case tool contract', async () => {
        const model = {
            call: jest.fn(
                async () =>
                    new ChatResponse({
                        content: [ToolCallBlock({ id: 'call', name: 'save', input: '{"x":1}' })],
                        isLast: true,
                    })
            ),
            generateStructuredOutput: jest.fn(),
        } as unknown as ChatModelBase;

        await expect(
            new AgentScopeLLM({ model }).generateChat([{ role: 'user', content: 'save' }])
        ).resolves.toEqual({
            content: '',
            role: 'assistant',
            toolCalls: [{ name: 'save', arguments: '{"x":1}' }],
        });
    });

    test('embedding adapter validates, batches, and returns the first vector', async () => {
        expect(() => new AgentScopeEmbedding()).toThrow('requires model');
        expect(() => new AgentScopeEmbedding({ model: {} })).toThrow(TypeError);
        const calls: string[][] = [];
        const model = {
            dimensions: 3,
            call: jest.fn(async (inputs: string[]) => {
                calls.push(inputs);
                return { embeddings: inputs.map(() => [0.1, 0.2, 0.3]) };
            }),
        } as unknown as EmbeddingModelBase;
        const adapter = new AgentScopeEmbedding({ model });

        await expect(adapter.embed('hello')).resolves.toEqual([0.1, 0.2, 0.3]);
        await expect(adapter.embed(['a', 'b'])).resolves.toEqual([0.1, 0.2, 0.3]);
        await expect(adapter.embedBatch(['c', 'd'])).resolves.toEqual([
            [0.1, 0.2, 0.3],
            [0.1, 0.2, 0.3],
        ]);
        expect(calls).toEqual([['hello'], ['a', 'b'], ['c', 'd']]);
    });

    test('embedding adapter rejects an empty model response', async () => {
        const model = {
            dimensions: 3,
            call: jest.fn(async () => ({ embeddings: [] })),
        } as unknown as EmbeddingModelBase;
        await expect(new AgentScopeEmbedding({ model }).embed('x')).rejects.toThrow(
            'returned no embeddings'
        );
    });

    test('buildMem0Config creates provider config and requires both models', () => {
        const chat = chatModelReturning('ok');
        const embedding = embeddingModelReturning();
        const config = buildMem0Config({ chatModel: chat, embeddingModel: embedding });

        expect(config).toEqual({
            llm: { provider: 'agentscope', config: { model: chat } },
            embedder: {
                provider: 'agentscope',
                config: { model: embedding, embeddingDims: 3 },
            },
        });
        expect(() => buildMem0Config({ chatModel: chat })).toThrow('requires');
        expect(() => buildMem0Config({ embeddingModel: embedding })).toThrow('requires');
        expect(() => buildMem0Config({})).toThrow('requires');
    });

    test('buildMem0Config mutates a base config only for supplied models', () => {
        const originalEmbedder = { provider: 'openai', config: { model: 'embed' } };
        const base = {
            llm: { provider: 'openai', config: { model: 'chat' } },
            embedder: originalEmbedder,
            vectorStore: { provider: 'memory', config: { collectionName: 'custom' } },
            historyDbPath: '/tmp/custom.db',
        };
        const chat = chatModelReturning('ok');
        const config = buildMem0Config({ mem0Config: base, chatModel: chat });

        expect(config).toBe(base);
        expect(config.llm).toEqual({ provider: 'agentscope', config: { model: chat } });
        expect(config.embedder).toBe(originalEmbedder);
        expect(config.vectorStore).toEqual({
            provider: 'memory',
            config: { collectionName: 'custom' },
        });
        expect(buildMem0Config({ mem0Config: base })).toBe(base);
    });

    test('provider registration is idempotent and delegates other providers', () => {
        const originalLlm = { kind: 'original-llm' };
        const originalEmbedding = { kind: 'original-embedding' };
        const module = {
            Memory: class {},
            LLMFactory: {
                create: jest.fn(() => originalLlm),
            },
            EmbedderFactory: {
                create: jest.fn(() => originalEmbedding),
            },
        } as unknown as Mem0OssModule;
        registerAgentScopeMem0Providers(module);
        registerAgentScopeMem0Providers(module);

        const chat = chatModelReturning('ok');
        const embedding = embeddingModelReturning();
        expect(module.LLMFactory.create('agentscope', { model: chat })).toBeInstanceOf(
            AgentScopeLLM
        );
        expect(module.EmbedderFactory.create('agentscope', { model: embedding })).toBeInstanceOf(
            AgentScopeEmbedding
        );
        expect(module.LLMFactory.create('openai', {})).toBe(originalLlm);
        expect(module.EmbedderFactory.create('openai', {})).toBe(originalEmbedding);
    });

    test('official mem0 OSS accepts AgentScope providers for local add and search', async () => {
        const module = await import('mem0ai/oss');
        registerAgentScopeMem0Providers(module as unknown as Mem0OssModule);
        const memory = new module.Memory({
            ...buildMem0Config({
                chatModel: chatModelReturning('{"memory":[]}'),
                embeddingModel: embeddingModelReturning(),
            }),
            vectorStore: {
                provider: 'memory',
                config: {
                    collectionName: 'agentscope_mem0_adapter_test',
                    dimension: 3,
                },
            },
            disableHistory: true,
        } as never);

        const added = await memory.add([{ role: 'user', content: 'Alice likes green tea.' }], {
            filters: { user_id: 'alice' },
            infer: false,
        } as never);
        const searched = await memory.search('tea preference', {
            filters: { user_id: 'alice' },
            topK: 5,
            threshold: 0,
        });

        expect(added.results).toEqual([
            expect.objectContaining({ memory: 'Alice likes green tea.' }),
        ]);
        expect(searched.results.length).toBeGreaterThan(0);
        expect(searched.results).toEqual(
            expect.arrayContaining([expect.objectContaining({ memory: 'Alice likes green tea.' })])
        );
    });
});

function chatModelReturning(text: string): ChatModelBase {
    return {
        call: jest.fn(
            async () =>
                new ChatResponse({
                    content: [TextBlock({ text })],
                    isLast: true,
                })
        ),
        generateStructuredOutput: jest.fn(),
    } as unknown as ChatModelBase;
}

function embeddingModelReturning(): EmbeddingModelBase {
    return {
        dimensions: 3,
        call: jest.fn(async (inputs: string[]) => ({
            embeddings: inputs.map(() => [0.1, 0.2, 0.3]),
        })),
    } as unknown as EmbeddingModelBase;
}
