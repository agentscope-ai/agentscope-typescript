import { createMsg } from '../message';
import { AnthropicChatFormatter } from './anthropic-chat-formatter';

describe('AnthropicChatFormatter', () => {
    const formatter = new AnthropicChatFormatter();

    test('formats assistant tool calls and tool results', async () => {
        const messages = await formatter.format({
            msgs: [
                createMsg({
                    name: 'assistant',
                    role: 'assistant',
                    content: [
                        {
                            type: 'text',
                            id: 'text-1',
                            text: 'Let me check.',
                            created_at: '2026-01-01T00:00:00.000Z',
                        },
                        {
                            type: 'tool_call',
                            id: 'toolu_1',
                            name: 'get_weather',
                            input: '{"city":"Beijing"}',
                            state: 'pending',
                            created_at: '2026-01-01T00:00:00.000Z',
                        },
                        {
                            type: 'tool_result',
                            id: 'toolu_1',
                            name: 'get_weather',
                            output: 'Sunny',
                            state: 'success',
                            created_at: '2026-01-01T00:00:01.000Z',
                        },
                    ],
                }),
            ],
        });

        expect(messages).toEqual([
            {
                role: 'assistant',
                content: [
                    {
                        type: 'text',
                        text: 'Let me check.',
                    },
                    {
                        type: 'tool_use',
                        id: 'toolu_1',
                        name: 'get_weather',
                        input: {
                            city: 'Beijing',
                        },
                    },
                ],
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'toolu_1',
                        content: 'Sunny',
                        is_error: false,
                    },
                ],
            },
        ]);
    });

    test('marks failed tool results as errors', async () => {
        const messages = await formatter.format({
            msgs: [
                createMsg({
                    name: 'assistant',
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_result',
                            id: 'toolu_2',
                            name: 'get_weather',
                            output: 'Service unavailable',
                            state: 'error',
                            created_at: '2026-01-01T00:00:00.000Z',
                        },
                    ],
                }),
            ],
        });

        expect(messages).toEqual([
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'toolu_2',
                        content: 'Service unavailable',
                        is_error: true,
                    },
                ],
            },
        ]);
    });

    test('formats URL and base64 images', async () => {
        const messages = await formatter.format({
            msgs: [
                createMsg({
                    name: 'user',
                    role: 'user',
                    content: [
                        {
                            type: 'data',
                            id: 'image-url',
                            source: {
                                type: 'url',
                                url: 'https://example.com/image.png',
                                media_type: 'image/png',
                            },
                            created_at: '2026-01-01T00:00:00.000Z',
                        },
                        {
                            type: 'data',
                            id: 'image-data',
                            source: {
                                type: 'base64',
                                data: 'aW1hZ2U=',
                                media_type: 'image/jpeg',
                            },
                            created_at: '2026-01-01T00:00:00.000Z',
                        },
                    ],
                }),
            ],
        });

        expect(messages).toEqual([
            {
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: {
                            type: 'url',
                            url: 'https://example.com/image.png',
                        },
                    },
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            data: 'aW1hZ2U=',
                            media_type: 'image/jpeg',
                        },
                    },
                ],
            },
        ]);
    });

    test('rejects invalid serialized tool input', async () => {
        await expect(
            formatter.format({
                msgs: [
                    createMsg({
                        name: 'assistant',
                        role: 'assistant',
                        content: [
                            {
                                type: 'tool_call',
                                id: 'toolu_invalid',
                                name: 'get_weather',
                                input: '{invalid',
                                state: 'pending',
                                created_at: '2026-01-01T00:00:00.000Z',
                            },
                        ],
                    }),
                ],
            })
        ).rejects.toThrow('Invalid JSON input for Anthropic tool call');
    });
});
