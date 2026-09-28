import { z } from 'zod';

import { GeminiChatModel } from './gemini-model';
import { ChatResponse } from './response';
import { Agent } from '../agent/agent';
import { GeminiChatFormatter } from '../formatter/gemini-chat-formatter';
import { createMsg, parseMsg, TextBlock, ToolResultBlock } from '../message';
import { Toolkit } from '../tool';
import { createToolResponse } from '../tool/response';
import { ToolSchema } from '../type';

const tool: ToolSchema = {
    type: 'function',
    function: {
        name: 'weather',
        description: 'Look up weather',
        parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
            additionalProperties: false,
        },
    },
};
const messages = [
    createMsg({ name: 'user', role: 'user', content: [TextBlock({ text: '天气?' })] }),
];
const originalFetch = global.fetch;
const fetchMock = jest.fn();

/**
 * Read all deltas and the generator's final accumulated response.
 * @param generator
 * @returns The formatted or accumulated result.
 */
async function collect(generator: AsyncGenerator<ChatResponse, ChatResponse>) {
    const deltas: ChatResponse[] = [];
    while (true) {
        const next = await generator.next();
        if (next.done) return { deltas, final: next.value };
        deltas.push(next.value);
    }
}

/**
 * Create a byte-fragmented SSE response, including CRLF and an unterminated final frame.
 * @param chunks
 * @returns The formatted or accumulated result.
 */
function streamResponse(chunks: unknown[]) {
    const bytes = new TextEncoder().encode(
        chunks
            .map((c, i) => `data: ${JSON.stringify(c)}${i === chunks.length - 1 ? '' : '\r\n\r\n'}`)
            .join('')
    );
    return new Response(
        new ReadableStream({
            start(controller) {
                for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
                controller.close();
            },
        })
    );
}

/**
 * Native response fixture.
 * @param parts
 * @param extra
 * @returns The formatted or accumulated result.
 */
function response(parts: unknown[], extra: Record<string, unknown> = {}) {
    return { candidates: [{ content: { role: 'model', parts } }], ...extra };
}

