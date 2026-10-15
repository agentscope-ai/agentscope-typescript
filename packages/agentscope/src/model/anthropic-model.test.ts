import type Anthropic from '@anthropic-ai/sdk';

import { createMsg } from '../message';
import { ToolSchema } from '../type';
import { AnthropicChatModel } from './anthropic-model';
import { ChatResponse } from './response';

const toolSchema: ToolSchema = {
    type: 'function',
    function: {
        name: 'get_weather',
        description: 'Get the weather for a city.',
        parameters: {
            type: 'object',
            properties: {
                city: {
                    type: 'string',
                },
            },
            required: ['city'],
        },
    },
};

/**
 * Create a model for unit tests.
 *
 * @param stream
 * @returns A configured Anthropic model.
 */
function createModel(stream: boolean): AnthropicChatModel {
    return new AnthropicChatModel({
        modelName: 'claude-sonnet-4-6',
        apiKey: 'test-api-key',
        maxTokens: 512,
        stream,
    });
}

/**
 * Create an async iterable from mock stream events.
 *
 * @param events
 * @returns A mock Anthropic event stream.
 */
async function* createMockStream(
    events: Anthropic.RawMessageStreamEvent[]
): AsyncGenerator<Anthropic.RawMessageStreamEvent> {
    for (const event of events) {
        yield event;
    }
}

