import { DeepSeekChatModel } from './deepseek-model';
import { ChatResponse } from './response';
import { createMsg } from '../message';

// Mock fetch for streaming responses
global.fetch = jest.fn();

describe('DeepSeekChatModel', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('Test stream generation with delta output', async () => {
        // Mock streaming response with multiple chunks (SSE format)
        // DeepSeek uses OpenAI-compatible API format
        const mockStreamChunks = [
            'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"reasoning_content":"Analyzing the"},"finish_reason":null}]}\n\n',
            'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"reasoning_content":" weather query"},"finish_reason":null}]}\n\n',
            'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-123","type":"function","function":{"name":"get_current_weather","arguments":"{\\"location\\""}}]},"finish_reason":null}]}\n\n',
            'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"Beijing\\"}"}}]},"finish_reason":null}]}\n\n',
            'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}\n\n',
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

        const model = new DeepSeekChatModel({
            modelName: 'deepseek-reasoner',
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

        // Manual iteration to capture both yielded and returned values
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

        // Check thinking block - should be complete after accumulation
        const thinkingBlock = completeResponse.content.find(b => b.type === 'thinking');
        expect(thinkingBlock).toBeDefined();
        expect(thinkingBlock).toMatchObject({
            type: 'thinking',
            thinking: 'Analyzing the weather query',
        });

        // Check tool_call block - input should be complete after accumulation
        const toolCallBlock = completeResponse.content.find(b => b.type === 'tool_call');
        expect(toolCallBlock).toBeDefined();
        expect(toolCallBlock).toMatchObject({
            type: 'tool_call',
            name: 'get_current_weather',
            id: 'call-123',
            input: '{"location":"Beijing"}',
            state: 'pending',
        });

        // Verify usage
        expect(completeResponse.usage).toBeDefined();
        expect(completeResponse.usage?.inputTokens).toBe(100);
        expect(completeResponse.usage?.outputTokens).toBe(50);
    }, 10000);

    test('Test non-streaming generation', async () => {
        // Mock non-streaming response
        const mockResponse = {
            id: 'chatcmpl-123',
            object: 'chat.completion',
            created: 1234567890,
            model: 'deepseek-reasoner',
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        reasoning_content: 'Analyzing the weather query',
                        tool_calls: [
                            {
                                id: 'call-123',
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
                prompt_tokens: 100,
                completion_tokens: 50,
                total_tokens: 150,
            },
        };

        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => mockResponse,
        });

        const model = new DeepSeekChatModel({
            modelName: 'deepseek-reasoner',
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

        // Verify complete response structure
        expect(completeResponse.content.length).toBe(2);

        // Check thinking block
        const thinkingBlock = completeResponse.content.find(b => b.type === 'thinking');
        expect(thinkingBlock).toBeDefined();
        expect(thinkingBlock).toMatchObject({
            type: 'thinking',
            thinking: 'Analyzing the weather query',
        });

        // Check tool_call block
        const toolCallBlock = completeResponse.content.find(b => b.type === 'tool_call');
        expect(toolCallBlock).toBeDefined();
        expect(toolCallBlock).toMatchObject({
            type: 'tool_call',
            name: 'get_current_weather',
            id: 'call-123',
            input: '{"location":"Beijing"}',
            state: 'pending',
        });

        // Verify usage
        expect(completeResponse.usage).toBeDefined();
        expect(completeResponse.usage?.inputTokens).toBe(100);
        expect(completeResponse.usage?.outputTokens).toBe(50);
    }, 10000);

    test('Test formatToolChoice function', () => {
        const model = new DeepSeekChatModel({
            modelName: 'deepseek-chat',
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
        const model = new DeepSeekChatModel({
            modelName: 'deepseek-chat',
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
});
