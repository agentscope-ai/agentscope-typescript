import { createMsg } from '../message';
import { OpenAIChatFormatter } from './openai-chat-formatter';

describe('OpenAIChatFormatter', () => {
    test('format textual messages', async () => {
        const msgs = [
            createMsg({
                name: 'system',
                content: [
                    {
                        id: crypto.randomUUID(),
                        created_at: '2024-01-01T00:00:00.000Z',
                        type: 'text',
                        text: 'You are a helpful assistant.',
                    },
                ],
                role: 'system',
            }),
            createMsg({
                name: 'user',
                content: [
                    {
                        id: crypto.randomUUID(),
                        created_at: '2024-01-01T00:00:00.000Z',
                        type: 'text',
                        text: 'Hello, how are you?',
                    },
                ],
                role: 'user',
            }),
            createMsg({
                name: 'assistant',
                content: [
                    {
                        id: crypto.randomUUID(),
                        created_at: '2024-01-01T00:00:00.000Z',
                        type: 'text',
                        text: 'I am fine, thank you!',
                    },
                ],
                role: 'assistant',
            }),
        ];

        const formatter = new OpenAIChatFormatter();
        const res = await formatter.format({ msgs });
        expect(res).toEqual([
            {
                role: 'system',
                name: 'system',
                content: [{ type: 'text', text: 'You are a helpful assistant.' }],
            },
            {
                role: 'user',
                name: 'user',
                content: [{ type: 'text', text: 'Hello, how are you?' }],
            },
            {
                role: 'assistant',
                name: 'assistant',
                content: [{ type: 'text', text: 'I am fine, thank you!' }],
            },
        ]);
    });

    test('format tool messages', async () => {
        const msgs = [
            createMsg({
                name: 'assistant',
                content: [
                    {
                        type: 'tool_call',
                        id: '1',
                        name: 'google_search',
                        input: '{"query": "example1"}',
                        state: 'pending',
                        created_at: '2024-01-01T00:00:00.000Z',
                    },
                    {
                        type: 'tool_call',
                        id: '2',
                        name: 'bing_search',
                        input: '{"query": "example2"}',
                        state: 'pending',
                        created_at: '2024-01-01T00:00:00.000Z',
                    },
                    {
                        type: 'tool_result',
                        id: '1',
                        name: 'google_search',
                        output: 'Google search result for example1',
                        state: 'success',
                        created_at: '2024-01-01T00:00:00.000Z',
                    },
                    {
                        type: 'tool_result',
                        id: '2',
                        name: 'bing_search',
                        output: 'Bing search result for example2',
                        state: 'success',
                        created_at: '2024-01-01T00:00:00.000Z',
                    },
                ],
                role: 'assistant',
            }),
        ];

        const formatter = new OpenAIChatFormatter();
        const res = await formatter.format({ msgs });
        expect(res).toEqual([
            {
                role: 'assistant',
                name: 'assistant',
                content: null,
                tool_calls: [
                    {
                        id: '1',
                        type: 'function',
                        function: {
                            name: 'google_search',
                            arguments: '{"query": "example1"}',
                        },
                    },
                    {
                        id: '2',
                        type: 'function',
                        function: {
                            name: 'bing_search',
                            arguments: '{"query": "example2"}',
                        },
                    },
                ],
            },
            {
                role: 'tool',
                tool_call_id: '1',
                name: 'google_search',
                content: 'Google search result for example1',
            },
            {
                role: 'tool',
                tool_call_id: '2',
                name: 'bing_search',
                content: 'Bing search result for example2',
            },
        ]);
    });

    test('format multimodal messages', async () => {
        const msgs = [
            createMsg({
                name: 'user',
                content: [
                    {
                        id: crypto.randomUUID(),
                        created_at: '2024-01-01T00:00:00.000Z',
                        type: 'text',
                        text: 'Please see the image below.',
                    },
                    {
                        id: crypto.randomUUID(),
                        created_at: '2024-01-01T00:00:00.000Z',
                        type: 'data',
                        source: {
                            type: 'url',
                            url: 'https://example.com/image.png',
                            media_type: 'image/png',
                        },
                    },
                    {
                        id: crypto.randomUUID(),
                        created_at: '2024-01-01T00:00:00.000Z',
                        type: 'data',
                        source: { type: 'base64', data: 'xxx', media_type: 'audio/mp3' },
                    },
                ],
                role: 'user',
            }),
            createMsg({
                name: 'assistant',
                content: [
                    {
                        id: crypto.randomUUID(),
                        created_at: '2024-01-01T00:00:00.000Z',
                        type: 'data',
                        source: {
                            type: 'base64',
                            data: 'assistant-audio',
                            media_type: 'audio/mp3',
                        },
                    },
                ],
                role: 'assistant',
            }),
        ];

        const formatter = new OpenAIChatFormatter();
        const res = await formatter.format({ msgs });
        expect(res).toEqual([
            {
                role: 'user',
                name: 'user',
                content: [
                    { type: 'text', text: 'Please see the image below.' },
                    {
                        type: 'image_url',
                        image_url: {
                            url: 'https://example.com/image.png',
                        },
                    },
                    {
                        type: 'input_audio',
                        input_audio: {
                            data: 'xxx',
                            format: 'mp3',
                        },
                    },
                ],
            },
            {
                role: 'assistant',
                name: 'assistant',
                content: [
                    {
                        type: 'input_audio',
                        input_audio: {
                            data: 'assistant-audio',
                            format: 'mp3',
                        },
                    },
                ],
            },
        ]);
    });

    test('format tool result with promoted multimodal blocks', async () => {
        const imageId = crypto.randomUUID();

        const msgs = [
            createMsg({
                name: 'assistant',
                content: [
                    {
                        type: 'tool_call',
                        id: '1',
                        name: 'google_search',
                        input: '{"query": "A"}',
                        state: 'pending',
                        created_at: '2024-01-01T00:00:00.000Z',
                    },
                    {
                        type: 'tool_result',
                        id: '1',
                        name: 'google_search',
                        output: [
                            {
                                type: 'text',
                                text: 'content 1',
                                id: crypto.randomUUID(),
                                created_at: '2024-01-01T00:00:00.000Z',
                            },
                            {
                                type: 'data',
                                source: { type: 'base64', data: 'img64', media_type: 'image/png' },
                                id: imageId,
                                created_at: '2024-01-01T00:00:00.000Z',
                            },
                        ],
                        state: 'success',
                        created_at: '2024-01-01T00:00:00.000Z',
                    },
                ],
                role: 'assistant',
            }),
        ];

        const formatter = new OpenAIChatFormatter({
            promoteMultimodalToolResult: { image: true },
        });
        const res = await formatter.format({ msgs });

        expect(res).toEqual([
            {
                role: 'assistant',
                name: 'assistant',
                content: null,
                tool_calls: [
                    {
                        id: '1',
                        type: 'function',
                        function: { name: 'google_search', arguments: '{"query": "A"}' },
                    },
                ],
            },
            {
                role: 'tool',
                tool_call_id: '1',
                name: 'google_search',
                content: `content 1\n<system-reminder>A(n) image file is returned and will be presented to you with the identifier [${imageId}].</system-reminder>`,
            },
            {
                role: 'user',
                name: 'system-reminder',
                content: [
                    {
                        type: 'text',
                        text: '<system-reminder>The multimodal data and their identifiers are listed as follows:',
                    },
                    {
                        type: 'text',
                        text: `- ${imageId} (image file): `,
                    },
                    {
                        type: 'image_url',
                        image_url: {
                            url: 'data:image/png;base64,img64',
                        },
                    },
                    { type: 'text', text: '</system-reminder>' },
                ],
            },
        ]);
    });
});
