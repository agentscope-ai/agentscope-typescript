import { DashScopeChatModel } from './dashscope-model';
import { ChatResponse } from './response';
import { createMsg } from '../message';

// Mock fetch for streaming responses
global.fetch = jest.fn();

describe('DashScopeChatModel', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('Test stream generation with delta output', async () => {
        // Mock streaming response with multiple chunks
        // Chunk 1: First part of thinking
        // Chunk 2: Second part of thinking
        // Chunk 3: Tool call metadata (id, name) + first part of arguments
        // Chunk 4: Second part of arguments
        // Chunk 5: Usage info
        const mockStreamChunks = [
            'data:{"output":{"choices":[{"message":{"reasoning_content":"Mock thinking: Analyzing"}}]}}\n\n',
            'data:{"output":{"choices":[{"message":{"reasoning_content":" the weather query for Beijing"}}]}}\n\n',
            'data:{"output":{"choices":[{"message":{"tool_calls":[{"index":0,"id":"call-123","function":{"name":"get_current_weather","arguments":"{\\"location\\""}}]}}]}}\n\n',
            'data:{"output":{"choices":[{"message":{"tool_calls":[{"index":0,"function":{"arguments":":\\"Beijing\\"}"}}]}}]}}\n\n',
            'data:{"output":{"choices":[{"message":{}}]},"usage":{"input_tokens":100,"output_tokens":50}}\n\n',
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

        const model = new DashScopeChatModel({
            modelName: 'qwen3.5-plus',
            apiKey: 'test-api-key',
            stream: true,
            thinkingConfig: {
                enableThinking: true,
            },
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
                            text: "How's the weather today in Beijing?",
                        },
                    ],
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
            toolChoice: 'get_current_weather',
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

        // Verify we received 5 yielded chunks (before the final return)
        expect(yieldedChunks.length).toBe(5);

        // Chunk 1: First part of thinking
        expect(yieldedChunks[0].content.length).toBe(1);
        expect(yieldedChunks[0].content[0]).toMatchObject({
            type: 'thinking',
            thinking: 'Mock thinking: Analyzing',
        });

        // Chunk 2: Second part of thinking (delta)
        expect(yieldedChunks[1].content.length).toBe(1);
        expect(yieldedChunks[1].content[0]).toMatchObject({
            type: 'thinking',
            thinking: ' the weather query for Beijing',
        });

        // Chunk 3: Tool call with first part of arguments
        expect(yieldedChunks[2].content.length).toBe(1);
        expect(yieldedChunks[2].content[0]).toMatchObject({
            type: 'tool_call',
            name: 'get_current_weather',
            id: 'call-123',
            input: '{"location"',
            state: 'pending',
        });

        // Chunk 4: Tool call with second part of arguments (delta)
        expect(yieldedChunks[3].content.length).toBe(1);
        expect(yieldedChunks[3].content[0]).toMatchObject({
            type: 'tool_call',
            name: 'get_current_weather',
            id: 'call-123',
            input: ':"Beijing"}',
            state: 'pending',
        });

        // Chunk 5: Empty content with usage info
        expect(yieldedChunks[4].content.length).toBe(0);
        expect(yieldedChunks[4].usage).toBeDefined();
        expect(yieldedChunks[4].usage?.inputTokens).toBe(100);
        expect(yieldedChunks[4].usage?.outputTokens).toBe(50);

        // Verify the final complete response has correct structure
        expect(completeResponse.content.length).toBe(2);

        // Check thinking block - should be complete after accumulation
        const thinkingBlock = completeResponse.content.find(b => b.type === 'thinking');
        expect(thinkingBlock).toBeDefined();
        expect(thinkingBlock).toMatchObject({
            type: 'thinking',
            thinking: 'Mock thinking: Analyzing the weather query for Beijing',
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
            output: {
                choices: [
                    {
                        message: {
                            reasoning_content:
                                'Mock thinking: Analyzing the weather query for Beijing',
                            tool_calls: [
                                {
                                    index: 0,
                                    id: 'call-123',
                                    function: {
                                        name: 'get_current_weather',
                                        arguments: '{"location":"Beijing"}',
                                    },
                                },
                            ],
                        },
                    },
                ],
            },
            usage: {
                input_tokens: 100,
                output_tokens: 50,
            },
        };

        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => mockResponse,
        });

        const model = new DashScopeChatModel({
            modelName: 'qwen3.5-plus',
            apiKey: 'test-api-key',
            stream: false,
            thinkingConfig: {
                enableThinking: true,
            },
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
                            text: "How's the weather today in Beijing?",
                        },
                    ],
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
            toolChoice: 'get_current_weather',
        });

        const completeResponse = res as ChatResponse;

        // Verify complete response structure
        expect(completeResponse.content.length).toBe(2);

        // Check thinking block
        const thinkingBlock = completeResponse.content.find(b => b.type === 'thinking');
        expect(thinkingBlock).toBeDefined();
        expect(thinkingBlock).toMatchObject({
            type: 'thinking',
            thinking: 'Mock thinking: Analyzing the weather query for Beijing',
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
        const model = new DashScopeChatModel({
            modelName: 'qwen3.5-plus',
            apiKey: 'test-api-key',
            stream: false,
        });

        // Test 'auto' case
        expect(model['_formatToolChoice']('auto')).toBe('auto');

        // Test 'none' case
        expect(model['_formatToolChoice']('none')).toBe('none');

        // Test specific function name case
        expect(model['_formatToolChoice']('get_current_weather')).toEqual({
            type: 'function',
            function: {
                name: 'get_current_weather',
            },
        });

        // Test undefined case (should default to 'auto')
        expect(model['_formatToolChoice'](undefined)).toBe('auto');
    });

    test('Test formatToolSchemas function', () => {
        const model = new DashScopeChatModel({
            modelName: 'qwen3.5-plus',
            apiKey: 'test-api-key',
            stream: false,
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
        expect(model['_formatToolSchemas'](toolSchemas)).toEqual(toolSchemas);

        // Test with undefined (should return empty array)
        expect(model['_formatToolSchemas'](undefined)).toEqual([]);
    });
});