describe('AnthropicChatModel', () => {
    test('generates a non-streaming response with tool calls', async () => {
        const response = {
            id: 'msg_123',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [
                {
                    type: 'text',
                    text: 'I will check the weather.',
                },
                {
                    type: 'tool_use',
                    id: 'toolu_123',
                    name: 'get_weather',
                    input: {
                        city: 'Beijing',
                    },
                },
            ],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: {
                input_tokens: 25,
                output_tokens: 12,
            },
        } as unknown as Anthropic.Message;
        const create = jest.fn().mockResolvedValue(response);
        const model = createModel(false);
        Object.assign(model['client'].messages, { create });

        const result = (await model.call({
            messages: [
                createMsg({
                    name: 'system',
                    role: 'system',
                    content: 'You are a helpful assistant.',
                }),
                createMsg({
                    name: 'user',
                    role: 'user',
                    content: 'What is the weather in Beijing?',
                }),
            ],
            tools: [toolSchema],
            toolChoice: 'get_weather',
        })) as ChatResponse;

        expect(create).toHaveBeenCalledWith({
            model: 'claude-sonnet-4-6',
            max_tokens: 512,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'What is the weather in Beijing?',
                        },
                    ],
                },
            ],
            system: [
                {
                    type: 'text',
                    text: 'You are a helpful assistant.',
                },
            ],
            tools: [
                {
                    name: 'get_weather',
                    description: 'Get the weather for a city.',
                    input_schema: toolSchema.function.parameters,
                },
            ],
            tool_choice: {
                type: 'tool',
                name: 'get_weather',
            },
            stream: false,
        });
        expect(result).toMatchObject({
            id: 'msg_123',
            type: 'chat',
            content: [
                {
                    type: 'text',
                    text: 'I will check the weather.',
                },
                {
                    type: 'tool_call',
                    id: 'toolu_123',
                    name: 'get_weather',
                    input: '{"city":"Beijing"}',
                    state: 'pending',
                },
            ],
            usage: {
                inputTokens: 25,
                outputTokens: 12,
            },
        });
    });

    test('omits tool parameters when no tools are provided', async () => {
        const response = {
            id: 'msg_text',
            content: [
                {
                    type: 'text',
                    text: 'Hello!',
                },
            ],
            usage: {
                input_tokens: 5,
                output_tokens: 2,
            },
        } as unknown as Anthropic.Message;
        const create = jest.fn().mockResolvedValue(response);
        const model = createModel(false);
        Object.assign(model['client'].messages, { create });

        await model.call({
            messages: [
                createMsg({
                    name: 'user',
                    role: 'user',
                    content: 'Hello',
                }),
            ],
        });

        const request = create.mock.calls[0][0];
        expect(request).not.toHaveProperty('tools');
        expect(request).not.toHaveProperty('tool_choice');
    });

    test('generates streaming text and tool call deltas', async () => {
        const events = [
            {
                type: 'message_start',
                message: {
                    id: 'msg_stream',
                    usage: {
                        input_tokens: 30,
                        output_tokens: 0,
                    },
                },
            },
            {
                type: 'content_block_start',
                index: 0,
                content_block: {
                    type: 'text',
                    text: '',
                },
            },
            {
                type: 'content_block_delta',
                index: 0,
                delta: {
                    type: 'text_delta',
                    text: 'Checking ',
                },
            },
            {
                type: 'content_block_delta',
                index: 0,
                delta: {
                    type: 'text_delta',
                    text: 'the weather.',
                },
            },
            {
                type: 'content_block_start',
                index: 1,
                content_block: {
                    type: 'tool_use',
                    id: 'toolu_stream',
                    name: 'get_weather',
                    input: {},
                },
            },
            {
                type: 'content_block_delta',
                index: 1,
                delta: {
                    type: 'input_json_delta',
                    partial_json: '{"city"',
                },
            },
            {
                type: 'content_block_delta',
                index: 1,
                delta: {
                    type: 'input_json_delta',
                    partial_json: ':"Beijing"}',
                },
            },
            {
                type: 'message_delta',
                delta: {
                    stop_reason: 'tool_use',
                    stop_sequence: null,
                },
                usage: {
                    output_tokens: 18,
                },
            },
            {
                type: 'message_stop',
            },
        ] as unknown as Anthropic.RawMessageStreamEvent[];
        const create = jest.fn().mockResolvedValue(createMockStream(events));
        const model = createModel(true);
        Object.assign(model['client'].messages, { create });

        const result = (await model.call({
            messages: [
                createMsg({
                    name: 'user',
                    role: 'user',
                    content: 'What is the weather in Beijing?',
                }),
            ],
            tools: [toolSchema],
            toolChoice: 'required',
        })) as AsyncGenerator<ChatResponse, ChatResponse>;
        const deltas: ChatResponse[] = [];
        let completeResponse: ChatResponse | undefined;

        while (true) {
            const next = await result.next();
            if (next.done) {
                completeResponse = next.value;
                break;
            }
            deltas.push(next.value);
        }

        expect(create).toHaveBeenCalledWith(
            expect.objectContaining({
                stream: true,
                tool_choice: {
                    type: 'any',
                },
            })
        );
        expect(deltas.map(delta => delta.content)).toMatchObject([
            [{ type: 'text', text: 'Checking ' }],
            [{ type: 'text', text: 'the weather.' }],
            [{ type: 'tool_call', input: '{"city"' }],
            [{ type: 'tool_call', input: ':"Beijing"}' }],
            [],
        ]);
        expect(completeResponse).toMatchObject({
            id: 'msg_stream',
            content: [
                {
                    type: 'text',
                    text: 'Checking the weather.',
                },
                {
                    type: 'tool_call',
                    id: 'toolu_stream',
                    name: 'get_weather',
                    input: '{"city":"Beijing"}',
                },
            ],
            usage: {
                inputTokens: 30,
                outputTokens: 18,
            },
        });
    });

    test('formats tool choice', () => {
        const model = createModel(false);

        expect(model['_formatToolChoice']()).toEqual({ type: 'auto' });
        expect(model['_formatToolChoice']('auto')).toEqual({ type: 'auto' });
        expect(model['_formatToolChoice']('none')).toEqual({ type: 'none' });
        expect(model['_formatToolChoice']('required')).toEqual({ type: 'any' });
        expect(model['_formatToolChoice']('get_weather')).toEqual({
            type: 'tool',
            name: 'get_weather',
        });
    });

    test('formats tool schemas', () => {
        const model = createModel(false);

        expect(model['_formatToolSchemas']([toolSchema])).toEqual([
            {
                name: 'get_weather',
                description: 'Get the weather for a city.',
                input_schema: toolSchema.function.parameters,
            },
        ]);
        expect(model['_formatToolSchemas']()).toEqual([]);
    });
});
