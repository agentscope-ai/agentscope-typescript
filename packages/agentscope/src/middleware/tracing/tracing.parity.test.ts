/* eslint-disable jsdoc/require-jsdoc */

import type { Span, Tracer } from '@opentelemetry/api';

import { SpanAttributes } from './attributes';
import { convertBlockToPart } from './converter';
import { getAgentMessages, getLLMResponseAttributes, getToolDefinitions } from './extractor';
import { TracingMiddleware } from './tracing';
import { Agent } from '../../agent';
import { QueueModel, TestTool, response } from '../../agent/test-helpers';
import { createEvent, EventType } from '../../event';
import type { ExternalExecutionResultEvent } from '../../event';
import {
    Base64Source,
    DataBlock,
    TextBlock,
    ThinkingBlock,
    ToolCallBlock,
    ToolResultBlock,
    UserMsg,
} from '../../message';
import { ChatUsage } from '../../model';
import { Toolkit } from '../../tool';

class FakeSpan {
    attributes: Record<string, unknown>;
    ended = false;
    errors: unknown[] = [];

    constructor(
        readonly name: string,
        attributes: Record<string, unknown> = {}
    ) {
        this.attributes = { ...attributes };
    }

    setAttribute(key: string, value: unknown): this {
        this.attributes[key] = value;
        return this;
    }

    setAttributes(values: Record<string, unknown>): this {
        Object.assign(this.attributes, values);
        return this;
    }

    setStatus(): this {
        return this;
    }

    recordException(error: unknown): void {
        this.errors.push(error);
    }

    end(): void {
        this.ended = true;
    }

    spanContext() {
        return { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 };
    }

    isRecording(): boolean {
        return true;
    }

    addEvent(): this {
        return this;
    }

    addLink(): this {
        return this;
    }

    addLinks(): this {
        return this;
    }

    updateName(): this {
        return this;
    }
}

class FakeTracer {
    spans: FakeSpan[] = [];

    startSpan(name: string, options?: { attributes?: Record<string, unknown> }): Span {
        const span = new FakeSpan(name, options?.attributes);
        this.spans.push(span);
        return span as unknown as Span;
    }
}

