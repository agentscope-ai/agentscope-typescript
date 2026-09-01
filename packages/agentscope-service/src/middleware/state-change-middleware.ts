/* eslint-disable jsdoc/require-jsdoc */

import { createHash } from 'node:crypto';

import type { Agent } from '@agentscope-ai/agentscope/agent';
import { createEvent, EventType } from '@agentscope-ai/agentscope/event';
import type {
    ActingHookInput,
    ActingStream,
    AgentStream,
    ReplyHookInput,
} from '@agentscope-ai/agentscope/middleware';
import { MiddlewareBase } from '@agentscope-ai/agentscope/middleware';

import type { MessageBus } from '../message-bus';

const TEAM_TOOL_NAMES = new Set(['TeamCreate', 'AgentCreate', 'AgentInvite', 'TeamDelete']);

/** Publish state and team invalidation events after relevant mutations. */
export class StateChangeMiddleware extends MiddlewareBase {
    constructor(
        private readonly messageBus: MessageBus,
        private readonly sessionId: string
    ) {
        super();
    }

    override async *onReply(
        agent: Agent,
        input: ReplyHookInput,
        next: (input?: Partial<ReplyHookInput>) => AgentStream
    ): AgentStream {
        const before = stateHash(agent);
        yield* next(input);
        if (before !== stateHash(agent)) await this.publishState(agent);
    }

    override async *onActing(
        agent: Agent,
        input: ActingHookInput,
        next: (input?: Partial<ActingHookInput>) => ActingStream
    ): ActingStream {
        const before = stateHash(agent);
        yield* next(input);
        if (before !== stateHash(agent)) await this.publishState(agent);
        if (TEAM_TOOL_NAMES.has(input.toolCall.name)) {
            await this.messageBus.sessionPublishEvent(this.sessionId, {
                ...createEvent({ type: EventType.CUSTOM, name: 'team_updated', value: {} }),
            });
        }
    }

    private async publishState(agent: Agent): Promise<void> {
        await this.messageBus.sessionPublishEvent(this.sessionId, {
            ...createEvent({
                type: EventType.CUSTOM,
                name: 'state_updated',
                value: {
                    tasks_context: agent.state.tasksContext.toJSON(),
                    permission_context: structuredClone(agent.state.permissionContext),
                },
            }),
        });
    }
}

function stateHash(agent: Agent): string {
    return createHash('md5')
        .update(
            JSON.stringify(agent.state.tasksContext.toJSON()) +
                JSON.stringify(agent.state.permissionContext)
        )
        .digest('hex');
}
