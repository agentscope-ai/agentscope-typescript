/* eslint-disable @typescript-eslint/no-explicit-any, jsdoc/require-jsdoc */

import type { Agent } from '../agent';
import { EventType } from '../event';
import {
    Base64Source,
    DataBlock,
    TextBlock,
    createMsg,
    type DataBlock as DataBlockValue,
} from '../message';
import { StructuredResponse } from '../model';
import type { PermissionContext } from '../permission';
import type { VectorSearchResult } from '../rag';
import { AgentState, ReplyContext } from '../state';
import {
    DEFAULT_RAG_HINT_TEMPLATE,
    RAG_HINT_SOURCE,
    RAGMiddleware,
    RAGParameters,
    formatRAGResults,
    searchAcross,
    wrapRAGHint,
    type RAGKnowledgeBase,
    type RerankModel,
} from './rag';

class StubKnowledge implements RAGKnowledgeBase {
    readonly searchCalls: Array<Record<string, unknown>> = [];

    constructor(
        readonly name: string,
        readonly description: string,
        readonly results: VectorSearchResult[] = [],
        private readonly error: Error | null = null
    ) {}

    async search(
        queries: Parameters<RAGKnowledgeBase['search']>[0],
        topK = 5,
        scoreThreshold: number | null = null
    ): Promise<VectorSearchResult[]> {
        this.searchCalls.push({ queries, topK, scoreThreshold });
        if (this.error) throw this.error;
        return this.results.slice(0, topK);
    }
}

class StubReranker implements RerankModel {
    readonly modelName = 'reranker';
    readonly calls: Parameters<RerankModel['generateStructuredOutput']>[0][] = [];

    constructor(
        private readonly ids: string[] = [],
        private readonly error: Error | null = null
    ) {}

    async generateStructuredOutput(
        options: Parameters<RerankModel['generateStructuredOutput']>[0]
    ): Promise<StructuredResponse> {
        this.calls.push(options);
        if (this.error) throw this.error;
        return new StructuredResponse({ content: { ids: this.ids } });
    }
}

function result(
    documentId: string,
    score: number,
    content: string | DataBlockValue,
    chunkIndex = 0
): VectorSearchResult {
    return {
        score,
        document_id: documentId,
        chunk: {
            content: typeof content === 'string' ? TextBlock({ text: content }) : content,
            source: `${documentId}.txt`,
            chunk_index: chunkIndex,
            total_chunks: 1,
            metadata: {},
        },
    };
}

function fakeAgent(curIter = 0): Agent {
    return {
        name: 'assistant',
        state: new AgentState({
            replyContext: new ReplyContext({ replyId: 'reply-1', curIter }),
        }),
    } as Agent;
}

async function drain<T>(stream: AsyncGenerator<T, void>): Promise<T[]> {
    const values: T[] = [];
    for await (const value of stream) values.push(value);
    return values;
}

async function runReply(
    middleware: RAGMiddleware,
    agent: Agent,
    inputs: Parameters<RAGMiddleware['onReply']>[1]['inputs'],
    observedContext?: unknown[]
): Promise<unknown[]> {
    async function* reasoningNext(): AsyncGenerator<any, void> {
        if (observedContext) observedContext.push(structuredClone(agent.state.context));
        yield 'reasoning-event';
    }
    async function* replyNext(): AsyncGenerator<any, void> {
        yield* middleware.onReasoning(agent, {}, reasoningNext);
    }
    return drain(middleware.onReply(agent, { inputs }, replyNext));
}

