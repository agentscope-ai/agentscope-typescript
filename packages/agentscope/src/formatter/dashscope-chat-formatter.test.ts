import { createMsg } from '../message';
import { DashScopeChatFormatter } from './dashscope-chat-formatter';

describe('DashScopeChatFormatter', () => {
    test('format textual messages', async () => {
        const msgs = [
            createMsg({
                name: 'system',
                content: [
                    { id: crypto.randomUUID(), type: 'text', text: 'You are a helpful assistant.' },
                ],
                role: 'system',
            }),
            createMsg({
                name: 'user',
                content: [{ id: crypto.randomUUID(), type: 'text', text: 'Hello, how are you?' }],
                role: 'user',
            }),
            createMsg({
                name: 'assistant',
                content: [{ id: crypto.randomUUID(), type: 'text', text: 'I am fine, thank you!' }],
                role: 'assistant',
            }),
        ];

        const formatter = new DashScopeChatFormatter();
        const res = await formatter.format({ msgs });
        expect(res).toEqual([
            {
                role: 'system',
                content: [{ text: 'You are a helpful assistant.' }],
            },
            {
                role: 'user',
                content: [{ text: 'Hello, how are you?' }],
            },
            {
                role: 'assistant',
                content: [{ text: 'I am fine, thank you!' }],
            },
        ]);
    });

    test('format tool messages', async () => {
        const msgs = [
            createMsg({
                name: 'system',
                content: [
                    { type: 'text', text: 'You are a helpful assistant.', id: crypto.randomUUID() },
                ],
                role: 'system',
            }),
            createMsg({
                name: 'user',
                content: [{ type: 'text', text: 'Please use the tool.', id: crypto.randomUUID() }],
                role: 'user',
            }),
            createMsg({
                name: 'assistant',
                content: [
                    {
                        type: 'tool_call',
                        id: '1',
                        name: 'google_search',
                        input: '{"query": "example1"}',
                    },
                    {
                        type: 'tool_call',
                        id: '2',
                        name: 'bing_search',
                        input: '{"query": "example2"}',
                    },
                    {
                        type: 'tool_result',
                        id: '1',
                        name: 'google_search',
                        output: 'Google search result for example1',
                        state: 'success',
                    },
                    {
                        type: 'tool_result',
                        id: '2',
                        name: 'bing_search',
                        output: 'Bing search result for example2',
                        state: 'success',
                    },
                ],
                role: 'assistant',
            }),
        ];

        const formatter = new DashScopeChatFormatter();

        const res = await formatter.format({ msgs });
        expect(res).toEqual([
            {
                role: 'system',
                content: [{ text: 'You are a helpful assistant.' }],
            },
            {
                role: 'user',
                content: [{ text: 'Please use the tool.' }],
            },
            {
                role: 'assistant',
                content: [],
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
                name: 'system',
                content: [
                    { id: crypto.randomUUID(), type: 'text', text: 'You are a helpful assistant.' },
                ],
                role: 'system',
            }),
            createMsg({
                name: 'user',
                content: [
                    { id: crypto.randomUUID(), type: 'text', text: 'Please see the image below.' },
                    {
                        id: crypto.randomUUID(),
                        type: 'data',
                        source: {
                            type: 'url',
                            url: 'https://example.com/image.png',
                            media_type: 'image/png',
                        },
                    },
                ],
                role: 'user',
            }),
            createMsg({
                name: 'assistant',
                content: [
                    {
                        id: crypto.randomUUID(),
                        type: 'text',
                        text: 'Here is the image you requested.',
                    },
                ],
                role: 'assistant',
            }),
            createMsg({
                name: 'user',
                content: [
                    {
                        id: crypto.randomUUID(),
                        type: 'data',
                        source: { type: 'base64', data: 'xxx', media_type: 'audio/mp3' },
                    },
                    {
                        id: crypto.randomUUID(),
                        type: 'data',
                        source: {
                            type: 'url',
                            url: 'file:///local/path/to/video.mp4',
                            media_type: 'video/mp4',
                        },
                    },
                    {
                        id: crypto.randomUUID(),
                        type: 'data',
                        source: {
                            type: 'url',
                            url: 'file:///C:/local/path/to/image.jpg',
                            media_type: 'image/jpg',
                        },
                    },
                ],
                role: 'user',
            }),
        ];

        const formatter = new DashScopeChatFormatter();

        const res = await formatter.format({ msgs });
        expect(res).toEqual([
            {
                role: 'system',
                content: [{ text: 'You are a helpful assistant.' }],
            },
            {
                role: 'user',
                content: [
                    { text: 'Please see the image below.' },
                    {
                        image: 'https://example.com/image.png',
                    },
                ],
            },
            {
                role: 'assistant',
                content: [{ text: 'Here is the image you requested.' }],
            },
            {
                role: 'user',
                content: [
                    {
                        audio: 'data:audio/mp3;base64,xxx',
                    },
                    {
                        video: 'file:///local/path/to/video.mp4',
                    },
                    {
                        image: 'file:///C:/local/path/to/image.jpg',
                    },
                ],
            },
        ]);
    });

    test('format multimodal tool results', async () => {
        // Mock Math.random to generate predictable IDs
        const mockRandom = jest.spyOn(Math, 'random');
        mockRandom.mockReturnValueOnce(0.123456789); // Will generate '4fzzzxjy'
        mockRandom.mockReturnValueOnce(0.456789012); // Will generate 'gfzy4slm'

        const msgs = [
            createMsg({
                name: 'user',
                content: [{ id: crypto.randomUUID(), type: 'text', text: 'Please use the tool.' }],
                role: 'user',
            }),
            createMsg({
                name: 'assistant',
                content: [
                    {
                        type: 'tool_call',
                        id: '1',
                        name: 'google_search',
                        input: '{\"query\": \"example1\"}',
                    },
                    {
                        type: 'tool_result',
                        id: '1',
                        name: 'google_search',
                        output: [
                            { type: 'text', text: 'content 1', id: crypto.randomUUID() },
                            {
                                id: crypto.randomUUID(),
                                type: 'data',
                                source: {
                                    type: 'url',
                                    url: 'https://example.com/image1.png',
                                    media_type: 'image/png',
                                },
                            },
                            { id: crypto.randomUUID(), type: 'text', text: 'content 2' },
                            {
                                id: crypto.randomUUID(),
                                type: 'data',
                                source: { type: 'base64', data: 'xxx', media_type: 'image/png' },
                            },
                            {
                                id: crypto.randomUUID(),
                                type: 'data',
                                source: { type: 'base64', data: 'yyy', media_type: 'audio/mp3' },
                            },
                            {
                                id: crypto.randomUUID(),
                                type: 'data',
                                source: {
                                    type: 'url',
                                    url: '/local/path/to/video1.mp4',
                                    media_type: 'video/mp4',
                                },
                            },
                        ],
                        state: 'success',
                    },
                ],
                role: 'assistant',
            }),
        ];

        const formatter = new DashScopeChatFormatter({ promoteMultimodalToolResult: true });

        const res = await formatter.format({ msgs });

        // Restore the mock
        mockRandom.mockRestore();

        expect(res).toEqual([
            {
                content: [
                    {
                        text: 'Please use the tool.',
                    },
                ],
                role: 'user',
            },
            {
                content: [],
                role: 'assistant',
                tool_calls: [
                    {
                        function: {
                            arguments: '{"query": "example1"}',
                            name: 'google_search',
                        },
                        id: '1',
                        type: 'function',
                    },
                ],
            },
            {
                content:
                    "content 1\n<system-info>One returned image can be found at: https://example.com/image1.png</system-info>\ncontent 2\n<system-info>One returned image is embedded with ID '4fzzzxjy' and will be attached within '<system-info></system-info>' tags later.</system-info>\n<system-info>One returned audio is embedded with ID 'gfzy4slm' and will be attached within '<system-info></system-info>' tags later.</system-info>\n<system-info>One returned video can be found at: /local/path/to/video1.mp4</system-info>",
                name: 'google_search',
                role: 'tool',
                tool_call_id: '1',
            },
            {
                content: [
                    {
                        text: "<system-info>The multimodal contents returned from the tool call are as follows:\n<image_data id='4fzzzxjy'>",
                    },
                    {
                        image: 'data:image/png;base64,xxx',
                    },
                    {
                        text: '</image_data>\n',
                    },
                    {
                        text: "<audio_data id='gfzy4slm'>",
                    },
                    {
                        audio: 'data:audio/mp3;base64,yyy',
                    },
                    {
                        text: '</audio_data>\n</system-info>',
                    },
                ],
                role: 'user',
            },
        ]);
    });
});
