import { createMsg, getContentBlocks, getTextContent } from './message';

describe('Message', () => {
    test('create message object', () => {
        const msg = createMsg({
            name: 'user',
            content: [{ id: crypto.randomUUID(), type: 'text', text: 'Hello, world!' }],
            role: 'user',
        });
        expect(msg.name).toBe('user');
        expect(msg.content).toEqual([
            { id: expect.any(String), type: 'text', text: 'Hello, world!' },
        ]);
        expect(msg.role).toBe('user');
        expect(msg.metadata).toEqual({});
        expect(msg.created_at).toBeDefined();
        expect(msg.id).toBeDefined();
        expect(getTextContent(msg)).toBe('Hello, world!');

        // getContentBlocks wraps a string content into a single TextBlock
        const blocks = getContentBlocks(msg);
        expect(blocks.length).toBe(1);
        expect(blocks).toStrictEqual([
            { id: expect.any(String), type: 'text', text: 'Hello, world!' },
        ]);
    });

    test('obtain different content from message', () => {
        const msg = createMsg({
            name: 'user',
            role: 'user',
            content: [
                { id: crypto.randomUUID(), type: 'text', text: 'Hello' },
                { id: crypto.randomUUID(), type: 'thinking', thinking: '...' },
                { id: crypto.randomUUID(), type: 'text', text: 'World' },
                {
                    type: 'tool_call',
                    id: '1',
                    name: 'test',
                    input: "{ query: 'What is AI?' }",
                    state: 'pending',
                },
                {
                    type: 'tool_result',
                    id: '1',
                    name: 'test',
                    output: 'Artificial Intelligence',
                    state: 'success',
                },
            ],
        });

        expect(getTextContent(msg)).toBe('Hello\nWorld');

        expect(getContentBlocks(msg, 'text')).toStrictEqual([
            { id: expect.any(String), type: 'text', text: 'Hello' },
            { id: expect.any(String), type: 'text', text: 'World' },
        ]);
        expect(getContentBlocks(msg, 'thinking')).toStrictEqual([
            { id: expect.any(String), type: 'thinking', thinking: '...' },
        ]);
        expect(getContentBlocks(msg, 'tool_call')).toStrictEqual([
            {
                type: 'tool_call',
                id: '1',
                name: 'test',
                input: "{ query: 'What is AI?' }",
                state: 'pending',
            },
        ]);
        expect(getContentBlocks(msg, 'tool_result')).toStrictEqual([
            {
                type: 'tool_result',
                id: '1',
                name: 'test',
                output: 'Artificial Intelligence',
                state: 'success',
            },
        ]);
        expect(getContentBlocks(msg, 'data')).toStrictEqual([]);
    });
});