describe('RAGParameters Python parity', () => {
    test('validates ranges, template contracts, and candidate width', () => {
        expect(new RAGParameters().toJSON()).toEqual({
            mode: 'agentic',
            top_k: 5,
            score_threshold: null,
            rerank_candidate_k: null,
            emit_hint_event: true,
            persist_hint: false,
            hint_template: DEFAULT_RAG_HINT_TEMPLATE,
            rerank_prompt: expect.stringContaining('{query}'),
        });
        expect(() => new RAGParameters({ top_k: 0 })).toThrow('between 1 and 50');
        expect(() => new RAGParameters({ topK: 5, rerank_candidate_k: 4 })).toThrow(
            'must be >= top_k'
        );
        expect(() => new RAGParameters({ hint_template: 'missing' })).toThrow("one '{context}'");
        expect(() => new RAGParameters({ hintTemplate: '{context}{context}' })).toThrow(
            "one '{context}'"
        );
        expect(() => new RAGParameters({ rerank_prompt: 'Rank them.' })).toThrow("'{query}'");
        expect(() => new RAGParameters({ rerankPrompt: '{query} {unknown}' })).toThrow(
            'unknown placeholder'
        );
    });

    test('publishes the dock schema without prompt templates', () => {
        const schema = RAGParameters.modelJsonSchema() as any;
        expect(schema.properties.rerank_candidate_k.anyOf[0]).toEqual({
            type: 'integer',
            minimum: 1,
            maximum: 50,
        });
        expect(schema.properties).not.toHaveProperty('hint_template');
        expect(schema.properties).not.toHaveProperty('rerank_prompt');
        expect(RAGMiddleware.Parameters).toBe(RAGParameters);
    });
});

describe('RAGMiddleware static mode Python parity', () => {
    test('injects one-shot text context, emits a hint event, and preserves caller input', async () => {
        const knowledge = new StubKnowledge('paris-kb', 'Paris facts.', [
            result('doc-1', 1, 'Paris is in France.'),
        ]);
        const middleware = new RAGMiddleware({
            knowledge_bases: [knowledge],
            parameters: { mode: 'static', top_k: 1 },
        });
        const agent = fakeAgent();
        const input = createMsg({ name: 'user', role: 'user', content: 'Where is Paris?' });
        const original = structuredClone(input);
        const observed: unknown[] = [];
        const events = await runReply(middleware, agent, input, observed);
        expect(events[0]).toEqual(
            expect.objectContaining({
                type: EventType.HINT_BLOCK,
                reply_id: 'reply-1',
                source: RAG_HINT_SOURCE,
                hint:
                    '<system-reminder>The following content is retrieved from the knowledge ' +
                    'base(s) and may be helpful for the current request:\n<content>[1] ' +
                    '(source: doc-1.txt)\nParis is in France.</content></system-reminder>',
            })
        );
        expect(events[1]).toBe('reasoning-event');
        const carrier = (observed[0] as Array<any>)[0];
        expect(carrier.content[0]).toEqual(
            expect.objectContaining({ type: 'hint', source: RAG_HINT_SOURCE })
        );
        expect(agent.state.context[0].content).toEqual([]);
        expect(input).toEqual(original);
        expect(knowledge.searchCalls[0]).toEqual({
            queries: [expect.objectContaining({ text: 'user: Where is Paris?' })],
            topK: 1,
            scoreThreshold: null,
        });
    });

    test('keeps persistent hints and can suppress the UI event', async () => {
        const middleware = new RAGMiddleware({
            knowledge_bases: [
                new StubKnowledge('kb', 'description', [result('doc', 1, 'content')]),
            ],
            parameters: {
                mode: 'static',
                persist_hint: true,
                emit_hint_event: false,
            },
        });
        const agent = fakeAgent();
        expect(
            await runReply(
                middleware,
                agent,
                createMsg({ name: 'user', role: 'user', content: 'query' })
            )
        ).toEqual(['reasoning-event']);
        expect(agent.state.context[0].content[0].type).toBe('hint');
    });

    test('extracts multimodal blocks, drops blank text, and labels the first real text', async () => {
        const knowledge = new StubKnowledge('kb', 'description');
        const middleware = new RAGMiddleware({
            knowledge_bases: [knowledge],
            parameters: { mode: 'static', emit_hint_event: false },
        });
        const data = DataBlock({
            source: Base64Source({ data: 'aGk=', media_type: 'image/png' }),
        });
        const input = createMsg({
            name: 'alice',
            role: 'user',
            content: [TextBlock({ text: '  ' }), data, TextBlock({ text: 'Why?' })],
        });
        await runReply(middleware, fakeAgent(), input);
        expect(knowledge.searchCalls[0].queries).toEqual([
            data,
            expect.objectContaining({ text: 'alice: Why?' }),
        ]);
    });

    test('skips non-message inputs, later iterations, and all automatic agentic searches', async () => {
        for (const [mode, iteration, inputs] of [
            ['static', 0, null],
            ['static', 1, createMsg({ name: 'user', role: 'user', content: 'query' })],
            ['agentic', 0, createMsg({ name: 'user', role: 'user', content: 'query' })],
        ] as const) {
            const knowledge = new StubKnowledge('kb', 'description');
            const middleware = new RAGMiddleware({
                knowledge_bases: [knowledge],
                parameters: { mode },
            });
            expect(await runReply(middleware, fakeAgent(iteration), inputs)).toEqual([
                'reasoning-event',
            ]);
            expect(knowledge.searchCalls).toEqual([]);
        }
    });

    test('search failure is isolated and downstream still runs', async () => {
        const middleware = new RAGMiddleware({
            knowledge_bases: [new StubKnowledge('kb', 'description', [], new Error('offline'))],
            parameters: { mode: 'static' },
        });
        const agent = fakeAgent();
        expect(
            await runReply(
                middleware,
                agent,
                createMsg({ name: 'user', role: 'user', content: 'query' })
            )
        ).toEqual(['reasoning-event']);
        expect(agent.state.context).toEqual([]);
    });
});

