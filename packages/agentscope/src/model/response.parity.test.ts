import { Base64Source, DataBlock, TextBlock } from '../message';
import { ChatResponse, FinishedReason, StreamAccumulator, StructuredResponse } from './response';
import { ChatUsage } from './usage';

describe('model response parity', () => {
    test('serializes Python-compatible response and usage wire fields', () => {
        const usage = new ChatUsage({
            inputTokens: 3,
            outputTokens: 4,
            time: 0.25,
            cacheCreationInputTokens: 1,
            cacheInputTokens: 2,
        });
        const response = new ChatResponse({
            id: 'response-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            content: [
                TextBlock({
                    id: 'text-1',
                    text: 'hello',
                    created_at: '2026-01-01T00:00:00.000Z',
                }),
            ],
            isLast: true,
            usage,
        });
        expect(JSON.parse(JSON.stringify(response))).toEqual({
            content: [
                {
                    type: 'text',
                    text: 'hello',
                    id: 'text-1',
                    created_at: '2026-01-01T00:00:00.000Z',
                    finished_at: null,
                },
            ],
            is_last: true,
            id: 'response-1',
            created_at: '2026-01-01T00:00:00.000Z',
            type: 'chat_response',
            usage: {
                input_tokens: 3,
                output_tokens: 4,
                time: 0.25,
                cache_creation_input_tokens: 1,
                cache_input_tokens: 2,
                type: 'chat',
                metadata: null,
            },
            finished_reason: 'completed',
            metadata: {},
        });

        const structured = new StructuredResponse({
            id: 'structured-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            content: { answer: 42 },
            usage,
        });
        expect(JSON.parse(JSON.stringify(structured))).toEqual({
            content: { answer: 42 },
            id: 'structured-1',
            created_at: '2026-01-01T00:00:00.000Z',
            type: 'structured_response',
            usage: JSON.parse(JSON.stringify(usage)),
            metadata: {},
            finished_reason: 'completed',
        });
    });

    test('appends text, thinking extras, tool calls, and raw audio bytes', () => {
        const response = new ChatResponse({ content: [], isLast: true });
        response
            .appendText('hello', 'text')
            .appendText(' world', 'text')
            .appendThinking('why ', 'thinking')
            .appendThinking('not', 'thinking', { signature: 'signed' })
            .appendToolCall('tool', 'search', '{"q"')
            .appendToolCall('tool', 'search', ':"x"}', { call_id: 'call-1' })
            .appendDataBlock('audio', Uint8Array.from([1]), 'audio/pcm', 'voice')
            .appendDataBlock('audio', Uint8Array.from([2, 3]), 'audio/pcm');

        expect(response.content).toEqual([
            expect.objectContaining({ id: 'text', type: 'text', text: 'hello world' }),
            expect.objectContaining({
                id: 'thinking',
                type: 'thinking',
                thinking: 'why not',
                signature: 'signed',
            }),
            expect.objectContaining({
                id: 'tool',
                type: 'tool_call',
                name: 'search',
                input: '{"q":"x"}',
                call_id: 'call-1',
            }),
            expect.objectContaining({
                id: 'audio',
                type: 'data',
                name: 'voice',
                source: { type: 'base64', media_type: 'audio/pcm', data: 'AQID' },
            }),
        ]);
    });

    test('merges response blocks by id and lets latest usage win', () => {
        const firstUsage = new ChatUsage({ inputTokens: 1, outputTokens: 1, time: 0.1 });
        const latestUsage = new ChatUsage({ inputTokens: 2, outputTokens: 3, time: 0.2 });
        const accumulator = new ChatResponse({ content: [], isLast: true, usage: firstUsage });
        accumulator.appendText('a', 'text').appendThinking('b', 'thinking');
        const delta = new ChatResponse({ content: [], isLast: false, usage: latestUsage });
        delta.appendText('c', 'text').appendThinking('d', 'thinking', { signature: 'sig' });
        delta.appendToolCall('tool', 'fn', '{}');
        accumulator.appendChatResponse(delta);

        expect(accumulator.content).toEqual([
            expect.objectContaining({ id: 'text', text: 'ac' }),
            expect.objectContaining({ id: 'thinking', thinking: 'bd', signature: 'sig' }),
            expect.objectContaining({ id: 'tool', name: 'fn', input: '{}' }),
        ]);
        expect(accumulator.usage).toBe(latestUsage);
    });

    test('stream accumulator joins mixed deltas in linear fragment lists', () => {
        const accumulator = new StreamAccumulator();
        const first = new ChatResponse({ content: [], isLast: false, id: 'chunk-1' });
        first.appendText('hello ', 'text').appendToolCall('tool', 'write', '{"x"');
        const second = new ChatResponse({ content: [], isLast: false, id: 'chunk-2' });
        second
            .appendText('world', 'text')
            .appendToolCall('tool', 'write', ':1}')
            .appendThinking('done', 'thinking', { signature: 'sig' });
        accumulator.appendChatResponse(first).appendChatResponse(second);
        accumulator.id = second.id;
        accumulator.finishedReason = FinishedReason.INTERRUPTED;

        expect(accumulator.build()).toMatchObject({
            id: 'chunk-2',
            isLast: true,
            finishedReason: FinishedReason.INTERRUPTED,
            content: [
                expect.objectContaining({ id: 'text', text: 'hello world' }),
                expect.objectContaining({ id: 'tool', input: '{"x":1}' }),
                expect.objectContaining({ id: 'thinking', thinking: 'done', signature: 'sig' }),
            ],
        });
    });

    test('accumulates audio bytes but uses latest non-audio asset and media type', () => {
        const accumulator = new StreamAccumulator();
        accumulator.appendChatResponse(
            new ChatResponse({
                isLast: false,
                content: [
                    DataBlock({
                        id: 'audio',
                        source: Base64Source({ data: 'AQ==', media_type: 'audio/pcm' }),
                    }),
                    DataBlock({
                        id: 'image',
                        source: Base64Source({ data: 'b2xk', media_type: 'image/png' }),
                    }),
                ],
            })
        );
        accumulator.appendChatResponse(
            new ChatResponse({
                isLast: false,
                content: [
                    DataBlock({
                        id: 'audio',
                        source: Base64Source({ data: 'AgM=', media_type: 'audio/pcm' }),
                    }),
                    DataBlock({
                        id: 'image',
                        source: Base64Source({ data: 'bmV3', media_type: 'image/png' }),
                    }),
                ],
            })
        );

        expect(accumulator.build().content).toEqual([
            expect.objectContaining({
                id: 'audio',
                source: { type: 'base64', data: 'AQID', media_type: 'audio/pcm' },
            }),
            expect.objectContaining({
                id: 'image',
                source: { type: 'base64', data: 'bmV3', media_type: 'image/png' },
            }),
        ]);
    });
});
