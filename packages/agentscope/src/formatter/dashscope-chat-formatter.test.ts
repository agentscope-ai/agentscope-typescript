import {
    Base64Source,
    DataBlock,
    HintBlock,
    TextBlock,
    ThinkingBlock,
    ToolCallBlock,
    ToolResultBlock,
    createMsg,
} from '../message';
import { DashScopeChatFormatter, DashScopeMultiAgentFormatter } from './dashscope-chat-formatter';

describe('DashScope formatters', () => {
    test('formats text, preserved thinking, hints and tools', async () => {
        const formatter = new DashScopeChatFormatter({
            inputTypes: ['text/plain', 'application/x-thinking'],
        });
        const msgs = [
            createMsg({
                name: 'assistant',
                role: 'assistant',
                content: [
                    ThinkingBlock({ thinking: 'reason' }),
                    TextBlock({ text: 'answer' }),
                    HintBlock({ hint: 'continue' }),
                    ToolCallBlock({ id: 'call-1', name: 'search', input: '{"q":"x"}' }),
                    ToolResultBlock({ id: 'call-1', name: 'search', output: 'done' }),
                ],
            }),
        ];

        await expect(formatter.format({ msgs })).resolves.toEqual([
            {
                role: 'assistant',
                content: [{ type: 'text', text: 'answer' }],
                reasoning_content: 'reason',
            },
            { role: 'user', content: [{ type: 'text', text: 'continue' }] },
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    {
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'search', arguments: '{"q":"x"}' },
                    },
                ],
            },
            {
                role: 'tool',
                tool_call_id: 'call-1',
                content: 'done',
                name: 'search',
            },
        ]);
    });

    test('formats all supported media and promotes tool-result media by stable id', async () => {
        const image = DataBlock({
            id: 'image-1',
            source: Base64Source({ media_type: 'image/png', data: 'image-data' }),
        });
        const audio = DataBlock({
            id: 'audio-1',
            source: Base64Source({ media_type: 'audio/mpeg', data: 'audio-data' }),
        });
        const formatter = new DashScopeChatFormatter();
        const msgs = [
            createMsg({
                name: 'assistant',
                role: 'assistant',
                content: [
                    ToolResultBlock({
                        id: 'call-1',
                        name: 'media',
                        output: [TextBlock({ text: 'files' }), image, audio],
                    }),
                ],
            }),
        ];

        await expect(formatter.format({ msgs })).resolves.toEqual([
            {
                role: 'tool',
                tool_call_id: 'call-1',
                name: 'media',
                content:
                    'files\n' +
                    '<system-reminder>A(n) image file is returned and will be presented to you with the identifier [image-1].</system-reminder>\n' +
                    '<system-reminder>A(n) audio file is returned and will be presented to you with the identifier [audio-1].</system-reminder>',
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: '<system-reminder>The multimodal data and their identifiers are listed as follows:',
                    },
                    { type: 'text', text: '- image-1 (image file): ' },
                    {
                        type: 'image_url',
                        image_url: { url: 'data:image/png;base64,image-data' },
                    },
                    { type: 'text', text: '- audio-1 (audio file): ' },
                    {
                        type: 'input_audio',
                        input_audio: { data: 'data:;base64,audio-data', format: 'mp3' },
                    },
                    { type: 'text', text: '</system-reminder>' },
                ],
            },
        ]);
    });

    test('collapses non-tool multi-agent history', async () => {
        const formatter = new DashScopeMultiAgentFormatter();
        const msgs = [
            createMsg({ name: 'system', role: 'system', content: 'Be useful.' }),
            createMsg({ name: 'alice', role: 'user', content: 'Question' }),
            createMsg({ name: 'bob', role: 'assistant', content: 'Answer' }),
        ];
        const result = await formatter.format({ msgs });
        expect(result).toEqual([
            { role: 'system', content: 'Be useful.' },
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text:
                            '# Conversation History\n' +
                            'The content between <history></history> tags contains your conversation history\n' +
                            '<history>\n' +
                            'alice: Question\n' +
                            'bob: Answer\n' +
                            '</history>',
                    },
                ],
            },
        ]);
    });
});
