import {
    AssistantMsg,
    UserMsg,
    createMsg,
    getContentBlocks,
    getTextContent,
    hasContentBlocks,
} from './message';
import { parseMsg } from './schema';

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
        expect(getContentBlocks(msg, ['text', 'thinking'])).toHaveLength(3);
        expect(hasContentBlocks(msg)).toBe(true);
        expect(hasContentBlocks(msg, ['data', 'thinking'])).toBe(true);
        expect(hasContentBlocks(msg, 'data')).toBe(false);
    });

    test('fills the same message defaults and usage fields as Python', () => {
        expect(
            AssistantMsg({
                id: 'message-id',
                name: 'assistant',
                content: [],
                created_at: TS,
                usage: { input_tokens: 1, output_tokens: 2 },
            })
        ).toEqual({
            id: 'message-id',
            name: 'assistant',
            role: 'assistant',
            content: [],
            metadata: {},
            created_at: TS,
            usage: {
                input_tokens: 1,
                output_tokens: 2,
                cache_input_tokens: 0,
                cache_creation_input_tokens: 0,
            },
            finished_at: null,
            finished_reason: null,
            structured_output: null,
            error: null,
        });

        const user = UserMsg({ id: 'user-id', name: 'user', content: [], created_at: TS });
        expect(user.finished_at).toBe(TS);
    });

    test('validates message wire payloads at runtime', () => {
        expect(
            parseMsg({
                id: 'wire-id',
                name: 'user',
                role: 'user',
                content: [{ type: 'text', text: 'hello', id: 'block-id', created_at: TS }],
                created_at: TS,
            })
        ).toMatchObject({
            id: 'wire-id',
            finished_at: null,
            finished_reason: null,
            structured_output: null,
            error: null,
            usage: null,
        });
        expect(() =>
            parseMsg({
                name: 'user',
                role: 'user',
                content: [{ type: 'thinking', thinking: 'not allowed' }],
            })
        ).toThrow('User message can only contain');
    });
});
