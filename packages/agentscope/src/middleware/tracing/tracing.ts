/* eslint-disable jsdoc/require-jsdoc */

import { SpanStatusCode, context as otelContext, trace as otelTrace } from '@opentelemetry/api';
import type { Context, Span, Tracer } from '@opentelemetry/api';

import type { Agent } from '../../agent';
import { EventType } from '../../event';
import type { AgentEvent } from '../../event';
import type { Msg } from '../../message';
import type { ChatResponse } from '../../model';
import { ToolResponse } from '../../tool';
import { MiddlewareBase } from '../base';
import type {
    ActingHookInput,
    ActingStream,
    AgentStream,
    ModelCallHookInput,
    ModelResult,
    ReplyHookInput,
} from '../base';
import { OperationNameValues, SpanAttributes } from './attributes';
import { serializeToString } from './converter';
import {
    getAgentRequestAttributes,
    getAgentResponseAttributes,
    getCommonAttributes,
    getLLMRequestAttributes,
    getLLMResponseAttributes,
    getSpanName,
    getToolRequestAttributes,
    getToolResponseAttributes,
} from './extractor';

/** OpenTelemetry instrumentation for agent, model, and tool lifecycle hooks. */
export class TracingMiddleware extends MiddlewareBase {
    private readonly tracer: Tracer;

    constructor(options: { tracer?: Tracer } = {}) {
        super();
        this.tracer = options.tracer ?? otelTrace.getTracer('agentscope');
    }

    override async *onReply(
        agent: Agent,
        input: ReplyHookInput,
        next: (input?: Partial<ReplyHookInput>) => AgentStream
    ): AgentStream {
        const common = getCommonAttributes(agent.state.sessionId);
        const request = getAgentRequestAttributes(agent, input as Record<string, unknown>);
        const span = this.tracer.startSpan(getSpanName(request, 'agent'), {
            attributes: { ...request, ...common },
        });
        const spanContext = otelTrace.setSpan(otelContext.active(), span);
        if (input.inputs && isExternalResult(input.inputs)) {
            for (const result of input.inputs.execution_results) {
                const attributes = {
                    [SpanAttributes.GEN_AI_OPERATION_NAME]: OperationNameValues.EXECUTE_TOOL,
                    [SpanAttributes.GEN_AI_TOOL_CALL_ID]: result.id,
                    [SpanAttributes.GEN_AI_TOOL_NAME]: result.name,
                    [SpanAttributes.AGENTSCOPE_IS_EXTERNAL_EXECUTION]: true,
                    [SpanAttributes.GEN_AI_TOOL_CALL_RESULT]: serializeToString(result.output),
                    ...common,
                };
                const externalSpan = this.tracer.startSpan(
                    `${OperationNameValues.EXECUTE_TOOL} ${result.name}`,
                    { attributes },
                    spanContext
                );
                endSuccess(externalSpan);
            }
        }
        let finalMessage: Msg | null = null;
        let observedReplyId: string | null = null;
        const hitl: string[] = [];
        const external: string[] = [];
        const stream = next(input);
        try {
            while (true) {
                const item = await nextWithContext(stream, spanContext);
                if (item.done) break;
                if (isMsg(item.value)) finalMessage = item.value;
                else
                    this.observeReplyEvent(item.value, hitl, external, value => {
                        observedReplyId = value;
                    });
                yield item.value;
            }
            span.setAttribute(
                SpanAttributes.AGENTSCOPE_REPLY_ID,
                observedReplyId ?? agent.state.replyId
            );
            if (hitl.length) {
                span.setAttribute(
                    SpanAttributes.AGENTSCOPE_HITL_PENDING_TOOLS,
                    JSON.stringify(hitl)
                );
            }
            if (external.length) {
                span.setAttribute(
                    SpanAttributes.AGENTSCOPE_EXTERNAL_EXECUTION_PENDING_TOOLS,
                    JSON.stringify(external)
                );
            }
            if (finalMessage) span.setAttributes(getAgentResponseAttributes(finalMessage));
            endSuccess(span);
        } catch (error) {
            endError(span, error);
            throw error;
        }
    }

