/* eslint-disable jsdoc/require-jsdoc */

import {
    createEvent,
    EventType,
    ReplyFinishedReason,
    type AgentEvent,
} from '@agentscope-ai/agentscope/event';

import { AGUIProtocolMiddleware } from '../src/middleware';

const middleware = () => new AGUIProtocolMiddleware();

async function collect(chunks: Array<string | Uint8Array>): Promise<string> {
    async function* source() {
        yield* chunks;
    }
    const output: Uint8Array[] = [];
    for await (const chunk of middleware().convertStream(source())) output.push(chunk);
    return Buffer.concat(output).toString('utf8');
}

function event(value: Parameters<typeof createEvent>[0]): AgentEvent {
    return createEvent(value);
}

describe('protocol stream conversion', () => {
    test('converts raw JSON, LF/CRLF SSE frames, and real Response streams', async () => {
        const input = event({
            type: EventType.REPLY_START,
            session_id: 'sess_1',
            reply_id: 'reply_1',
            name: 'agent',
            role: 'assistant',
        });
        expect(JSON.parse(await collect([JSON.stringify(input)]))).toEqual({
            type: 'RUN_STARTED',
            threadId: 'sess_1',
            runId: 'reply_1',
        });
        for (const ending of ['\n\n', '\r\n\r\n']) {
            const output = await collect([`data: ${JSON.stringify(input)}${ending}`]);
            expect(output.endsWith(ending)).toBe(true);
            expect(JSON.parse(output.slice('data: '.length).trim())).toEqual({
                type: 'RUN_STARTED',
                threadId: 'sess_1',
                runId: 'reply_1',
            });
        }

        const response = await middleware().transformResponse(
            new Response(`data: ${JSON.stringify(input)}\n\n`, {
                status: 202,
                headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-test': 'yes' },
            })
        );
        expect(response.status).toBe(202);
        expect(response.headers.get('x-test')).toBe('yes');
        expect(JSON.parse((await response.text()).slice('data: '.length).trim()).type).toBe(
            'RUN_STARTED'
        );
    });

    test('passes heartbeats, malformed payloads, and non-SSE responses through', async () => {
        expect(await collect([':\n\n'])).toBe(':\n\n');
        expect(await collect(['data: not-json\n\n'])).toBe('data: not-json\n\n');
        const response = new Response('{"type":"REPLY_START"}', {
            headers: { 'content-type': 'application/json' },
        });
        expect(await middleware().transformResponse(response)).toBe(response);
    });
});

