import { GrokChatModel } from './grok-model';
import { ChatResponse } from './response';
import { createMsg } from '../message';

// Mock global fetch for all tests
global.fetch = jest.fn();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal tool schema used across tests. */
const weatherToolSchema = [
    {
        type: 'function' as const,
        function: {
            name: 'get_current_weather',
            description: 'Get the current weather in a given location',
            parameters: {
                type: 'object' as const,
                properties: {
                    location: {
                        type: 'string',
                        description: 'The city and state, e.g. San Francisco, CA',
                    },
                },
                required: ['location'],
            },
        },
    },
];

/**
 * Build a ReadableStream from an array of SSE string chunks.
 * @param chunks
 */
function buildReadableStream(chunks: string[]): ReadableStream {
    return new ReadableStream({
        start(controller) {
            chunks.forEach(chunk => controller.enqueue(new TextEncoder().encode(chunk)));
            controller.close();
        },
    });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('GrokChatModel', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 1. Streaming – plain text response
    // ──────────────────────────────────────────────────────────────────────────
    test('streams plain-text response and returns complete ChatResponse', async () => {
        const mockChunks = [
            'data: {"id":"chatcmpl-g1","created":1739301120,"choices":[{"index":0,"delta":{"content":"Ah,","role":"assistant"}}],"usage":{"prompt_tokens":41,"completion_tokens":1,"total_tokens":42}}\n\n',
            'data: {"id":"chatcmpl-g1","created":1739301120,"choices":[{"index":0,"delta":{"content":" the answer is 42.","role":"assistant"}}],"usage":{"prompt_tokens":41,"completion_tokens":5,"total_tokens":46}}\n\n',
            'data: {"id":"chatcmpl-g1","created":1739301120,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":41,"completion_tokens":6,"total_tokens":47}}\n\n',
            'data: [DONE]\n\n',
        ];

        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            body: buildReadableStream(mockChunks),
        });

        const model = new GrokChatModel({
            modelName: 'grok-3-latest',
            apiKey: 'test-xai-key',
        });

        const res = await model.call({
            messages: [
                createMsg({
                    name: 'user',
                    role: 'user',
                    content: [
                        {
                            id: crypto.randomUUID(),
                            type: 'text',
                            text: 'What is the meaning of life?',
                        },
                    ],
                }),
            ],
        });

        const generator = res as AsyncGenerator<ChatResponse, ChatResponse>;
        const yieldedChunks: ChatResponse[] = [];
        let completeResponse: ChatResponse | undefined;

        while (true) {
            const result = await generator.next();
            if (result.done) {
                completeResponse = result.value;
                break;
            }
            yieldedChunks.push(result.value);
        }

        // Should have received at least 1 delta chunk
        expect(yieldedChunks.length).toBeGreaterThan(0);

        // Final response: single text block with accumulated content
        expect(completeResponse).toBeDefined();
        expect(completeResponse!.content.length).toBe(1);

        const textBlock = completeResponse!.content[0];
        expect(textBlock.type).toBe('text');
        if (textBlock.type === 'text') {
            expect(textBlock.text).toBe('Ah, the answer is 42.');
        }

        // Usage present
        expect(completeResponse!.usage).toBeDefined();
        expect(completeResponse!.usage?.inputTokens).toBe(41);
    }, 10000);

    // ──────────────────────────────────────────────────────────────────────────
    // 2. Streaming – reasoning model (grok-3-mini-*) with thinking + text
    // ──────────────────────────────────────────────────────────────────────────
    test('streams reasoning_content (thinking) and text for grok-3-mini models', async () => {
        const mockChunks = [
            'data: {"id":"chatcmpl-g2","created":1739301200,"choices":[{"index":0,"delta":{"reasoning_content":"Let me think...","role":"assistant"}}]}\n\n',
            'data: {"id":"chatcmpl-g2","created":1739301200,"choices":[{"index":0,"delta":{"reasoning_content":" 101 * 3 = 303.","role":"assistant"}}]}\n\n',
            'data: {"id":"chatcmpl-g2","created":1739301200,"choices":[{"index":0,"delta":{"content":"The answer is 303.","role":"assistant"}}],"usage":{"prompt_tokens":14,"completion_tokens":10,"total_tokens":24}}\n\n',
            'data: {"id":"chatcmpl-g2","created":1739301200,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
        ];

        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            body: buildReadableStream(mockChunks),
        });

        const model = new GrokChatModel({
            modelName: 'grok-3-mini-latest',
            apiKey: 'test-xai-key',
            reasoningConfig: { reasoningEffort: 'high' },
        });

        const res = await model.call({
            messages: [
                createMsg({
                    name: 'user',
                    role: 'user',
                    content: [{ id: crypto.randomUUID(), type: 'text', text: 'What is 101*3?' }],
                }),
            ],
        });

        const generator = res as AsyncGenerator<ChatResponse, ChatResponse>;
        let completeResponse: ChatResponse | undefined;

        while (true) {
            const result = await generator.next();
            if (result.done) {
                completeResponse = result.value;
                break;
            }
        }

        // Final response should have thinking + text blocks
        expect(completeResponse!.content.length).toBe(2);

        const thinkingBlock = completeResponse!.content.find(b => b.type === 'thinking');
        expect(thinkingBlock).toBeDefined();
        expect(thinkingBlock).toMatchObject({
            type: 'thinking',
            thinking: 'Let me think... 101 * 3 = 303.',
        });

        const textBlock = completeResponse!.content.find(b => b.type === 'text');
        expect(textBlock).toBeDefined();
        expect(textBlock).toMatchObject({
            type: 'text',
            text: 'The answer is 303.',
        });
    }, 10000);

    // ──────────────────────────────────────────────────────────────────────────
    // 3. Streaming – tool call accumulation
    // ──────────────────────────────────────────────────────────────────────────
    test('streams and accumulates tool call arguments correctly', async () => {
        const mockChunks = [
            'data: {"id":"chatcmpl-g3","created":1739301300,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-abc","function":{"name":"get_current_weather","arguments":"{\\"location\\""}}],"role":"assistant"}}]}\n\n',
            'data: {"id":"chatcmpl-g3","created":1739301300,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"London\\"}"}]}}]}\n\n',
            'data: {"id":"chatcmpl-g3","created":1739301300,"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":80,"completion_tokens":25,"total_tokens":105}}\n\n',
            'data: [DONE]\n\n',
        ];

        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            body: buildReadableStream(mockChunks),
        });

        const model = new GrokChatModel({
            modelName: 'grok-3-latest',
            apiKey: 'test-xai-key',
        });

        const res = await model.call({
            messages: [
                createMsg({
                    name: 'user',
                    role: 'user',
                    content: [{ id: crypto.randomUUID(), type: 'text', text: 'London weather?' }],
                }),
            ],
            tools: weatherToolSchema,
        });

        const generator = res as AsyncGenerator<ChatResponse, ChatResponse>;
        let completeResponse: ChatResponse | undefined;

        while (true) {
            const result = await generator.next();
            if (result.done) {
                completeResponse = result.value;
                break;
            }
        }

        const toolCallBlock = completeResponse!.content.find(b => b.type === 'tool_call');
        expect(toolCallBlock).toBeDefined();
        expect(toolCallBlock).toMatchObject({
            type: 'tool_call',
            id: 'call-abc',
            name: 'get_current_weather',
            input: '{"location":"London"}',
            state: 'pending',
        });

        expect(completeResponse!.usage?.inputTokens).toBe(80);
        expect(completeResponse!.usage?.outputTokens).toBe(25);
    }, 10000);

    // ──────────────────────────────────────────────────────────────────────────
    // 4. Non-streaming – plain text
    // ──────────────────────────────────────────────────────────────────────────
    test('returns complete ChatResponse in non-streaming mode (plain text)', async () => {
        const mockResponse = {
            id: 'chatcmpl-g4',
            object: 'chat.completion',
            created: 1739301120,
            model: 'grok-3-latest',
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: 'The meaning of life, the universe, and everything is 42.',
                        refusal: null,
                    },
                    finish_reason: 'stop',
                },
            ],
            usage: {
                prompt_tokens: 41,
                completion_tokens: 104,
                total_tokens: 145,
            },
            system_fingerprint: 'fp_84ff176447',
        };

        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => mockResponse,
        });

        const model = new GrokChatModel({
            modelName: 'grok-3-latest',
            apiKey: 'test-xai-key',
            stream: false,
        });

        const res = await model.call({
            messages: [
                createMsg({
                    name: 'user',
                    role: 'user',
                    content: [
                        {
                            id: crypto.randomUUID(),
                            type: 'text',
                            text: 'What is the meaning of life?',
                        },
                    ],
                }),
            ],
        });

        const response = res as ChatResponse;
        expect(response.content.length).toBe(1);
        expect(response.content[0].type).toBe('text');
        if (response.content[0].type === 'text') {
            expect(response.content[0].text).toBe(
                'The meaning of life, the universe, and everything is 42.'
            );
        }

        expect(response.usage?.inputTokens).toBe(41);
        expect(response.usage?.outputTokens).toBe(104);
        // id preserved from API response
        expect(response.id).toBe('chatcmpl-g4');
    }, 10000);

    // ──────────────────────────────────────────────────────────────────────────
    // 5. Non-streaming – reasoning model with tool call
    // ──────────────────────────────────────────────────────────────────────────
    test('returns thinking block + tool call in non-streaming mode', async () => {
        const mockResponse = {
            id: 'chatcmpl-g5',
            object: 'chat.completion',
            created: 1739301200,
            model: 'grok-3-mini-latest',
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        reasoning_content:
                            'User wants London weather. I should call the weather tool.',
                        content: null,
                        tool_calls: [
                            {
                                id: 'call-xyz',
                                type: 'function',
                                function: {
                                    name: 'get_current_weather',
                                    arguments: '{"location":"London"}',
                                },
                            },
                        ],
                    },
                    finish_reason: 'tool_calls',
                },
            ],
            usage: {
                prompt_tokens: 80,
                completion_tokens: 30,
                total_tokens: 110,
            },
        };

        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => mockResponse,
        });

        const model = new GrokChatModel({
            modelName: 'grok-3-mini-latest',
            apiKey: 'test-xai-key',
            stream: false,
            reasoningConfig: { reasoningEffort: 'high' },
        });

        const res = await model.call({
            messages: [
                createMsg({
                    name: 'user',
                    role: 'user',
                    content: [{ id: crypto.randomUUID(), type: 'text', text: 'London weather?' }],
                }),
            ],
            tools: weatherToolSchema,
        });

        const response = res as ChatResponse;
        expect(response.content.length).toBe(2);

        const thinkingBlock = response.content.find(b => b.type === 'thinking');
        expect(thinkingBlock).toMatchObject({
            type: 'thinking',
            thinking: 'User wants London weather. I should call the weather tool.',
        });

        const toolCallBlock = response.content.find(b => b.type === 'tool_call');
        expect(toolCallBlock).toMatchObject({
            type: 'tool_call',
            id: 'call-xyz',
            name: 'get_current_weather',
            input: '{"location":"London"}',
            state: 'pending',
        });

        expect(response.usage?.inputTokens).toBe(80);
        expect(response.usage?.outputTokens).toBe(30);
    }, 10000);

    // ──────────────────────────────────────────────────────────────────────────
    // 6. Error handling – non-2xx API response
    // ──────────────────────────────────────────────────────────────────────────
    test('throws an error when the API returns a non-ok status', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            status: 401,
            text: async () => 'Unauthorized',
        });

        const model = new GrokChatModel({
            modelName: 'grok-3-latest',
            apiKey: 'invalid-key',
            stream: false,
        });

        await expect(
            model.call({
                messages: [
                    createMsg({
                        name: 'user',
                        role: 'user',
                        content: [{ id: crypto.randomUUID(), type: 'text', text: 'Hello' }],
                    }),
                ],
            })
        ).rejects.toThrow('Grok API request failed with status 401: Unauthorized');
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 7. _formatToolChoice
    // ──────────────────────────────────────────────────────────────────────────
    test('_formatToolChoice returns correct values for standard options', () => {
        const model = new GrokChatModel({
            modelName: 'grok-3-latest',
            apiKey: 'test-key',
        });

        expect(model._formatToolChoice('auto')).toBe('auto');
        expect(model._formatToolChoice('none')).toBe('none');
        expect(model._formatToolChoice('required')).toBe('required');
        expect(model._formatToolChoice('get_current_weather')).toEqual({
            type: 'function',
            function: { name: 'get_current_weather' },
        });
        // Undefined defaults to 'auto'
        expect(model._formatToolChoice(undefined)).toBe('auto');
    });

    test('_formatToolChoice falls back to "auto" for specific function names when reasoningConfig is set', () => {
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        const model = new GrokChatModel({
            modelName: 'grok-3-mini-latest',
            apiKey: 'test-key',
            reasoningConfig: { reasoningEffort: 'high' },
        });

        // Specific function name should be downgraded to 'auto' for reasoning models
        expect(model._formatToolChoice('get_current_weather')).toBe('auto');
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Falling back to 'auto'"));

        // Standard options still pass through
        expect(model._formatToolChoice('none')).toBe('none');
        expect(model._formatToolChoice('auto')).toBe('auto');

        consoleSpy.mockRestore();
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 8. _formatToolSchemas
    // ──────────────────────────────────────────────────────────────────────────
    test('_formatToolSchemas returns schemas unchanged and empty array for undefined', () => {
        const model = new GrokChatModel({
            modelName: 'grok-3-latest',
            apiKey: 'test-key',
        });

        expect(model._formatToolSchemas(weatherToolSchema)).toEqual(weatherToolSchema);
        expect(model._formatToolSchemas(undefined)).toEqual([]);
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 9. Request body includes reasoning_effort when reasoningConfig is set
    // ──────────────────────────────────────────────────────────────────────────
    test('includes reasoning_effort in request body when reasoningConfig is provided', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => ({
                id: 'chatcmpl-g9',
                created: 1739301200,
                choices: [
                    {
                        index: 0,
                        message: { role: 'assistant', content: 'Result: 303.' },
                        finish_reason: 'stop',
                    },
                ],
                usage: { prompt_tokens: 14, completion_tokens: 5 },
            }),
        });

        const model = new GrokChatModel({
            modelName: 'grok-3-mini-latest',
            apiKey: 'test-key',
            stream: false,
            reasoningConfig: { reasoningEffort: 'high' },
        });

        await model.call({
            messages: [
                createMsg({
                    name: 'user',
                    role: 'user',
                    content: [{ id: crypto.randomUUID(), type: 'text', text: 'What is 101*3?' }],
                }),
            ],
        });

        const requestBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
        expect(requestBody.reasoning_effort).toBe('high');
        expect(requestBody.model).toBe('grok-3-mini-latest');
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 10. presetGenParams are merged into the request body
    // ──────────────────────────────────────────────────────────────────────────
    test('merges presetGenParams into every request body', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => ({
                id: 'chatcmpl-g10',
                created: 1739301200,
                choices: [
                    {
                        index: 0,
                        message: { role: 'assistant', content: 'Hello' },
                        finish_reason: 'stop',
                    },
                ],
                usage: { prompt_tokens: 5, completion_tokens: 2 },
            }),
        });

        const model = new GrokChatModel({
            modelName: 'grok-3-latest',
            apiKey: 'test-key',
            stream: false,
            presetGenParams: { temperature: 0, max_tokens: 512 },
        });

        await model.call({
            messages: [
                createMsg({
                    name: 'user',
                    role: 'user',
                    content: [{ id: crypto.randomUUID(), type: 'text', text: 'Hi' }],
                }),
            ],
        });

        const requestBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
        expect(requestBody.temperature).toBe(0);
        expect(requestBody.max_tokens).toBe(512);
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 11. API URL is set to the xAI endpoint
    // ──────────────────────────────────────────────────────────────────────────
    test('sends requests to the xAI API endpoint', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => ({
                id: 'chatcmpl-g11',
                created: 1739301200,
                choices: [
                    {
                        index: 0,
                        message: { role: 'assistant', content: 'Ok' },
                        finish_reason: 'stop',
                    },
                ],
                usage: { prompt_tokens: 5, completion_tokens: 1 },
            }),
        });

        const model = new GrokChatModel({
            modelName: 'grok-3-latest',
            apiKey: 'test-key',
            stream: false,
        });

        await model.call({
            messages: [
                createMsg({
                    name: 'user',
                    role: 'user',
                    content: [{ id: crypto.randomUUID(), type: 'text', text: 'Hi' }],
                }),
            ],
        });

        expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(
            'https://api.x.ai/v1/chat/completions'
        );

        const requestHeaders = (global.fetch as jest.Mock).mock.calls[0][1].headers;
        expect(requestHeaders.Authorization).toBe('Bearer test-key');
        expect(requestHeaders['Content-Type']).toBe('application/json');
    });
});
