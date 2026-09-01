import { EventType, ReplyFinishedReason, createEvent, parseAgentEvent } from './index';

import { setIdFactory, setTimestampFactory } from '../_utils/common';
import { FinishedReason } from '../model/response';

const TIMESTAMP = '2026-09-01T12:34:56.123456';

describe('Python-compatible event contracts', () => {
    beforeEach(() => {
        setIdFactory(() => 'event-id');
        setTimestampFactory(() => TIMESTAMP);
    });

    afterEach(() => {
        setIdFactory(() => crypto.randomUUID().replaceAll('-', ''));
        setTimestampFactory(() => new Date().toISOString());
    });

    test('creates ReplyStartEvent with every Python default', () => {
        expect(
            createEvent({
                type: EventType.REPLY_START,
                session_id: 'session',
                reply_id: 'reply',
                name: 'Friday',
            })
        ).toEqual({
            type: 'REPLY_START',
            id: 'event-id',
            created_at: TIMESTAMP,
            metadata: {},
            session_id: 'session',
            reply_id: 'reply',
            name: 'Friday',
            role: 'assistant',
        });
    });

    test('fills reply, model, tool result, and custom defaults', () => {
        expect(
            createEvent({
                type: EventType.REPLY_END,
                session_id: 'session',
                reply_id: 'reply',
            })
        ).toMatchObject({
            finished_reason: ReplyFinishedReason.COMPLETED,
            error: null,
        });
        expect(
            createEvent({
                type: EventType.MODEL_CALL_END,
                reply_id: 'reply',
                input_tokens: 1,
                output_tokens: 2,
            })
        ).toMatchObject({
            cache_input_tokens: 0,
            cache_creation_input_tokens: 0,
            finished_reason: FinishedReason.COMPLETED,
        });
        expect(
            createEvent({
                type: EventType.TOOL_RESULT_END,
                reply_id: 'reply',
                tool_call_id: 'call',
                state: 'success',
            })
        ).toMatchObject({ metadata: {} });
        expect(createEvent({ type: EventType.CUSTOM, name: 'state_updated' })).toMatchObject({
            value: {},
        });
    });

    test('requires exactly one ToolResultDataDeltaEvent source', () => {
        const common = {
            type: EventType.TOOL_RESULT_DATA_DELTA,
            reply_id: 'reply',
            tool_call_id: 'call',
            media_type: 'image/png',
        } as const;

        expect(createEvent({ ...common, data: 'iVBOR==' })).toMatchObject({
            block_id: 'event-id',
            data: 'iVBOR==',
            url: null,
        });
        expect(createEvent({ ...common, url: 'https://example.com/image.png' })).toMatchObject({
            block_id: 'event-id',
            data: null,
            url: 'https://example.com/image.png',
        });
        expect(() => createEvent(common)).toThrow('Exactly one of `data` or `url`');
        expect(() =>
            createEvent({ ...common, data: 'iVBOR==', url: 'https://example.com/image.png' })
        ).toThrow('Exactly one of `data` or `url`');
    });

    test('supports the Python USER_INTERRUPT wire event', () => {
        expect(
            createEvent({
                type: EventType.USER_INTERRUPT,
                reply_id: 'reply',
            })
        ).toEqual({
            type: 'USER_INTERRUPT',
            id: 'event-id',
            created_at: TIMESTAMP,
            metadata: {},
            reply_id: 'reply',
        });
    });

    test('parses and validates untrusted event wire payloads', () => {
        expect(
            parseAgentEvent({
                type: 'REPLY_START',
                session_id: 'session',
                reply_id: 'reply',
                name: 'Friday',
            })
        ).toMatchObject({
            id: 'event-id',
            created_at: TIMESTAMP,
            metadata: {},
            role: 'assistant',
        });
        expect(() =>
            parseAgentEvent({
                type: 'TEXT_BLOCK_DELTA',
                reply_id: 'reply',
                block_id: 'block',
            })
        ).toThrow();
        expect(() => parseAgentEvent({ type: 'NOT_AN_EVENT' })).toThrow();
    });

    test('has a validated wire contract for every EventType', () => {
        const toolCall = {
            type: 'tool_call',
            id: 'call',
            name: 'read',
            input: '{}',
        };
        const toolResult = {
            type: 'tool_result',
            id: 'call',
            name: 'read',
            output: 'ok',
            state: 'success',
        };
        const payloads: Record<EventType, Record<string, unknown>> = {
            REPLY_START: { session_id: 'session', reply_id: 'reply', name: 'agent' },
            REPLY_END: { session_id: 'session', reply_id: 'reply' },
            MODEL_CALL_START: { reply_id: 'reply', model_name: 'model' },
            MODEL_CALL_END: { reply_id: 'reply', input_tokens: 1, output_tokens: 2 },
            TEXT_BLOCK_START: { reply_id: 'reply', block_id: 'block' },
            TEXT_BLOCK_DELTA: { reply_id: 'reply', block_id: 'block', delta: 'x' },
            TEXT_BLOCK_END: { reply_id: 'reply', block_id: 'block' },
            DATA_BLOCK_START: { reply_id: 'reply', block_id: 'block', media_type: 'image/png' },
            DATA_BLOCK_DELTA: {
                reply_id: 'reply',
                block_id: 'block',
                data: 'eA==',
                media_type: 'image/png',
            },
            DATA_BLOCK_END: { reply_id: 'reply', block_id: 'block' },
            THINKING_BLOCK_START: { reply_id: 'reply', block_id: 'block' },
            THINKING_BLOCK_DELTA: { reply_id: 'reply', block_id: 'block', delta: 'x' },
            THINKING_BLOCK_END: { reply_id: 'reply', block_id: 'block' },
            HINT_BLOCK: { reply_id: 'reply', block_id: 'block', hint: 'hint' },
            TOOL_CALL_START: {
                reply_id: 'reply',
                tool_call_id: 'call',
                tool_call_name: 'read',
            },
            TOOL_CALL_DELTA: { reply_id: 'reply', tool_call_id: 'call', delta: '{}' },
            TOOL_CALL_END: { reply_id: 'reply', tool_call_id: 'call' },
            TOOL_RESULT_START: {
                reply_id: 'reply',
                tool_call_id: 'call',
                tool_call_name: 'read',
            },
            TOOL_RESULT_TEXT_DELTA: {
                reply_id: 'reply',
                tool_call_id: 'call',
                delta: 'ok',
            },
            TOOL_RESULT_DATA_DELTA: {
                reply_id: 'reply',
                tool_call_id: 'call',
                media_type: 'image/png',
                data: 'eA==',
            },
            TOOL_RESULT_END: { reply_id: 'reply', tool_call_id: 'call', state: 'success' },
            EXCEED_MAX_ITERS: { reply_id: 'reply', name: 'agent' },
            REQUIRE_USER_CONFIRM: { reply_id: 'reply', tool_calls: [toolCall] },
            REQUIRE_EXTERNAL_EXECUTION: { reply_id: 'reply', tool_calls: [toolCall] },
            USER_CONFIRM_RESULT: {
                reply_id: 'reply',
                confirm_results: [{ confirmed: true, tool_call: toolCall }],
            },
            USER_INTERRUPT: { reply_id: 'reply' },
            EXTERNAL_EXECUTION_RESULT: {
                reply_id: 'reply',
                execution_results: [toolResult],
            },
            CUSTOM: { name: 'state_updated' },
        };

        expect(Object.keys(payloads)).toHaveLength(Object.keys(EventType).length);
        for (const type of Object.values(EventType)) {
            expect(parseAgentEvent({ type, ...payloads[type] }).type).toBe(type);
        }
    });
});