    override async onModelCall(
        agent: Agent,
        input: ModelCallHookInput,
        next: (input?: Partial<ModelCallHookInput>) => Promise<ModelResult>
    ): Promise<ModelResult> {
        const request = getLLMRequestAttributes(input.currentModel, {
            ...input.currentModel.parameters,
            ...input,
        });
        const span = this.tracer.startSpan(getSpanName(request, 'llm'), {
            attributes: { ...request, ...getCommonAttributes(agent.state.sessionId) },
        });
        const spanContext = otelTrace.setSpan(otelContext.active(), span);
        try {
            const result = await otelContext.with(spanContext, () => next(input));
            if (isAsyncGenerator(result)) return traceModelStream(result, span, spanContext);
            span.setAttributes(getLLMResponseAttributes(result));
            endSuccess(span);
            return result;
        } catch (error) {
            endError(span, error);
            throw error;
        }
    }

    override async *onActing(
        agent: Agent,
        input: ActingHookInput,
        next: (input?: Partial<ActingHookInput>) => ActingStream
    ): ActingStream {
        const request = getToolRequestAttributes(agent.toolkit, input.toolCall);
        const span = this.tracer.startSpan(getSpanName(request, 'tool'), {
            attributes: { ...request, ...getCommonAttributes(agent.state.sessionId) },
        });
        const spanContext = otelTrace.setSpan(otelContext.active(), span);
        const stream = next(input);
        let last: ToolResponse | null = null;
        try {
            while (true) {
                const item = await nextWithContext(stream, spanContext);
                if (item.done) break;
                if (item.value instanceof ToolResponse) last = item.value;
                yield item.value;
            }
            if (last) span.setAttributes(getToolResponseAttributes(last.toJSON()));
            endSuccess(span);
        } catch (error) {
            endError(span, error);
            throw error;
        }
    }

    private observeReplyEvent(
        event: AgentEvent,
        hitl: string[],
        external: string[],
        setReplyId: (value: string) => void
    ): void {
        if (event.type === EventType.REPLY_START) setReplyId(event.reply_id);
        else if (event.type === EventType.REQUIRE_USER_CONFIRM) {
            hitl.push(...event.tool_calls.map(tool => tool.name));
        } else if (event.type === EventType.REQUIRE_EXTERNAL_EXECUTION) {
            external.push(...event.tool_calls.map(tool => tool.name));
        }
    }
}

async function* traceModelStream(
    stream: AsyncGenerator<ChatResponse, ChatResponse | void>,
    span: Span,
    spanContext: Context
): AsyncGenerator<ChatResponse, ChatResponse | void> {
    let last: ChatResponse | null = null;
    try {
        while (true) {
            const item = await nextWithContext(stream, spanContext);
            if (item.done) {
                if (item.value) last = item.value;
                span.setAttributes(getLLMResponseAttributes(last));
                endSuccess(span);
                return item.value;
            }
            last = item.value;
            yield item.value;
        }
    } catch (error) {
        endError(span, error);
        throw error;
    }
}

function nextWithContext<T, R>(
    stream: AsyncGenerator<T, R>,
    spanContext: Context
): Promise<IteratorResult<T, R>> {
    return otelContext.with(spanContext, () => stream.next());
}

function endSuccess(span: Span): void {
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
}

function endError(span: Span, error: unknown): void {
    const exception = error instanceof Error ? error : new Error(String(error));
    span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
    span.recordException(exception);
    span.end();
}

function isAsyncGenerator(
    value: ModelResult
): value is AsyncGenerator<ChatResponse, ChatResponse | void> {
    return typeof Reflect.get(value, 'next') === 'function';
}

function isMsg(value: AgentEvent | Msg): value is Msg {
    return 'role' in value && 'content' in value;
}

function isExternalResult(value: unknown): value is {
    execution_results: Array<{ id: string; name: string; output: unknown }>;
} {
    return (
        typeof value === 'object' &&
        value !== null &&
        'type' in value &&
        value.type === EventType.EXTERNAL_EXECUTION_RESULT
    );
}
