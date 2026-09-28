import { GeminiChatFormatter } from './gemini-chat-formatter';
import {
    createMsg,
    TextBlock,
    DataBlock,
    ThinkingBlock,
    HintBlock,
    ToolCallBlock,
    ToolResultBlock,
    parseContentBlock,
} from '../message';

const formatter = new GeminiChatFormatter();

describe('GeminiChatFormatter', () => {
    test('formats multimodal input and hints without changing the conversation', async () => {
        const msgs = [
            createMsg({
                name: 'user',
                role: 'user',
                content: [
                    TextBlock({ text: 'Describe' }),
                    DataBlock({
                        source: { type: 'base64', data: 'aGVsbG8=', media_type: 'image/png' },
                    }),
                    DataBlock({
                        source: {
                            type: 'url',
                            url: 'https://generativelanguage.googleapis.com/v1beta/files/sample',
                            media_type: 'video/mp4',
                        },
                    }),
                ],
            }),
            createMsg({
                name: 'agent',
                role: 'assistant',
                content: [HintBlock({ hint: 'A hint' })],
            }),
        ];
        const before = JSON.stringify(msgs);
        expect(await formatter.format({ msgs })).toEqual([
            {
                role: 'user',
                parts: [
                    { text: 'Describe' },
                    { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } },
                    {
                        fileData: {
                            mimeType: 'video/mp4',
                            fileUri:
                                'https://generativelanguage.googleapis.com/v1beta/files/sample',
                        },
                    },
                    { text: 'A hint' },
                ],
            },
        ]);
        expect(JSON.stringify(msgs)).toBe(before);
    });

    test('retains signed thought parts and omits unsigned summaries', async () => {
        const msg = createMsg({
            name: 'agent',
            role: 'assistant',
            content: [
                ThinkingBlock({ thinking: 'Unsigned summary' }),
                ThinkingBlock({ thinking: 'Signed', thought_signature: 'sig' }),
            ],
        });
        expect(await formatter.format({ msgs: [msg] })).toEqual([
            { role: 'model', parts: [{ text: 'Signed', thought: true, thoughtSignature: 'sig' }] },
        ]);
    });

    test('rejects non-object function arguments instead of sending an invalid request', async () => {
        const msg = createMsg({
            name: 'agent',
            role: 'assistant',
            content: [ToolCallBlock({ id: 'call', name: 'weather', input: '[]' })],
        });
        await expect(formatter.format({ msgs: [msg] })).rejects.toThrow('JSON object');
    });

    test('converts tool failures into native error responses', async () => {
        const msg = createMsg({
            name: 'tools',
            role: 'assistant',
            content: [
                ToolResultBlock({ id: 'call', name: 'weather', output: 'timeout', state: 'error' }),
            ],
        });
        expect(await formatter.format({ msgs: [msg] })).toEqual([
            {
                role: 'user',
                parts: [
                    {
                        functionResponse: {
                            name: 'weather',
                            id: 'call',
                            response: { error: 'timeout' },
                        },
                    },
                ],
            },
        ]);
    });

    test('preserves optional signatures on text, tool-call and data blocks during schema parsing', () => {
        for (const block of [
            TextBlock({ text: 'hello', thought_signature: 'text-sig' }),
            ToolCallBlock({
                id: 'call',
                name: 'weather',
                input: '{}',
                thought_signature: 'call-sig',
            }),
            DataBlock({
                source: { type: 'base64', data: 'aGVsbG8=', media_type: 'image/png' },
                thought_signature: 'data-sig',
            }),
        ])
            expect(parseContentBlock(JSON.parse(JSON.stringify(block)))).toEqual(block);
    });
});