describe('AG-UI event conversion', () => {
    test('matches lifecycle, model, text, reasoning, and tool-call structures', () => {
        const converter = middleware();
        expect(
            converter.convertToProtocol(
                event({
                    type: EventType.REPLY_START,
                    session_id: 's',
                    reply_id: 'r',
                    name: 'a',
                    role: 'assistant',
                })
            )
        ).toEqual({ type: 'RUN_STARTED', threadId: 's', runId: 'r' });
        expect(
            converter.convertToProtocol(
                event({
                    type: EventType.REPLY_END,
                    session_id: 's',
                    reply_id: 'r',
                    finished_reason: ReplyFinishedReason.COMPLETED,
                })
            )
        ).toEqual({ type: 'RUN_FINISHED', threadId: 's', runId: 'r' });
        expect(
            converter.convertToProtocol(
                event({
                    type: EventType.REPLY_END,
                    session_id: 's',
                    reply_id: 'r',
                    finished_reason: ReplyFinishedReason.EXCEED_MAX_ITERS,
                })
            )
        ).toEqual({
            type: 'RUN_ERROR',
            message: 'The agent exceeded the maximum reasoning-acting iterations',
            code: 'exceed_max_iters',
        });
        expect(
            converter.convertToProtocol(
                event({ type: EventType.MODEL_CALL_START, reply_id: 'r', model_name: 'gpt-4' })
            )
        ).toEqual({ type: 'STEP_STARTED', stepName: 'gpt-4' });
        expect(
            converter.convertToProtocol(
                event({
                    type: EventType.MODEL_CALL_END,
                    reply_id: 'r',
                    input_tokens: 1,
                    output_tokens: 2,
                })
            )
        ).toEqual({ type: 'STEP_FINISHED', stepName: 'gpt-4' });
        expect(
            converter.convertToProtocol(
                event({ type: EventType.TEXT_BLOCK_START, reply_id: 'r', block_id: 'b' })
            )
        ).toEqual({ type: 'TEXT_MESSAGE_START', messageId: 'b', role: 'assistant' });
        expect(
            converter.convertToProtocol(
                event({
                    type: EventType.TEXT_BLOCK_DELTA,
                    reply_id: 'r',
                    block_id: 'b',
                    delta: 'hello',
                })
            )
        ).toEqual({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'b', delta: 'hello' });
        expect(
            converter.convertToProtocol(
                event({ type: EventType.TEXT_BLOCK_END, reply_id: 'r', block_id: 'b' })
            )
        ).toEqual({ type: 'TEXT_MESSAGE_END', messageId: 'b' });
        expect(
            converter.convertToProtocol(
                event({ type: EventType.THINKING_BLOCK_START, reply_id: 'r', block_id: 't' })
            )
        ).toEqual({ type: 'REASONING_MESSAGE_START', messageId: 't', role: 'reasoning' });
        expect(
            converter.convertToProtocol(
                event({
                    type: EventType.THINKING_BLOCK_DELTA,
                    reply_id: 'r',
                    block_id: 't',
                    delta: 'think',
                })
            )
        ).toEqual({ type: 'REASONING_MESSAGE_CONTENT', messageId: 't', delta: 'think' });
        expect(
            converter.convertToProtocol(
                event({ type: EventType.THINKING_BLOCK_END, reply_id: 'r', block_id: 't' })
            )
        ).toEqual({ type: 'REASONING_MESSAGE_END', messageId: 't' });
        expect(
            converter.convertToProtocol(
                event({
                    type: EventType.TOOL_CALL_START,
                    reply_id: 'r',
                    tool_call_id: 'tc',
                    tool_call_name: 'search',
                })
            )
        ).toEqual({
            type: 'TOOL_CALL_START',
            toolCallId: 'tc',
            toolCallName: 'search',
            parentMessageId: 'r',
        });
        expect(
            converter.convertToProtocol(
                event({
                    type: EventType.TOOL_CALL_DELTA,
                    reply_id: 'r',
                    tool_call_id: 'tc',
                    delta: '{}',
                })
            )
        ).toEqual({ type: 'TOOL_CALL_ARGS', toolCallId: 'tc', delta: '{}' });
        expect(
            converter.convertToProtocol(
                event({ type: EventType.TOOL_CALL_END, reply_id: 'r', tool_call_id: 'tc' })
            )
        ).toEqual({ type: 'TOOL_CALL_END', toolCallId: 'tc' });
    });

    test('buffers tool text and maps data, HITL, deprecated, and unknown events to CUSTOM', () => {
        const converter = middleware();
        const delta = event({
            type: EventType.TOOL_RESULT_TEXT_DELTA,
            reply_id: 'r',
            tool_call_id: 'tc',
            delta: 'partial ',
        });
        expect(converter.convertToProtocol(delta)).toMatchObject({
            type: 'CUSTOM',
            name: 'tool_result_text_delta',
            value: { delta: 'partial ' },
        });
        converter.convertToProtocol(
            event({
                type: EventType.TOOL_RESULT_TEXT_DELTA,
                reply_id: 'r',
                tool_call_id: 'tc',
                delta: 'result',
            })
        );
        expect(
            converter.convertToProtocol(
                event({
                    type: EventType.TOOL_RESULT_END,
                    reply_id: 'r',
                    tool_call_id: 'tc',
                    state: 'success',
                })
            )
        ).toEqual({
            type: 'TOOL_CALL_RESULT',
            toolCallId: 'tc',
            messageId: 'r',
            content: 'partial result',
        });
        expect(
            converter.convertToProtocol(
                event({
                    type: EventType.TOOL_RESULT_END,
                    reply_id: 'r',
                    tool_call_id: 'empty',
                    state: 'error',
                })
            )
        ).toEqual({
            type: 'TOOL_CALL_RESULT',
            toolCallId: 'empty',
            messageId: 'r',
            content: 'error',
        });

        const customs: Array<[AgentEvent, string]> = [
            [
                event({
                    type: EventType.TOOL_RESULT_START,
                    reply_id: 'r',
                    tool_call_id: 'tc',
                    tool_call_name: 'search',
                }),
                'tool_result_start',
            ],
            [
                event({
                    type: EventType.TOOL_RESULT_DATA_DELTA,
                    reply_id: 'r',
                    tool_call_id: 'tc',
                    block_id: 'b',
                    media_type: 'image/png',
                    data: 'base64',
                }),
                'tool_result_data_delta',
            ],
            [
                event({
                    type: EventType.DATA_BLOCK_START,
                    reply_id: 'r',
                    block_id: 'b',
                    media_type: 'image/png',
                }),
                'data_block_start',
            ],
            [
                event({
                    type: EventType.DATA_BLOCK_DELTA,
                    reply_id: 'r',
                    block_id: 'b',
                    data: 'x',
                    media_type: 'image/png',
                }),
                'data_block_delta',
            ],
            [
                event({ type: EventType.DATA_BLOCK_END, reply_id: 'r', block_id: 'b' }),
                'data_block_end',
            ],
            [
                event({ type: EventType.REQUIRE_USER_CONFIRM, reply_id: 'r', tool_calls: [] }),
                'require_user_confirm',
            ],
            [
                event({
                    type: EventType.REQUIRE_EXTERNAL_EXECUTION,
                    reply_id: 'r',
                    tool_calls: [],
                }),
                'require_external_execution',
            ],
            [
                event({ type: EventType.USER_CONFIRM_RESULT, reply_id: 'r', confirm_results: [] }),
                'user_confirm_result',
            ],
            [
                event({
                    type: EventType.EXTERNAL_EXECUTION_RESULT,
                    reply_id: 'r',
                    execution_results: [],
                }),
                'external_execution_result',
            ],
            [
                event({ type: EventType.EXCEED_MAX_ITERS, reply_id: 'r', name: 'a' }),
                'exceed_max_iters',
            ],
            [event({ type: EventType.USER_INTERRUPT, reply_id: 'r' }), 'unknown'],
        ];
        for (const [input, name] of customs) {
            expect(converter.convertToProtocol(input)).toMatchObject({
                type: 'CUSTOM',
                name,
                value: { type: input.type, id: input.id, created_at: input.created_at },
            });
        }
    });
});
