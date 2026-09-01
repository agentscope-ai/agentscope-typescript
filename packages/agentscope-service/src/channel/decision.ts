/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns */

import { createEvent, EventType } from '@agentscope-ai/agentscope/event';
import { parseAgentState } from '@agentscope-ai/agentscope/state';

import { enqueueRunTrigger } from '../bus-ops';
import type { MessageBus } from '../message-bus';
import { MessageBusKeys } from '../message-bus';
import type { StorageBase } from '../storage';

async function loadAwaiting(
    storage: StorageBase,
    options: { userId: string; agentId: string; sessionId: string }
) {
    const [session, agent] = await Promise.all([
        storage.getSession(options.userId, options.agentId, options.sessionId),
        storage.getAgent(options.userId, options.agentId),
    ]);
    if (!session || !agent) return { asking: [], replyId: '' };
    const state = parseAgentState(session.state);
    return {
        asking: state
            .getAwaitingToolCalls({ name: agent.data.name })
            .filter(toolCall => toolCall.state === 'asking'),
        replyId: state.replyId,
    };
}

/** Resume a parked session when the identified call is still awaiting approval. */
export async function resumeAfterDecision(
    bus: MessageBus,
    storage: StorageBase,
    options: {
        userId: string;
        agentId: string;
        sessionId: string;
        toolCallId: string;
        approved: boolean;
    }
): Promise<boolean> {
    const { asking, replyId } = await loadAwaiting(storage, options);
    const toolCall = asking.find(call => call.id === options.toolCallId);
    if (!toolCall) return false;
    await enqueueRunTrigger(bus, {
        userId: options.userId,
        sessionId: options.sessionId,
        agentId: options.agentId,
        kind: MessageBusKeys.WAKEUP_KIND_RESUME,
        input: createEvent({
            type: EventType.USER_CONFIRM_RESULT,
            reply_id: replyId,
            confirm_results: [{ confirmed: options.approved, rules: null, tool_call: toolCall }],
        }),
    });
    return true;
}

export const resume_after_decision = resumeAfterDecision;
