/* eslint-disable jsdoc/require-jsdoc */

import { EventType, ReplyFinishedReason, type AgentEvent } from '@agentscope-ai/agentscope/event';

import { ProtocolMiddlewareBase } from './base';

export type AGUIEvent = Record<string, unknown> & { type: string };

/** Convert AgentScope event streams to the AG-UI wire protocol. */
export class AGUIProtocolMiddleware extends ProtocolMiddlewareBase<AGUIEvent> {
    private lastModelName = 'model_call';
    private readonly toolResultBuffers = new Map<string, string[]>();

    convertToProtocol(event: AgentEvent): AGUIEvent {
        switch (event.type) {
            case EventType.REPLY_START:
                return { type: 'RUN_STARTED', threadId: event.session_id, runId: event.reply_id };
            case EventType.REPLY_END:
                return event.finished_reason === ReplyFinishedReason.EXCEED_MAX_ITERS
                    ? {
                          type: 'RUN_ERROR',
                          message: 'The agent exceeded the maximum reasoning-acting iterations',
                          code: 'exceed_max_iters',
                      }
                    : { type: 'RUN_FINISHED', threadId: event.session_id, runId: event.reply_id };
            case EventType.EXCEED_MAX_ITERS:
                return this.custom('exceed_max_iters', event);
            case EventType.MODEL_CALL_START:
                this.lastModelName = event.model_name;
                return { type: 'STEP_STARTED', stepName: event.model_name };
            case EventType.MODEL_CALL_END:
                return { type: 'STEP_FINISHED', stepName: this.lastModelName };
            case EventType.TEXT_BLOCK_START:
                return { type: 'TEXT_MESSAGE_START', messageId: event.block_id, role: 'assistant' };
            case EventType.TEXT_BLOCK_DELTA:
                return {
                    type: 'TEXT_MESSAGE_CONTENT',
                    messageId: event.block_id,
                    delta: event.delta,
                };
            case EventType.TEXT_BLOCK_END:
                return { type: 'TEXT_MESSAGE_END', messageId: event.block_id };
            case EventType.THINKING_BLOCK_START:
                return {
                    type: 'REASONING_MESSAGE_START',
                    messageId: event.block_id,
                    role: 'reasoning',
                };
            case EventType.THINKING_BLOCK_DELTA:
                return {
                    type: 'REASONING_MESSAGE_CONTENT',
                    messageId: event.block_id,
                    delta: event.delta,
                };
            case EventType.THINKING_BLOCK_END:
                return { type: 'REASONING_MESSAGE_END', messageId: event.block_id };
            case EventType.TOOL_CALL_START:
                return {
                    type: 'TOOL_CALL_START',
                    toolCallId: event.tool_call_id,
                    toolCallName: event.tool_call_name,
                    parentMessageId: event.reply_id,
                };
            case EventType.TOOL_CALL_DELTA:
                return {
                    type: 'TOOL_CALL_ARGS',
                    toolCallId: event.tool_call_id,
                    delta: event.delta,
                };
            case EventType.TOOL_CALL_END:
                return { type: 'TOOL_CALL_END', toolCallId: event.tool_call_id };
            case EventType.TOOL_RESULT_START:
                return this.custom('tool_result_start', event);
            case EventType.TOOL_RESULT_TEXT_DELTA: {
                const chunks = this.toolResultBuffers.get(event.tool_call_id) ?? [];
                chunks.push(event.delta);
                this.toolResultBuffers.set(event.tool_call_id, chunks);
                return this.custom('tool_result_text_delta', event);
            }
            case EventType.TOOL_RESULT_DATA_DELTA:
                return this.custom('tool_result_data_delta', event);
            case EventType.TOOL_RESULT_END: {
                const chunks = this.toolResultBuffers.get(event.tool_call_id) ?? [];
                this.toolResultBuffers.delete(event.tool_call_id);
                return {
                    type: 'TOOL_CALL_RESULT',
                    toolCallId: event.tool_call_id,
                    messageId: event.reply_id,
                    content: chunks.join('') || String(event.state),
                };
            }
            case EventType.DATA_BLOCK_START:
                return this.custom('data_block_start', event);
            case EventType.DATA_BLOCK_DELTA:
                return this.custom('data_block_delta', event);
            case EventType.DATA_BLOCK_END:
                return this.custom('data_block_end', event);
            case EventType.REQUIRE_USER_CONFIRM:
                return this.custom('require_user_confirm', event);
            case EventType.REQUIRE_EXTERNAL_EXECUTION:
                return this.custom('require_external_execution', event);
            case EventType.USER_CONFIRM_RESULT:
                return this.custom('user_confirm_result', event);
            case EventType.EXTERNAL_EXECUTION_RESULT:
                return this.custom('external_execution_result', event);
            default:
                return this.custom('unknown', event);
        }
    }

    private custom(name: string, event: AgentEvent): AGUIEvent {
        return { type: 'CUSTOM', name, value: JSON.parse(JSON.stringify(event)) };
    }
}
