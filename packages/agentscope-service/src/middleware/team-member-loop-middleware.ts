/* eslint-disable jsdoc/require-jsdoc */

import type { Agent } from '@agentscope-ai/agentscope/agent';
import {
    createEvent,
    EventType,
    ErrorType,
    ReplyFinishedReason,
} from '@agentscope-ai/agentscope/event';
import type { ReplyEndEvent } from '@agentscope-ai/agentscope/event';
import { HintBlock } from '@agentscope-ai/agentscope/message';
import type { ToolCallBlock, ToolResultBlock } from '@agentscope-ai/agentscope/message';
import type { AgentStream, ReplyHookInput } from '@agentscope-ai/agentscope/middleware';
import { MiddlewareBase } from '@agentscope-ai/agentscope/middleware';
import { _jsonLoadsWithRepair } from '@agentscope-ai/agentscope/utils';

/** Require worker turns to finish by successfully reporting through TeamSay. */
export class TeamMemberLoopMiddleware extends MiddlewareBase {
    constructor(
        private readonly leaderName: string,
        private readonly maxNudges = 3
    ) {
        super();
    }

    override async *onReply(
        agent: Agent,
        input: ReplyHookInput,
        next: (input?: Partial<ReplyHookInput>) => AgentStream
    ): AgentStream {
        let nudges = 0;
        for await (const item of next(input)) {
            if (!isReplyEnd(item)) {
                yield item;
                continue;
            }
            if (this.lastToolCallReportsToLeader(agent)) {
                yield item;
                continue;
            }
            if (
                item.finished_reason !== ReplyFinishedReason.COMPLETED &&
                item.finished_reason !== ReplyFinishedReason.EXCEED_MAX_ITERS
            ) {
                yield item;
                continue;
            }
            if (nudges >= this.maxNudges) {
                yield createEvent({
                    type: EventType.REPLY_END,
                    session_id: item.session_id,
                    reply_id: item.reply_id,
                    finished_reason: ReplyFinishedReason.ERROR,
                    error: {
                        type: ErrorType.INTERNAL,
                        message:
                            `${agent.name} ended ${nudges} replies in a row without reporting ` +
                            `to ${this.leaderName} via TeamSay; giving up on this turn.`,
                    },
                });
                continue;
            }
            nudges += 1;
            const instruction =
                item.finished_reason === ReplyFinishedReason.EXCEED_MAX_ITERS
                    ? `<system-reminder>You have reached the maximum number of ReAct ` +
                      `iterations (${agent.reactConfig.maxIters}). Call \`TeamSay\` now to ` +
                      'report to the leader and ask for permission to continue.</system-reminder>'
                    : '<system-reminder>You MUST call the tool `TeamSay` to report to the ' +
                      'leader to finish your task.</system-reminder>';
            agent.state.curIter = Math.min(agent.state.curIter, agent.reactConfig.maxIters - 1);
            const hint = HintBlock({
                hint: instruction,
                source: JSON.stringify({ label: 'System', sublabel: 'Reminder' }),
            });
            agent.state.appendContext({ name: agent.name, blocks: [hint] });
            yield createEvent({
                type: EventType.HINT_BLOCK,
                reply_id: agent.state.replyId,
                block_id: hint.id,
                source: hint.source,
                hint: instruction,
            });
        }
    }

    private lastToolCallReportsToLeader(agent: Agent): boolean {
        for (const message of [...agent.state.context].reverse()) {
            if (
                message.id !== agent.state.replyId ||
                message.role !== 'assistant' ||
                message.name !== agent.name
            ) {
                continue;
            }
            const lastCall = [...message.content]
                .reverse()
                .find((block): block is ToolCallBlock => block.type === 'tool_call');
            if (!lastCall) continue;
            if (lastCall.name !== 'TeamSay') return false;
            let args: Record<string, unknown>;
            try {
                args = _jsonLoadsWithRepair(lastCall.input) as Record<string, unknown>;
            } catch {
                return false;
            }
            if (args.to != null && args.to !== this.leaderName) return false;
            const result = message.content.find(
                (block): block is ToolResultBlock =>
                    block.type === 'tool_result' && block.id === lastCall.id
            );
            return result?.state === 'success';
        }
        return false;
    }
}

function isReplyEnd(value: unknown): value is ReplyEndEvent {
    return Boolean(
        value && typeof value === 'object' && 'type' in value && value.type === 'REPLY_END'
    );
}
