import { createMsg, getContentBlocks, getTextContent } from './message';

const TS = '2024-01-01T00:00:00.000Z';

describe('Message', () => {
    test('create message object', () => {
        const msg = createMsg({
            name: 'user',
            content: [
                { id: crypto.randomUUID(), type: 'text', text: 'Hello, world!', created_at: TS },
            ],
            role: 'user',
        });
        expect(msg.name).toBe('user');
        expect(msg.content).toEqual([
            { id: expect.any(String), type: 'text', text: 'Hello, world!', created_at: TS },
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
            { id: expect.any(String), type: 'text', text: 'Hello, world!', created_at: TS },
        ]);
    });

    test('obtain different content from message', () => {
        const msg = createMsg({
            name: 'assistant',
            role: 'assistant',
            content: [
                { id: crypto.randomUUID(), type: 'text', text: 'Hello', created_at: TS },
                { id: crypto.randomUUID(), type: 'thinking', thinking: '...', created_at: TS },
                { id: crypto.randomUUID(), type: 'text', text: 'World', created_at: TS },
                {
                    type: 'tool_call',
                    id: '1',
                    name: 'test',
                    input: "{ query: 'What is AI?' }",
                    state: 'pending',
                    created_at: TS,
                },
                {
                    type: 'tool_result',
                    id: '1',
                    name: 'test',
                    output: 'Artificial Intelligence',
                    state: 'success',
                    created_at: TS,
                },
            ],
        });

        expect(getTextContent(msg)).toBe('Hello\nWorld');

        expect(getContentBlocks(msg, 'text')).toStrictEqual([
            { id: expect.any(String), type: 'text', text: 'Hello', created_at: TS },
            { id: expect.any(String), type: 'text', text: 'World', created_at: TS },
        ]);
        expect(getContentBlocks(msg, 'thinking')).toStrictEqual([
            { id: expect.any(String), type: 'thinking', thinking: '...', created_at: TS },
        ]);
        expect(getContentBlocks(msg, 'tool_call')).toStrictEqual([
            {
                type: 'tool_call',
                id: '1',
                name: 'test',
                input: "{ query: 'What is AI?' }",
                state: 'pending',
                created_at: TS,
            },
        ]);
        expect(getContentBlocks(msg, 'tool_result')).toStrictEqual([
            {
                type: 'tool_result',
                id: '1',
                name: 'test',
                output: 'Artificial Intelligence',
                state: 'success',
                created_at: TS,
            },
        ]);
        expect(getContentBlocks(msg, 'data')).toStrictEqual([]);
    });
});
