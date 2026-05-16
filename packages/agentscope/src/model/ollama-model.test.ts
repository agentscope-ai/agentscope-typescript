import { OllamaChatModel } from './ollama-model';
import { ChatResponse } from './response';
import { createMsg } from '../message';

// Mock fetch for streaming responses
global.fetch = jest.fn();

describe('OllamaChatModel', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('Test stream generation with delta output', async () => {
        // Mock streaming response with multiple chunks (NDJSON format)
        // Ollama returns newline-delimited JSON
        const mockStreamChunks = [
            '{"model":"qwen3:1.7b","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"Let me"},"done":false}\n',
            '{"model":"qwen3:1.7b","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":" check the weather"},"done":false}\n',
            '{"model":"qwen3:1.7b","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"get_current_weather","arguments":{"location":"Beijing"}}}]},"done":false}\n',
            '{"model":"qwen3:1.7b","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":100,"eval_count":50}\n',
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

        const model = new OllamaChatModel({
            modelName: 'qwen3:1.7b',
            stream: true,
            host: 'http://localhost:11434',
        });

        const res = await model.call({
            messages: [
                createMsg({
                    name: 'user',
                    role: 'user',
                    content: [
                        { type: 'text', text: "How's the weather today?", id: crypto.randomUUID() },
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

        // Check text block - should be complete after accumulation
        const textBlock = completeResponse.content.find(b => b.type === 'text');
        expect(textBlock).toBeDefined();
        expect(textBlock).toMatchObject({
            type: 'text',
            text: 'Let me check the weather',
        });

        // Check tool_call block
        const toolCallBlock = completeResponse.content.find(b => b.type === 'tool_call');
        expect(toolCallBlock).toBeDefined();
        expect(toolCallBlock).toMatchObject({
            type: 'tool_call',
            name: 'get_current_weather',
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
            model: 'qwen3:8b',
            created_at: '2024-01-01T00:00:00Z',
            message: {
                role: 'assistant',
                content: '你好！我是一个AI助手。',
            },
            done: true,
            prompt_eval_count: 50,
            eval_count: 30,
        };

        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => mockResponse,
        });

        const model = new OllamaChatModel({
            modelName: 'qwen3:8b',
            stream: false,
            host: 'http://localhost:11434',
        });

        const res = await model.call({
            messages: [
                createMsg({
                    name: 'user',
                    role: 'user',
                    content: [
                        { type: 'text', text: '你好，请简单介绍一下自己', id: crypto.randomUUID() },
                    ],
                }),
            ],
        });

        const completeResponse = res as ChatResponse;

        // Verify complete response structure
        expect(completeResponse.content.length).toBe(1);

        // Check text block
        const textBlock = completeResponse.content.find(b => b.type === 'text');
        expect(textBlock).toBeDefined();
        expect(textBlock).toMatchObject({
            type: 'text',
            text: '你好！我是一个AI助手。',
        });

        // Verify usage
        expect(completeResponse.usage).toBeDefined();
        expect(completeResponse.usage?.inputTokens).toBe(50);
        expect(completeResponse.usage?.outputTokens).toBe(30);
    }, 10000);

    test('Test with thinking enabled', async () => {
        // Mock streaming response with thinking
        const mockStreamChunks = [
            '{"model":"qwen3:8b","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","thinking":"计算"},"done":false}\n',
            '{"model":"qwen3:8b","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","thinking":" 123 * 456"},"done":false}\n',
            '{"model":"qwen3:8b","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"答案是 56088"},"done":false}\n',
            '{"model":"qwen3:8b","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":80,"eval_count":40}\n',
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

        const model = new OllamaChatModel({
            modelName: 'qwen3:8b',
            stream: true,
            thinkingConfig: {
                enableThinking: true,
            },
            host: 'http://localhost:11434',
        });

        const res = await model.call({
            messages: [
                createMsg({
                    name: 'user',
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: '计算 123 * 456 等于多少？',
                            id: crypto.randomUUID(),
                        },
                    ],
                }),
            ],
        });

        const generator = res as AsyncGenerator<ChatResponse, ChatResponse>;
        let completeResponse: ChatResponse | undefined;
        const yieldedChunks: ChatResponse[] = [];

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

        // Check thinking block
        const thinkingBlock = completeResponse.content.find(b => b.type === 'thinking');
        expect(thinkingBlock).toBeDefined();
        expect(thinkingBlock).toMatchObject({
            type: 'thinking',
            thinking: '计算 123 * 456',
        });

        // Check text block
        const textBlock = completeResponse.content.find(b => b.type === 'text');
        expect(textBlock).toBeDefined();
        expect(textBlock).toMatchObject({
            type: 'text',
            text: '答案是 56088',
        });

        // Verify usage
        expect(completeResponse.usage).toBeDefined();
        expect(completeResponse.usage?.inputTokens).toBe(80);
        expect(completeResponse.usage?.outputTokens).toBe(40);
    }, 10000);

    test('Test formatToolChoice function', () => {
        const model = new OllamaChatModel({
            modelName: 'qwen3:1.7b',
            host: 'http://localhost:11434',
        });

        // Ollama's _formatToolChoice always returns undefined
        expect(model._formatToolChoice('auto')).toBeUndefined();
        expect(model._formatToolChoice('none')).toBeUndefined();
        expect(model._formatToolChoice('my_function')).toBeUndefined();
        expect(model._formatToolChoice(undefined)).toBeUndefined();
    });

    test('Test formatToolSchemas function', () => {
        const model = new OllamaChatModel({
            modelName: 'qwen3:1.7b',
            host: 'http://localhost:11434',
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
