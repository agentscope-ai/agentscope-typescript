/* eslint-disable jsdoc/require-jsdoc */

import { GeminiCredential } from '../credential';
import { createMsg } from '../message';
import { ToolChoice } from '../tool/types';
import type { ToolSchema } from '../type';
import {
    flattenJSONSchema,
    GeminiChatModel,
    GeminiClient,
    GeminiRequest,
    sanitizeSchemaForGemini,
} from './gemini-model';
import { ChatResponse } from './response';

const messages = [createMsg({ name: 'user', role: 'user', content: 'Hello' })];
const tools: ToolSchema[] = [
    {
        type: 'function',
        function: {
            name: 'get_weather',
            description: 'Get the weather',
            parameters: {
                $schema: 'https://json-schema.org/draft/2020-12/schema',
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_time',
            description: 'Get the time',
            parameters: { type: 'object', properties: {} },
        },
    },
];

describe('GeminiChatModel', () => {
    test('parses text, thinking, tools and Python-compatible usage', async () => {
        const { model } = createModel({
            response_id: 'response-1',
            candidates: [
                {
                    content: {
                        parts: [
                            { text: 'Reason', thought: true },
                            { text: 'Answer' },
                            {
                                thought_signature: new Uint8Array([1, 2, 3]),
                                function_call: {
                                    name: 'get_weather',
                                    args: { city: 'Tokyo' },
                                },
                            },
                        ],
                    },
                },
            ],
            usage_metadata: {
                prompt_token_count: 500,
                candidates_token_count: 120,
                tool_use_prompt_token_count: 300,
                thoughts_token_count: 10,
                total_token_count: 930,
                cached_content_token_count: 50,
            },
        });

        const response = (await model.call({ messages })) as ChatResponse;
        expect(response).toMatchObject({
            id: 'response-1',
            isLast: true,
            content: [
                { type: 'thinking', thinking: 'Reason' },
                { type: 'text', text: 'Answer' },
                {
                    type: 'tool_call',
                    id: 'AQID',
                    name: 'get_weather',
                    input: '{"city":"Tokyo"}',
                },
            ],
            usage: { inputTokens: 800, outputTokens: 130, cacheInputTokens: 50 },
        });
    });

    test('falls back to total minus all input tokens for usage', async () => {
        const { model } = createModel({
            candidates: [{ content: { parts: [{ text: 'Answer' }] } }],
            usage_metadata: {
                prompt_token_count: 500,
                tool_use_prompt_token_count: 300,
                thoughts_token_count: 10,
                total_token_count: 810,
            },
        });

        const response = (await model.call({ messages })) as ChatResponse;
        expect(response.usage).toMatchObject({ inputTokens: 800, outputTokens: 10 });
    });

    test('builds parameter, tool-choice and filtered tool configuration', async () => {
        const { model, requests } = createModel(
            { candidates: [] },
            {
                maxTokens: 2048,
                temperature: 0.3,
                topP: 0.8,
                thinkingEnable: true,
                thinkingBudget: 0,
            }
        );
        await model.call({
            messages,
            tools,
            toolChoice: new ToolChoice({ mode: 'required', tools: ['get_weather'] }),
        });

        expect(requests[0]).toEqual({
            model: 'gemini-test',
            contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
            config: {
                temperature: 0.3,
                max_output_tokens: 2048,
                top_p: 0.8,
                thinking_config: { include_thoughts: true, thinking_budget: 1024 },
                tools: [
                    {
                        function_declarations: [
                            {
                                name: 'get_weather',
                                description: 'Get the weather',
                                parameters: {
                                    type: 'object',
                                    properties: { city: { type: 'string' } },
                                    required: ['city'],
                                },
                            },
                        ],
                    },
                ],
                tool_config: { function_calling_config: { mode: 'ANY' } },
            },
        });
    });

    test('supports forced tool names without filtering schemas', async () => {
        const { model, requests } = createModel({ candidates: [] });
        await model.call({
            messages,
            tools,
            toolChoice: new ToolChoice({ mode: 'get_weather' }),
        });

        expect(requests[0].config.tool_config).toEqual({
            function_calling_config: {
                mode: 'ANY',
                allowed_function_names: ['get_weather'],
            },
        });
        const configured = requests[0].config.tools as Array<Record<string, unknown>>;
        expect(configured[0].function_declarations).toHaveLength(2);
    });

    test('accumulates streamed thinking, text, tool calls and usage', async () => {
        const chunks = asyncValues([
            {
                response_id: 'stream-1',
                candidates: [{ content: { parts: [{ text: 'Think', thought: true }] } }],
            },
            { candidates: [{ content: { parts: [{ text: 'Answer' }] } }] },
            {
                candidates: [
                    {
                        content: {
                            parts: [
                                {
                                    function_call: {
                                        id: 'call-1',
                                        name: 'search',
                                        args: { q: 'agent' },
                                    },
                                },
                            ],
                        },
                    },
                ],
                usage_metadata: {
                    prompt_token_count: 4,
                    candidates_token_count: 3,
                    total_token_count: 7,
                },
            },
        ]);
        const { model } = createModel(chunks, {}, true);
        const stream = (await model.call({ messages })) as AsyncGenerator<
            ChatResponse,
            ChatResponse
        >;
        const yielded: ChatResponse[] = [];
        let complete: ChatResponse | undefined;
        while (true) {
            const item = await stream.next();
            if (item.done) {
                complete = item.value;
                break;
            }
            yielded.push(item.value);
        }

        expect(yielded).toHaveLength(3);
        expect(complete).toMatchObject({
            id: 'stream-1',
            isLast: true,
            content: [
                { type: 'thinking', thinking: 'Think' },
                { type: 'text', text: 'Answer' },
                { type: 'tool_call', id: 'call-1', name: 'search', input: '{"q":"agent"}' },
            ],
            usage: { inputTokens: 4, outputTokens: 3 },
        });
    });
});

describe('Gemini schema conversion', () => {
    test('recursively removes unsupported keys and converts const and null', () => {
        expect(
            sanitizeSchemaForGemini({
                $schema: 'draft',
                type: 'object',
                additionalProperties: false,
                properties: {
                    topic: { type: 'string', const: 'general' },
                    name: {
                        description: 'Optional name',
                        anyOf: [{ type: 'string' }, { type: 'null', description: 'None' }],
                    },
                    nothing: { type: 'null' },
                },
            })
        ).toEqual({
            type: 'object',
            properties: {
                topic: { type: 'string', enum: ['general'] },
                name: { type: 'string', description: 'Optional name' },
                nothing: { type: 'object' },
            },
        });
    });

    test('converts nullable type arrays and rejects ambiguous conjunctions', () => {
        expect(
            sanitizeSchemaForGemini({
                type: ['string', 'integer', 'null'],
                description: 'Identifier',
            })
        ).toEqual({
            anyOf: [{ type: 'string' }, { type: 'integer' }],
            description: 'Identifier',
        });
        expect(() =>
            sanitizeSchemaForGemini({
                type: ['string', 'integer', 'null'],
                anyOf: [{ enum: ['auto'] }, { type: 'null' }],
            })
        ).toThrow('multi-type nullable type array and anyOf');
    });

    test('flattens modern, legacy and circular local references', () => {
        expect(
            flattenJSONSchema({
                $defs: {
                    Node: {
                        type: 'object',
                        properties: { child: { $ref: '#/$defs/Node' } },
                    },
                },
                properties: { root: { $ref: '#/$defs/Node', title: 'Root' } },
            })
        ).toEqual({
            properties: {
                root: {
                    type: 'object',
                    properties: {
                        child: { type: 'object', description: '(circular: Node)' },
                    },
                    title: 'Root',
                },
            },
        });
        expect(
            flattenJSONSchema({
                definitions: { Address: { type: 'string' } },
                properties: { address: { $ref: '#/definitions/Address' } },
            })
        ).toEqual({ properties: { address: { type: 'string' } } });
    });

    test('returns the original schema when it has no definition table', () => {
        const schema = { type: 'object', properties: { value: { type: 'integer' } } };
        expect(flattenJSONSchema(schema)).toBe(schema);
        expect(flattenJSONSchema({ $defs: {}, type: 'object' })).toEqual({ type: 'object' });
    });
});

function createModel(
    response: unknown,
    parameters: ConstructorParameters<typeof GeminiChatModel>[0]['parameters'] = {},
    stream = false
): { model: GeminiChatModel; requests: GeminiRequest[] } {
    const requests: GeminiRequest[] = [];
    const client: GeminiClient = {
        generateContent: async request => {
            requests.push(structuredClone(request));
            return response;
        },
    };
    return {
        model: new GeminiChatModel({
            credential: new GeminiCredential({ apiKey: 'key' }),
            model: 'gemini-test',
            parameters,
            stream,
            client,
        }),
        requests,
    };
}

function asyncValues(values: unknown[]): AsyncIterable<Record<string, unknown>> {
    return {
        async *[Symbol.asyncIterator]() {
            for (const value of values) yield value as Record<string, unknown>;
        },
    };
}
