import { KimiChatModel } from './kimi-model';
import { ChatResponse } from './response';
import { createMsg } from '../message';

// Mock fetch for streaming and non-streaming responses
global.fetch = jest.fn();

describe('KimiChatModel', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('Test stream generation with tool call delta output', async () => {
        // Mock streaming response with multiple chunks (OpenAI-compatible SSE format)
        const mockStreamChunks = [
            'data: {"id":"chatcmpl-kimi-1","object":"chat.completion.chunk","created":1700000000,"model":"kimi-k2-turbo-preview","choices":[{"index":0,"delta":{"content":"Let me check"},"finish_reason":null}]}\n\n',
            'data: {"id":"chatcmpl-kimi-1","object":"chat.completion.chunk","created":1700000000,"model":"kimi-k2-turbo-preview","choices":[{"index":0,"delta":{"content":" the weather."},"finish_reason":null}]}\n\n',
            'data: {"id":"chatcmpl-kimi-1","object":"chat.completion.chunk","created":1700000000,"model":"kimi-k2-turbo-preview","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-kimi-1","type":"function","function":{"name":"get_current_weather","arguments":"{\\"location\\""}}]},"finish_reason":null}]}\n\n',
            'data: {"id":"chatcmpl-kimi-1","object":"chat.completion.chunk","created":1700000000,"model":"kimi-k2-turbo-preview","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"Beijing\\"}"}}]},"finish_reason":null}]}\n\n',
            'data: {"id":"chatcmpl-kimi-1","object":"chat.completion.chunk","created":1700000000,"model":"kimi-k2-turbo-preview","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":80,"completion_tokens":40,"total_tokens":120}}\n\n',
            'data: [DONE]\n\n',
        ];

        const mockReadableStream = new ReadableStream({
            start(controller) {
                mockStreamChunks.forEach(chunk =>
                    controller.enqueue(new TextEncoder().encode(chunk))
                );
                controller.close();
            },
        });

        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            body: mockReadableStream,
        });

        const model = new KimiChatModel({
            modelName: 'kimi-k2-turbo-preview',
            apiKey: 'test-api-key',
        });

        const res = await model.call({
            messages: [
                createMsg({
                    name: 'user',
                    role: 'user',
                    content: [{ id: crypto.randomUUID(), type: 'text', text: '查询北京天气' }],
                }),
            ],
            tools: [
                {
                    type: 'function',
                    function: {
                        name: 'get_current_weather',
                        description: 'Get the current weather in a given location',
                        parameters: {
                            type: 'object',
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
            ],
        });

        const generator = res as AsyncGenerator<ChatResponse, ChatResponse>;
        let completeResponse: ChatResponse | undefined;
        const yieldedChunks: ChatResponse[] = [];

        // Manually iterate to capture both yielded and returned values
        while (true) {
            const result = await generator.next();
            if (result.done) {
                completeResponse = result.value;
                break;
            }
            yieldedChunks.push(result.value);
        }

        // Verify we received multiple yielded chunks
        expect(yieldedChunks.length).toBeGreaterThan(0);

        // Verify the final complete response has correct structure
        expect(completeResponse.content.length).toBe(2);

        // Check text block - should be accumulated across chunks
        const textBlock = completeResponse.content.find(b => b.type === 'text');
        expect(textBlock).toBeDefined();
        expect(textBlock).toMatchObject({
            type: 'text',
            text: 'Let me check the weather.',
        });

        // Check tool_call block - input should be complete after accumulation
        const toolCallBlock = completeResponse.content.find(b => b.type === 'tool_call');
        expect(toolCallBlock).toBeDefined();
        expect(toolCallBlock).toMatchObject({
            type: 'tool_call',
            name: 'get_current_weather',
            id: 'call-kimi-1',
            input: '{"location":"Beijing"}',
            state: 'pending',
        });

        // Verify usage
        expect(completeResponse.usage).toBeDefined();
        expect(completeResponse.usage?.inputTokens).toBe(80);
        expect(completeResponse.usage?.outputTokens).toBe(40);

        // Verify the request went to the default OpenAI-compatible endpoint
        expect(global.fetch).toHaveBeenCalledWith(
            'https://api.kimi.com/coding/v1/chat/completions',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-api-key',
                    'Content-Type': 'application/json',
                }),
            })
        );
    }, 10000);

    test('Test non-streaming generation with tool call response', async () => {
        // Mock non-streaming response (OpenAI-compatible)
        const mockResponse = {
            id: 'chatcmpl-kimi-2',
            object: 'chat.completion',
            created: 1700000000,
            model: 'kimi-k2-turbo-preview',
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                            {
                                id: 'call-kimi-2',
                                type: 'function',
                                function: {
                                    name: 'get_current_weather',
                                    arguments: '{"location":"Beijing"}',
                                },
                            },
                        ],
                    },
                    finish_reason: 'tool_calls',
                },
            ],
            usage: {
                prompt_tokens: 80,
                completion_tokens: 40,
                total_tokens: 120,
            },
        };

        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => mockResponse,
        });

        const model = new KimiChatModel({
            modelName: 'kimi-k2-turbo-preview',
            apiKey: 'test-api-key',
            stream: false,
        });

        const res = await model.call({
            messages: [
                createMsg({
                    name: 'user',
                    role: 'user',
                    content: [{ id: crypto.randomUUID(), type: 'text', text: '查询北京天气' }],
                }),
            ],
            tools: [
                {
                    type: 'function',
                    function: {
                        name: 'get_current_weather',
                        description: 'Get the current weather in a given location',
                        parameters: {
                            type: 'object',
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
            ],
        });

        const completeResponse = res as ChatResponse;

        // Verify complete response structure - only one tool_call block
        expect(completeResponse.content.length).toBe(1);

        const toolCallBlock = completeResponse.content.find(b => b.type === 'tool_call');
        expect(toolCallBlock).toBeDefined();
        expect(toolCallBlock).toMatchObject({
            type: 'tool_call',
            name: 'get_current_weather',
            id: 'call-kimi-2',
            input: '{"location":"Beijing"}',
            state: 'pending',
        });

        // Verify usage
        expect(completeResponse.usage).toBeDefined();
        expect(completeResponse.usage?.inputTokens).toBe(80);
        expect(completeResponse.usage?.outputTokens).toBe(40);
    }, 10000);

    test('Test formatToolChoice function', () => {
        const model = new KimiChatModel({
            modelName: 'kimi-k2-turbo-preview',
            apiKey: 'test-api-key',
        });

        // Test 'auto' case
        expect(model._formatToolChoice('auto')).toBe('auto');

        // Test 'none' case
        expect(model._formatToolChoice('none')).toBe('none');

        // Test 'required' case
        expect(model._formatToolChoice('required')).toBe('required');

        // Test specific function name case
        expect(model._formatToolChoice('get_current_weather')).toEqual({
            type: 'function',
            function: {
                name: 'get_current_weather',
            },
        });

        // Test undefined case (should default to 'auto')
        expect(model._formatToolChoice(undefined)).toBe('auto');
    });

    test('Test formatToolSchemas function', () => {
        const model = new KimiChatModel({
            modelName: 'kimi-k2-turbo-preview',
            apiKey: 'test-api-key',
        });

        const toolSchemas = [
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

        // Test with tool schemas
        expect(model._formatToolSchemas(toolSchemas)).toEqual(toolSchemas);

        // Test with undefined (should return empty array)
        expect(model._formatToolSchemas(undefined)).toEqual([]);
    });

    test('Test endpoint resolution for different protocols and overrides', () => {
        // Default protocol is OpenAI-compatible
        const openaiModel = new KimiChatModel({
            modelName: 'kimi-k2-turbo-preview',
            apiKey: 'test-api-key',
        });
        expect(openaiModel.protocol).toBe('openai');
        expect(openaiModel.apiURL).toBe('https://api.kimi.com/coding/v1/chat/completions');

        // Anthropic-compatible protocol uses the Messages endpoint
        const anthropicModel = new KimiChatModel({
            modelName: 'kimi-k2-turbo-preview',
            apiKey: 'test-api-key',
            protocol: 'anthropic',
        });
        expect(anthropicModel.protocol).toBe('anthropic');
        expect(anthropicModel.apiURL).toBe('https://api.kimi.com/coding/v1/messages');

        // Custom baseURL is honored, trailing slash tolerated
        const customBaseModel = new KimiChatModel({
            modelName: 'kimi-k2-turbo-preview',
            apiKey: 'test-api-key',
            baseURL: 'https://proxy.example.com/kimi/v1/',
        });
        expect(customBaseModel.apiURL).toBe('https://proxy.example.com/kimi/v1/chat/completions');

        // Explicit apiURL takes precedence over baseURL/protocol
        const fullEndpointModel = new KimiChatModel({
            modelName: 'kimi-k2-turbo-preview',
            apiKey: 'test-api-key',
            baseURL: 'https://ignored.example.com',
            apiURL: 'https://api.kimi.com/coding/v1/chat/completions',
        });
        expect(fullEndpointModel.apiURL).toBe('https://api.kimi.com/coding/v1/chat/completions');
    });

    test('Test Anthropic-protocol request headers', async () => {
        const mockResponse = {
            id: 'chatcmpl-kimi-3',
            object: 'chat.completion',
            created: 1700000000,
            model: 'kimi-k2-turbo-preview',
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant', content: 'hello' },
                    finish_reason: 'stop',
                },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };

        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => mockResponse,
        });

        const model = new KimiChatModel({
            modelName: 'kimi-k2-turbo-preview',
            apiKey: 'test-api-key',
            protocol: 'anthropic',
            stream: false,
        });

        await model.call({
            messages: [
                createMsg({
                    name: 'user',
                    role: 'user',
                    content: [{ id: crypto.randomUUID(), type: 'text', text: 'hi' }],
                }),
            ],
        });

        // Anthropic protocol must use x-api-key, not Authorization
        expect(global.fetch).toHaveBeenCalledWith(
            'https://api.kimi.com/coding/v1/messages',
            expect.objectContaining({
                headers: expect.objectContaining({
                    'x-api-key': 'test-api-key',
                    'anthropic-version': '2023-06-01',
                }),
            })
        );
        const call = (global.fetch as jest.Mock).mock.calls[0];
        expect(call[1].headers).not.toHaveProperty('Authorization');
    });
});