describe('Tracing middleware Python parity', () => {
    test('content blocks convert to OTel GenAI parts', () => {
        expect(convertBlockToPart(TextBlock({ text: 'hello' }))).toEqual({
            type: 'text',
            content: 'hello',
        });
        expect(convertBlockToPart(ThinkingBlock({ thinking: 'reason' }))).toEqual({
            type: 'reasoning',
            content: 'reason',
        });
        expect(
            convertBlockToPart(ToolCallBlock({ id: 'id', name: 'tool', input: '{"x":1}' }))
        ).toEqual({ type: 'tool_call', id: 'id', name: 'tool', arguments: { x: 1 } });
        expect(
            convertBlockToPart(
                DataBlock({
                    source: Base64Source({ data: 'YQ==', media_type: 'image/png' }),
                })
            )
        ).toMatchObject({ type: 'blob', modality: 'image', media_type: 'image/png' });
    });

    test('message and tool definitions use exact serialized GenAI structure', () => {
        expect(getAgentMessages(UserMsg({ name: 'user', content: 'hello' }))).toMatchObject([
            {
                role: 'user',
                name: 'user',
                parts: [{ type: 'text', content: 'hello' }],
                finish_reason: 'stop',
            },
        ]);
        expect(
            JSON.parse(
                getToolDefinitions(
                    [
                        {
                            type: 'function',
                            function: {
                                name: 'search',
                                description: 'Search',
                                parameters: { type: 'object', properties: {} },
                            },
                        },
                    ],
                    null
                )!
            )
        ).toEqual([
            {
                type: 'function',
                name: 'search',
                description: 'Search',
                parameters: { type: 'object', properties: {} },
            },
        ]);
    });

    test('LLM response attributes include finish reason and cache usage', () => {
        const attributes = getLLMResponseAttributes(
            response([TextBlock({ text: 'done' })], {
                usage: new ChatUsage({
                    inputTokens: 10,
                    outputTokens: 4,
                    cacheInputTokens: 3,
                    cacheCreationInputTokens: 2,
                    time: 0,
                }),
            })
        );
        expect(attributes).toMatchObject({
            [SpanAttributes.GEN_AI_USAGE_INPUT_TOKENS]: 10,
            [SpanAttributes.GEN_AI_USAGE_OUTPUT_TOKENS]: 4,
            [SpanAttributes.AGENTSCOPE_CACHE_INPUT_TOKENS]: 3,
            [SpanAttributes.AGENTSCOPE_CACHE_CREATION_INPUT_TOKENS]: 2,
            [SpanAttributes.GEN_AI_RESPONSE_FINISH_REASONS]: '["stop"]',
        });
    });

    test('reply and chat spans share conversation id and record response data', async () => {
        const tracer = new FakeTracer();
        const model = new QueueModel();
        model.responses.push(response([TextBlock({ text: 'done' })]));
        const agent = new Agent({
            name: 'Friday',
            systemPrompt: 'p',
            model,
            middlewares: [new TracingMiddleware({ tracer: tracer as unknown as Tracer })],
            injectionConfig: { injectRuntimeState: false },
        });
        await agent.reply({ msgs: UserMsg({ name: 'user', content: 'hi' }) });
        expect(tracer.spans.map(span => span.name)).toEqual([
            'invoke_agent Friday',
            'chat test-model',
        ]);
        expect(
            new Set(
                tracer.spans.map(span => span.attributes[SpanAttributes.GEN_AI_CONVERSATION_ID])
            ).size
        ).toBe(1);
        expect(tracer.spans[0].attributes).toMatchObject({
            [SpanAttributes.AGENTSCOPE_REPLY_ID]: agent.state.replyId,
        });
        expect(tracer.spans.every(span => span.ended)).toBe(true);
    });

    test('tool spans include call identity and result', async () => {
        const tracer = new FakeTracer();
        const tool = new TestTool('Search', { readOnly: true });
        const model = new QueueModel();
        model.responses.push(
            response([ToolCallBlock({ id: 'search-id', name: 'Search', input: '{}' })]),
            response([TextBlock({ text: 'done' })])
        );
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'p',
            model,
            toolkit: new Toolkit({ tools: [tool] }),
            middlewares: [new TracingMiddleware({ tracer: tracer as unknown as Tracer })],
            injectionConfig: { injectRuntimeState: false },
        });
        await agent.reply();
        const span = tracer.spans.find(item => item.name === 'execute_tool Search')!;
        expect(span.attributes).toMatchObject({
            [SpanAttributes.GEN_AI_TOOL_CALL_ID]: 'search-id',
            [SpanAttributes.GEN_AI_TOOL_NAME]: 'Search',
        });
        expect(span.attributes[SpanAttributes.GEN_AI_TOOL_CALL_RESULT]).toEqual(
            expect.stringContaining('Search:undefined')
        );
    });

    test('HITL pending tools and continuation reply id are traced', async () => {
        const tracer = new FakeTracer();
        const tool = new TestTool('Ask');
        const model = new QueueModel();
        model.responses.push(
            response([ToolCallBlock({ id: 'ask', name: 'Ask', input: '{}' })]),
            response([TextBlock({ text: 'done' })])
        );
        tool.checkPermissions = async () => ({
            behavior: 'ask' as never,
            message: 'ask',
        });
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'p',
            model,
            toolkit: new Toolkit({ tools: [tool] }),
            middlewares: [new TracingMiddleware({ tracer: tracer as unknown as Tracer })],
            injectionConfig: { injectRuntimeState: false },
        });
        for await (const _event of agent.replyStream()) void _event;
        const firstReply = tracer.spans.find(span => span.name === 'invoke_agent a')!;
        expect(firstReply.attributes[SpanAttributes.AGENTSCOPE_HITL_PENDING_TOOLS]).toBe('["Ask"]');
    });

    test('external continuation creates a synthetic tool span', async () => {
        const tracer = new FakeTracer();
        const external = new TestTool('External', { external: true });
        const model = new QueueModel();
        model.responses.push(
            response([ToolCallBlock({ id: 'external', name: 'External', input: '{}' })]),
            response([TextBlock({ text: 'done' })])
        );
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'p',
            model,
            toolkit: new Toolkit({ tools: [external] }),
            middlewares: [new TracingMiddleware({ tracer: tracer as unknown as Tracer })],
            injectionConfig: { injectRuntimeState: false },
        });
        for await (const _event of agent.replyStream()) void _event;
        await agent.reply({
            event: createEvent({
                type: EventType.EXTERNAL_EXECUTION_RESULT,
                reply_id: agent.state.replyId,
                execution_results: [
                    ToolResultBlock({
                        id: 'external',
                        name: 'External',
                        output: 'received',
                        state: 'success',
                    }),
                ],
            }) as ExternalExecutionResultEvent,
        });
        const synthetic = tracer.spans.find(
            span =>
                span.name === 'execute_tool External' &&
                span.attributes[SpanAttributes.AGENTSCOPE_IS_EXTERNAL_EXECUTION] === true
        );
        expect(synthetic?.attributes).toMatchObject({
            [SpanAttributes.GEN_AI_TOOL_CALL_RESULT]: '"received"',
        });
        const replies = tracer.spans.filter(span => span.name === 'invoke_agent a');
        expect(replies[1].attributes).toMatchObject({
            [SpanAttributes.AGENTSCOPE_INCOMING_EVENT_TYPE]: 'external_execution_result',
        });
    });
});
