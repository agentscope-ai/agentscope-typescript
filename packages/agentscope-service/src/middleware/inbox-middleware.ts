/* eslint-disable jsdoc/require-jsdoc */

import type { Agent } from '@agentscope-ai/agentscope/agent';
import { createEvent, EventType } from '@agentscope-ai/agentscope/event';
import { HintBlockSchema } from '@agentscope-ai/agentscope/message';
import { MiddlewareBase, type ReasoningHookInput } from '@agentscope-ai/agentscope/middleware';
import type { ReasoningStream } from '@agentscope-ai/agentscope/middleware';

import type { MessageBus } from '../message-bus';
import { MessageBusKeys } from '../message-bus';

/** Drain durable inbox hints before each reasoning step. */
export class InboxMiddleware extends MiddlewareBase {
    constructor(
        private readonly messageBus: MessageBus,
        private readonly maxCount = 100
    ) {
        super();
    }

    override async *onReasoning(
        agent: Agent,
        input: ReasoningHookInput,
        next: (input?: Partial<ReasoningHookInput>) => ReasoningStream
    ): ReasoningStream {
        const entries = await this.messageBus.queueDrain(
            MessageBusKeys.inbox(agent.state.sessionId),
            this.maxCount
        );
        for (const [, payload] of entries) {
            const hint = HintBlockSchema.parse(payload);
            agent.state.appendContext({ name: agent.name, blocks: [hint] });
            yield createEvent({
                type: EventType.HINT_BLOCK,
                reply_id: agent.state.replyId,
                block_id: hint.id,
                source: hint.source,
                hint: hint.hint,
            });
        }
        yield* next(input);
    }
}
