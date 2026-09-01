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
import { XAIChatFormatter, XAIMultiAgentFormatter } from './xai-formatter';

describe('xAI formatters', () => {
    test('formats system, user text and images', async () => {
        const formatter = new XAIChatFormatter();
        const result = await formatter.format({
            msgs: [
                createMsg({ name: 'system', role: 'system', content: 'Be useful.' }),
                createMsg({
                    name: 'user',
                    role: 'user',
                    content: [
                        TextBlock({ text: 'Inspect' }),
                        DataBlock({
                            source: Base64Source({
                                media_type: 'image/png',
                                data: 'image-data',
                            }),
                        }),
                    ],
                }),
            ],
        });
        expect(result).toEqual([
            { role: 'system', args: ['Be useful.'] },
            {
                role: 'user',
                args: ['Inspect', { type: 'image', url: 'data:image/png;base64,image-data' }],
            },
        ]);
    });

    test('formats interleaved assistant tools and drops thinking', async () => {
        const formatter = new XAIChatFormatter();
        const result = await formatter.format({
            msgs: [
                createMsg({
                    name: 'assistant',
                    role: 'assistant',
                    content: [
                        ThinkingBlock({ thinking: 'private' }),
                        TextBlock({ text: 'Calling' }),
                        ToolCallBlock({ id: 'call-1', name: 'search', input: '{"q":"x"}' }),
                        ToolResultBlock({ id: 'call-1', name: 'search', output: 'found' }),
                        TextBlock({ text: 'Done' }),
                    ],
                }),
            ],
        });
        expect(result).toEqual([
            {
                role: 'assistant',
                content: [{ text: 'Calling' }],
                tool_calls: [
                    {
                        id: 'call-1',
                        type: 'client_side_tool',
                        function: { name: 'search', arguments: '{"q":"x"}' },
                    },
                ],
            },
            { role: 'tool', args: ['found'], tool_call_id: 'call-1' },
            { role: 'assistant', args: ['Done'] },
        ]);
    });

    test('flushes assistant content around multimodal hints', async () => {
        const formatter = new XAIChatFormatter();
        const result = await formatter.format({
            msgs: [
                createMsg({
                    name: 'assistant',
                    role: 'assistant',
                    content: [
                        TextBlock({ text: 'Before' }),
                        HintBlock({
                            hint: [
                                TextBlock({ text: 'Look' }),
                                DataBlock({
                                    source: Base64Source({
                                        media_type: 'image/jpeg',
                                        data: 'jpeg-data',
                                    }),
                                }),
                            ],
                        }),
                        TextBlock({ text: 'After' }),
                    ],
                }),
            ],
        });
        expect(result).toEqual([
            { role: 'assistant', args: ['Before'] },
            {
                role: 'user',
                args: ['Look', { type: 'image', url: 'data:image/jpeg;base64,jpeg-data' }],
            },
            { role: 'assistant', args: ['After'] },
        ]);
    });

    test('collapses multi-agent history and delegates tool sequences', async () => {
        const formatter = new XAIMultiAgentFormatter();
        const result = await formatter.format({
            msgs: [
                createMsg({ name: 'system', role: 'system', content: 'Coordinate.' }),
                createMsg({ name: 'alice', role: 'user', content: 'Question' }),
                createMsg({ name: 'bob', role: 'assistant', content: 'Reply' }),
            ],
        });
        expect(result).toEqual([
            { role: 'system', args: ['Coordinate.'] },
            {
                role: 'user',
                args: [
                    '# Conversation History\n' +
                        'The content between <history></history> tags contains your conversation history\n' +
                        '<history>\n' +
                        'alice: Question\n' +
                        'bob: Reply\n' +
                        '</history>',
                ],
            },
        ]);
    });
});