describe('RAGMiddleware agentic mode Python parity', () => {
    test('exposes one scoped, read-only search tool only in agentic mode', async () => {
        const knowledge = new StubKnowledge('paris-kb', 'Paris facts.');
        const middleware = new RAGMiddleware({ knowledge_bases: [knowledge] });
        const tools = await middleware.listTools();
        expect(tools.map(tool => tool.name)).toEqual(['search_knowledge']);
        expect(tools[0].description).toContain('- **paris-kb**: Paris facts.');
        const schema = tools[0].inputSchema as any;
        expect(schema.properties.knowledge_bases.anyOf[0].items.enum).toEqual(['paris-kb']);
        expect(await tools[0].checkPermissions({}, {} as PermissionContext)).toEqual(
            expect.objectContaining({ behavior: 'allow' })
        );
        expect(
            await new RAGMiddleware({
                knowledge_bases: [knowledge],
                parameters: { mode: 'static' },
            }).listTools()
        ).toEqual([]);
    });

    test('returns formatted results and filters target knowledge bases by exact name', async () => {
        const paris = new StubKnowledge('paris', 'Paris.', [result('doc-1', 1, 'France')]);
        const cats = new StubKnowledge('cats', 'Cats.', [result('doc-2', 0.8, 'Mammals')]);
        const tool = (
            await new RAGMiddleware({
                knowledge_bases: [paris, cats],
                parameters: { top_k: 2 },
            }).listTools()
        )[0];
        const response = await tool.call({ query: 'Where?', knowledge_bases: ['paris'] });
        expect(response).toBeInstanceOf(Object);
        expect((response as any).content[0].text).toBe('[1] (source: doc-1.txt)\nFrance');
        expect(paris.searchCalls).toHaveLength(1);
        expect(cats.searchCalls).toHaveLength(0);

        const empty = await tool.call({ query: 'Where?', knowledge_bases: ['unknown'] });
        expect((empty as any).content[0].text).toBe('No relevant content found.');
    });

    test('converts search failures into an error ToolChunk', async () => {
        const tool = (
            await new RAGMiddleware({
                knowledge_bases: [
                    new StubKnowledge('broken', 'Broken.', [], new Error('backend offline')),
                ],
            }).listTools()
        )[0];
        const response = (await tool.call({ query: 'query' })) as any;
        expect(response.state).toBe('error');
        expect(response.content[0].text).toContain('backend offline');
    });
});

