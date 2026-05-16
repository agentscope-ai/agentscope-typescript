import { createMsg } from '../message';
import { OpenAIChatFormatter } from './openai-chat-formatter';

describe('OpenAIChatFormatter', () => {
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
                    },
                    {
                        type: 'tool_call',
                        id: '2',
                        name: 'bing_search',
                        input: '{"query": "example2"}',
                        state: 'pending',
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
                    {
                        id: crypto.randomUUID(),
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
        ]);
    });

    test('format tool result with promoted multimodal blocks', async () => {
        const mockRandom = jest.spyOn(Math, 'random');
        mockRandom.mockReturnValueOnce(0.123456789);

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
                    },
                    {
                        type: 'tool_result',
                        id: '1',
                        name: 'google_search',
                        output: [
                            { type: 'text', text: 'content 1', id: crypto.randomUUID() },
                            {
                                type: 'data',
                                source: { type: 'base64', data: 'img64', media_type: 'image/png' },
                                id: crypto.randomUUID(),
                            },
                        ],
                        state: 'success',
                    },
                ],
                role: 'assistant',
            }),
        ];

        const formatter = new OpenAIChatFormatter({
            promoteMultimodalToolResult: { image: true },
        });
        const res = await formatter.format({ msgs });
        mockRandom.mockRestore();

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
                content:
                    "content 1\n<system-info>One returned image is embedded with ID '4fzzzxjy' and will be attached within '<system-info></system-info>' tags later.</system-info>",
            },
            {
                role: 'user',
                name: 'user',
                content: [
                    {
                        type: 'text',
                        text: "<system-info>The multimodal contents returned from the tool call are as follows:\n<image_data id='4fzzzxjy'>",
                    },
                    {
                        type: 'image_url',
                        image_url: {
                            url: 'data:image/png;base64,img64',
                        },
                    },
                    { type: 'text', text: '</image_data>\n</system-info>' },
                ],
            },
        ]);
    });
});
