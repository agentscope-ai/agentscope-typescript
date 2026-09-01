/* eslint-disable jsdoc/require-jsdoc */

import type { Agent } from '../agent';
import { createEvent, EventType } from '../event';
import { HintBlock } from '../message';
import { ToolChoice } from '../tool';
import { MiddlewareBase } from './base';
import type { AgentStream, ReasoningHookInput, ReasoningStream, ReplyHookInput } from './base';

const DEFAULT_HINT_MESSAGE =
    '<system-reminder>You have reached the maximum token budget set by the user. ' +
    'Now you MUST wrap up immediately and provide a final concluding response without ' +
    'invoking any tools.</system-reminder>';

/** Enforce a weighted model-token budget for each reply. */
export class ReplyBudgetControlMiddleware extends MiddlewareBase {
    readonly tokenBudget: number;
    readonly inputTokenWeight: number;
    readonly outputTokenWeight: number;
    readonly hintMessage: string;

    constructor(options: {
        tokenBudget: number;
        inputTokenWeight?: number;
        outputTokenWeight?: number;
        hintMessage?: string;
    }) {
        super();
        this.tokenBudget = options.tokenBudget;
        this.inputTokenWeight = options.inputTokenWeight ?? 1;
        this.outputTokenWeight = options.outputTokenWeight ?? 1;
        this.hintMessage = options.hintMessage ?? DEFAULT_HINT_MESSAGE;
    }

    override async *onReply(
        agent: Agent,
        input: ReplyHookInput,
        next: (input?: Partial<ReplyHookInput>) => AgentStream
    ): AgentStream {
        const key = await this.getMiddlewareKey();
        for await (const item of next(input)) {
            if (!('type' in item)) {
                yield item;
                continue;
            }
            const state = (agent.state.middleContext[key] ??= {}) as Record<string, number>;
            if (item.type === EventType.REPLY_START) state[item.reply_id] = 0;
            else if (item.type === EventType.MODEL_CALL_END) {
                state[item.reply_id] =
                    (state[item.reply_id] ?? 0) +
                    this.inputTokenWeight * item.input_tokens +
                    this.outputTokenWeight * item.output_tokens;
            } else if (item.type === EventType.REPLY_END) delete state[item.reply_id];
            yield createEvent(item);
        }
    }

    override async *onReasoning(
        agent: Agent,
        input: ReasoningHookInput,
        next: (input?: Partial<ReasoningHookInput>) => ReasoningStream
    ): ReasoningStream {
        const key = await this.getMiddlewareKey();
        const state = agent.state.middleContext[key] as Record<string, number> | undefined;
        const effective = { ...input };
        if ((state?.[agent.state.replyId] ?? 0) >= this.tokenBudget) {
            agent.state.appendContext({
                name: agent.name,
                blocks: [HintBlock({ hint: this.hintMessage })],
            });
            effective.toolChoice = new ToolChoice({ mode: 'none' });
        }
        yield* next(effective);
    }
}