describe('RAG shared helpers Python parity', () => {
    test('merges by score and forwards threshold to every knowledge base', async () => {
        const first = new StubKnowledge('one', '', [result('a', 0.7, 'A')]);
        const second = new StubKnowledge('two', '', [result('b', 0.9, 'B')]);
        expect(
            (
                await searchAcross({
                    knowledgeBases: [first, second],
                    queries: ['query'],
                    topK: 1,
                    scoreThreshold: 0.5,
                })
            ).map(value => value.document_id)
        ).toEqual(['b']);
        expect(first.searchCalls[0]).toEqual({
            queries: ['query'],
            topK: 1,
            scoreThreshold: 0.5,
        });
        expect(
            await searchAcross({
                knowledgeBases: [],
                queries: ['query'],
                topK: 1,
                scoreThreshold: null,
            })
        ).toEqual([]);
    });

    test('reranks a wider candidate set and handles invalid or duplicate IDs', async () => {
        const knowledge = new StubKnowledge('kb', '', [
            result('broad', 0.99, 'Broad'),
            result('direct', 0.5, 'Direct'),
            result('extra', 0.1, 'Extra'),
            result('fourth', 0.05, 'Fourth'),
        ]);
        const reranker = new StubReranker(['c3', 'c404', 'c3']);
        const results = await searchAcross({
            knowledgeBases: [knowledge],
            queries: ['Where?'],
            topK: 2,
            scoreThreshold: null,
            rerankModel: reranker,
        });
        expect(knowledge.searchCalls[0].topK).toBe(4);
        expect(results.map(value => value.document_id)).toEqual(['extra', 'broad']);
        expect(reranker.calls[0].messages[0].content[0]).toEqual(
            expect.objectContaining({
                text: expect.stringContaining('<user-query>\nWhere?\n</user-query>'),
            })
        );
    });

    test('rerank includes data candidates and falls back to vector order on failure', async () => {
        const data = DataBlock({
            source: Base64Source({ data: 'aGk=', media_type: 'image/png' }),
        });
        const knowledge = new StubKnowledge('kb', '', [
            result('text', 0.9, 'Text'),
            result('image', 0.8, data),
        ]);
        const reranker = new StubReranker(['c2']);
        expect(
            (
                await searchAcross({
                    knowledgeBases: [knowledge],
                    queries: [data],
                    topK: 1,
                    scoreThreshold: null,
                    rerankModel: reranker,
                    rerankCandidateK: 2,
                })
            )[0].document_id
        ).toBe('image');
        expect(reranker.calls[0].messages[0].content.map(block => block.type)).toEqual([
            'text',
            'data',
            'text',
            'text',
            'data',
            'text',
        ]);

        expect(
            (
                await searchAcross({
                    knowledgeBases: [knowledge],
                    queries: ['query'],
                    topK: 1,
                    scoreThreshold: null,
                    rerankModel: new StubReranker([], new Error('boom')),
                })
            )[0].document_id
        ).toBe('text');
    });

    test('formats text and data without mutating retrieved chunks', () => {
        const data = DataBlock({
            source: Base64Source({ data: 'aGk=', media_type: 'image/png' }),
        });
        const textResult = result('doc-1', 1, 'First');
        const imageResult = result('doc-2', 0.8, data);
        const original = structuredClone([textResult, imageResult]);
        const blocks = formatRAGResults([textResult, imageResult]);
        expect(blocks.map(block => block.type)).toEqual(['text', 'data']);
        expect((blocks[0] as any).text).toBe(
            '[1] (source: doc-1.txt)\nFirst\n\n[2] (source: doc-2.txt)\n'
        );
        expect([textResult, imageResult]).toEqual(original);
        const wrapped = wrapRAGHint('before {context} after', blocks) as any[];
        expect(wrapped[0].text).toBe(
            'before [1] (source: doc-1.txt)\nFirst\n\n[2] (source: doc-2.txt)\n'
        );
        expect(wrapped.at(-1).text).toBe(' after');
        expect(wrapRAGHint('before {context} after', [TextBlock({ text: 'plain' })])).toBe(
            'before plain after'
        );
    });
});