describe('GeminiChatModel', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        global.fetch = fetchMock;
    });
    afterAll(() => {
        global.fetch = originalFetch;
    });

    test('uses native endpoint, headers, system instruction, generation config and tool schemas', async () => {
        fetchMock.mockResolvedValue(Response.json(response([{ text: 'OK' }])));
        const model = new GeminiChatModel({
            apiKey: 'test-key',
            modelName: 'models/gemini-3.8-flash',
            stream: false,
            baseURL: 'https://gemini.example/v1beta/',
            presetGenParams: { temperature: 0.5, maxOutputTokens: 100 },
            presetHeaders: { 'X-Client': 'test' },
        });
        const result = (await model.call({
            messages: [
                createMsg({
                    name: 'system',
                    role: 'system',
                    content: [TextBlock({ text: 'Be concise' })],
                }),
                ...messages,
            ],
            tools: [tool],
            toolChoice: 'weather',
            generationConfig: { temperature: 0.2 },
        })) as ChatResponse;
        expect(result.content).toEqual([expect.objectContaining({ type: 'text', text: 'OK' })]);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://gemini.example/v1beta/models/gemini-3.8-flash:generateContent');
        expect(url).not.toContain('test-key');
        expect(init.headers).toMatchObject({ 'x-goog-api-key': 'test-key', 'X-Client': 'test' });
        expect(JSON.parse(init.body)).toEqual({
            contents: [{ role: 'user', parts: [{ text: '天气?' }] }],
            systemInstruction: { parts: [{ text: 'Be concise' }] },
            tools: [
                {
                    functionDeclarations: [
                        {
                            name: 'weather',
                            description: 'Look up weather',
                            parametersJsonSchema: tool.function.parameters,
                        },
                    ],
                },
            ],
            toolConfig: {
                functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['weather'] },
            },
            generationConfig: { temperature: 0.2, maxOutputTokens: 100 },
        });
    });

    test.each([
        ['auto', 'AUTO'],
        ['none', 'NONE'],
        ['required', 'ANY'],
    ])('maps tool choice %s', (choice, mode) => {
        const model = new GeminiChatModel({ apiKey: 'key', modelName: 'gemini-test' });
        expect(model._formatToolChoice(choice)).toEqual({ functionCallingConfig: { mode } });
        expect(model._formatToolSchemas()).toEqual([]);
    });

    test('rejects missing tools and unknown tool names before making a request', async () => {
        const model = new GeminiChatModel({ apiKey: 'key', modelName: 'gemini-test' });
        await expect(model.call({ messages, toolChoice: 'required' })).rejects.toThrow(
            'requires tools'
        );
        await expect(
            model.call({ messages, tools: [tool], toolChoice: 'missing' })
        ).rejects.toThrow('Unknown');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('returns parallel function calls, preserves signatures through serialization, and groups responses in one user turn', async () => {
        fetchMock.mockResolvedValue(
            Response.json(
                response(
                    [
                        {
                            functionCall: { name: 'weather', args: { city: '北京' }, id: 'call-a' },
                            thoughtSignature: 'opaque-signature',
                        },
                        {
                            functionCall: {
                                name: 'weather',
                                args: { city: 'Paris' },
                                id: 'call-b',
                            },
                        },
                    ],
                    {
                        usageMetadata: {
                            promptTokenCount: 20,
                            candidatesTokenCount: 5,
                            thoughtsTokenCount: 7,
                        },
                    }
                )
            )
        );
        const model = new GeminiChatModel({
            apiKey: 'key',
            modelName: 'gemini-test',
            stream: false,
        });
        const res = (await model.call({ messages, tools: [tool] })) as ChatResponse;
        expect(res.content.map(b => b.id)).toEqual(['call-a', 'call-b']);
        expect(res.usage).toMatchObject({ inputTokens: 20, outputTokens: 12 });
        const assistant = parseMsg(
            JSON.parse(
                JSON.stringify(
                    createMsg({ name: 'agent', role: 'assistant', content: res.content })
                )
            )
        );
        const history = await new GeminiChatFormatter().format({
            msgs: [
                assistant,
                createMsg({
                    name: 'tools',
                    role: 'assistant',
                    content: [
                        ToolResultBlock({
                            id: 'call-a',
                            name: 'weather',
                            output: 'Sunny',
                            state: 'success',
                        }),
                    ],
                }),
                createMsg({
                    name: 'tools',
                    role: 'assistant',
                    content: [
                        ToolResultBlock({
                            id: 'call-b',
                            name: 'weather',
                            output: 'Rainy',
                            state: 'success',
                        }),
                    ],
                }),
            ],
        });
        expect(history).toEqual([
            {
                role: 'model',
                parts: [
                    {
                        functionCall: { name: 'weather', args: { city: '北京' }, id: 'call-a' },
                        thoughtSignature: 'opaque-signature',
                    },
                    { functionCall: { name: 'weather', args: { city: 'Paris' }, id: 'call-b' } },
                ],
            },
            {
                role: 'user',
                parts: [
                    {
                        functionResponse: {
                            name: 'weather',
                            id: 'call-a',
                            response: { output: 'Sunny' },
                        },
                    },
                    {
                        functionResponse: {
                            name: 'weather',
                            id: 'call-b',
                            response: { output: 'Rainy' },
                        },
                    },
                ],
            },
        ]);
    });

    test('streams deltas, final complete function arguments and terminal usage across byte boundaries', async () => {
        fetchMock.mockResolvedValue(
            streamResponse([
                response([{ text: '分析', thought: true }]),
                response([{ text: '天气', thought: true }, { text: '结果：' }]),
                response([{ text: '晴天' }]),
                response([
                    {
                        functionCall: { name: 'weather', args: { city: '北京' } },
                        thoughtSignature: 'sig',
                    },
                ]),
                {
                    usageMetadata: {
                        promptTokenCount: 8,
                        candidatesTokenCount: 4,
                        thoughtsTokenCount: 3,
                    },
                },
                { candidates: [{ finishReason: 'STOP' }] },
            ])
        );
        const model = new GeminiChatModel({ apiKey: 'key', modelName: 'gemini-test' });
        const { deltas, final } = await collect(
            (await model.call({ messages, tools: [tool] })) as AsyncGenerator<
                ChatResponse,
                ChatResponse
            >
        );
        expect(fetchMock.mock.calls[0][0]).toContain(':streamGenerateContent?alt=sse');
        expect(final.content).toEqual([
            expect.objectContaining({ type: 'thinking', thinking: '分析天气' }),
            expect.objectContaining({ type: 'text', text: '结果：晴天' }),
            expect.objectContaining({
                type: 'tool_call',
                name: 'weather',
                input: '{"city":"北京"}',
                thought_signature: 'sig',
            }),
        ]);
        expect(deltas.every(d => d.id === final.id)).toBe(true);
        expect(deltas[2].content[0]).toMatchObject({ type: 'text', text: '晴天' });
        expect(final.usage).toMatchObject({ inputTokens: 8, outputTokens: 7 });
        expect(deltas[0].content[0]).toMatchObject({ thinking: '分析' }); // no mutation after yield
    });

    test('attaches a late signature to the accumulated text part and retains signed part boundaries', async () => {
        fetchMock.mockResolvedValue(
            streamResponse([
                response([{ text: 'First ' }]),
                response([{ text: 'part', thoughtSignature: 'sig-a' }]),
                response([{ text: 'Second' }]),
                response([{ thoughtSignature: 'sig-b' }]),
            ])
        );
        const model = new GeminiChatModel({ apiKey: 'key', modelName: 'gemini-test' });
        const { final } = await collect(
            (await model.call({ messages })) as AsyncGenerator<ChatResponse, ChatResponse>
        );
        const msg = parseMsg(
            JSON.parse(
                JSON.stringify(
                    createMsg({ name: 'agent', role: 'assistant', content: final.content })
                )
            )
        );
        expect(await new GeminiChatFormatter().format({ msgs: [msg] })).toEqual([
            {
                role: 'model',
                parts: [
                    { text: 'First part', thoughtSignature: 'sig-a' },
                    { text: 'Second', thoughtSignature: 'sig-b' },
                ],
            },
        ]);
    });

    test('callStructured uses named function calling in streaming mode', async () => {
        fetchMock.mockResolvedValue(
            streamResponse([
                response([
                    {
                        functionCall: {
                            name: 'GenerateStructuredResponse',
                            args: { city: 'Paris' },
                        },
                    },
                ]),
            ])
        );
        const model = new GeminiChatModel({ apiKey: 'key', modelName: 'gemini-test' });
        const res = await model.callStructured({
            messages,
            schema: z.object({ city: z.string() }),
        });
        expect(res.content).toEqual({ city: 'Paris' });
        expect(
            JSON.parse(fetchMock.mock.calls[0][1].body).toolConfig.functionCallingConfig
        ).toEqual({ mode: 'ANY', allowedFunctionNames: ['GenerateStructuredResponse'] });
    });

    test('Agent executes a Gemini tool call and replays its signature in the next model request', async () => {
        fetchMock
            .mockResolvedValueOnce(
                streamResponse([
                    response([
                        {
                            functionCall: {
                                name: 'weather',
                                args: { city: 'Paris' },
                                id: 'provider-call',
                            },
                            thoughtSignature: 'round-trip-sig',
                        },
                    ]),
                ])
            )
            .mockResolvedValueOnce(streamResponse([response([{ text: 'Sunny in Paris.' }])]));
        const call = jest
            .fn()
            .mockResolvedValue(
                createToolResponse({ content: [TextBlock({ text: 'Sunny' })], state: 'success' })
            );
        const toolkit = new Toolkit({
            builtInSkillTool: false,
            tools: [
                {
                    name: 'weather',
                    description: 'Look up weather',
                    inputSchema: z.object({ city: z.string() }),
                    call,
                    requireUserConfirm: false,
                },
            ],
        });
        const agent = new Agent({
            name: 'agent',
            sysPrompt: 'Help the user',
            toolkit,
            model: new GeminiChatModel({ apiKey: 'key', modelName: 'gemini-test' }),
        });
        for await (const _event of agent.replyStream({ msgs: messages })) {
            /* consume the real agent/tool lifecycle */
        }
        expect(call).toHaveBeenCalledWith({ city: 'Paris' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const next = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(next.contents).toEqual([
            { role: 'user', parts: [{ text: '天气?' }] },
            {
                role: 'model',
                parts: [
                    {
                        functionCall: {
                            name: 'weather',
                            args: { city: 'Paris' },
                            id: 'provider-call',
                        },
                        thoughtSignature: 'round-trip-sig',
                    },
                ],
            },
            {
                role: 'user',
                parts: [
                    {
                        functionResponse: {
                            name: 'weather',
                            id: 'provider-call',
                            response: { output: 'Sunny' },
                        },
                    },
                ],
            },
        ]);
        expect(agent.context.at(-1)?.content.at(-1)).toMatchObject({
            type: 'text',
            text: 'Sunny in Paris.',
        });
    });

    test('cancels the response body if the consumer stops streaming', async () => {
        const cancel = jest.fn();
        fetchMock.mockResolvedValue(
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(
                            new TextEncoder().encode(
                                `data: ${JSON.stringify(response([{ text: 'hello' }]))}\n\n`
                            )
                        );
                    },
                    cancel,
                })
            )
        );
        const model = new GeminiChatModel({ apiKey: 'key', modelName: 'gemini-test' });
        const generator = (await model.call({ messages })) as AsyncGenerator<
            ChatResponse,
            ChatResponse
        >;
        await generator.next();
        await generator.return({ type: 'chat', id: '', createdAt: '', content: [] });
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    test('surfaces HTTP errors, blocked prompts, empty and malformed stream responses', async () => {
        const model = new GeminiChatModel({
            apiKey: 'key',
            modelName: 'gemini-test',
            stream: false,
        });
        fetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
        await expect(model.call({ messages })).rejects.toThrow('429');
        fetchMock.mockResolvedValueOnce(
            Response.json({ promptFeedback: { blockReason: 'SAFETY' } })
        );
        await expect(model.call({ messages })).rejects.toThrow('SAFETY');
        fetchMock.mockResolvedValueOnce(
            Response.json({ candidates: [{ finishReason: 'SAFETY' }] })
        );
        await expect(model.call({ messages })).rejects.toThrow('no content');
        const streaming = new GeminiChatModel({ apiKey: 'key', modelName: 'gemini-test' });
        fetchMock.mockResolvedValueOnce(new Response('data: {broken}\n\n'));
        const generator = (await streaming.call({ messages })) as AsyncGenerator<
            ChatResponse,
            ChatResponse
        >;
        await expect(generator.next()).rejects.toThrow();
        fetchMock.mockResolvedValueOnce(
            streamResponse([{ error: { message: 'invalid request' } }])
        );
        const errorStream = (await streaming.call({ messages })) as AsyncGenerator<
            ChatResponse,
            ChatResponse
        >;
        await expect(errorStream.next()).rejects.toThrow('invalid request');
    });
});
