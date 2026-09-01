/* eslint-disable jsdoc/require-jsdoc */

import type { Agent } from '@agentscope-ai/agentscope/agent';
import { HintBlock, TextBlock } from '@agentscope-ai/agentscope/message';
import type { ActingHookInput, ActingStream } from '@agentscope-ai/agentscope/middleware';
import { MiddlewareBase } from '@agentscope-ai/agentscope/middleware';
import { ToolChunk, ToolResponse } from '@agentscope-ai/agentscope/tool';

import { deliverToInbox } from '../bus-ops';
import { type BackgroundTaskManager, ManagedTask } from '../manager';
import type { MessageBus } from '../message-bus';

/** Offload slow, state-independent tool streams without cancelling their execution. */
export class ToolOffloadMiddleware extends MiddlewareBase {
    constructor(
        private readonly backgroundTaskManager: BackgroundTaskManager,
        private readonly messageBus: MessageBus,
        private readonly userId: string,
        private readonly agentId: string,
        private readonly timeoutMs = 10_000
    ) {
        super();
    }

    override async *onActing(
        agent: Agent,
        input: ActingHookInput,
        next: (input?: Partial<ActingHookInput>) => ActingStream
    ): ActingStream {
        const tool = await agent.toolkit.getTool(input.toolCall.name);
        if (tool?.isStateInjected || tool?.isExternalTool) {
            yield* next(input);
            return;
        }

        const items: Array<ToolChunk | ToolResponse> = [];
        const iterator = next(input)[Symbol.asyncIterator]();
        const task = new ManagedTask<void>(
            signal => drainIterator(iterator, items, signal),
            `tool-offload:${input.toolCall.id}`
        );
        const outcome = await raceWithTimeout(task.promise, this.timeoutMs);
        if (outcome === 'completed') {
            yield* items;
            return;
        }

        const sessionId = agent.state.sessionId;
        const toolName = input.toolCall.name;
        const taskId = await this.backgroundTaskManager.registerManagedTask(task, {
            sessionId,
            agentId: this.agentId,
            userId: this.userId,
            toolName,
        });
        void this.deliverWhenDone(task, items, sessionId, toolName, input.toolCall.id);
        const timeoutSeconds = this.timeoutMs / 1_000;
        const placeholder =
            `<system-reminder>Tool '${toolName}' is running in background (id=${taskId}) ` +
            `for over ${timeoutSeconds}s. You will be notified automatically when it ` +
            'finishes, so **DO NOT** poll, query, or wait for the result yourself. **DO ' +
            'NOT** call any waiting tool such as `bash sleep`. You have exactly two valid ' +
            'options:\n1. Continue with other independent tasks and ignore this tool for now; ' +
            'or\n2. If there is nothing else to do, simply give a text reply without calling ' +
            'any tool, which ends the current reasoning loop — just do nothing and end this ' +
            'run.\n</system-reminder>';
        yield new ToolChunk({ content: [TextBlock({ text: placeholder })], state: 'success' });
        yield new ToolResponse({
            id: input.toolCall.id,
            content: [TextBlock({ text: placeholder })],
            state: 'success',
        });
    }

    private async deliverWhenDone(
        task: ManagedTask<void>,
        items: Array<ToolChunk | ToolResponse>,
        sessionId: string,
        toolName: string,
        toolCallId: string
    ): Promise<void> {
        try {
            await task.promise;
        } catch {
            return;
        }
        const response = items.find(item => item instanceof ToolResponse) as
            | ToolResponse
            | undefined;
        const source = JSON.stringify({
            label: 'tool_output',
            sublabel: `${toolName} · ${toolCallId}`,
        });
        let hint = `Tool '${toolName}' running in background (id=${toolCallId}) has completed `;
        if (!response?.content.length) {
            hint = `<system-notification>${hint}with no output.</system-notification>`;
        } else {
            const blocks = structuredClone(response.content);
            const prefix = `<system-notification>${hint.trimEnd()}.\n\nResult:\n\n`;
            if (blocks[0].type === 'text') blocks[0].text = prefix + blocks[0].text;
            else blocks.unshift(TextBlock({ text: prefix }));
            const last = blocks.at(-1)!;
            if (last.type === 'text') last.text += '</system-notification>';
            else blocks.push(TextBlock({ text: '</system-notification>' }));
            await deliverToInbox(this.messageBus, {
                userId: this.userId,
                sessionId,
                agentId: this.agentId,
                payload: { ...HintBlock({ hint: blocks, source }) },
            });
            return;
        }
        await deliverToInbox(this.messageBus, {
            userId: this.userId,
            sessionId,
            agentId: this.agentId,
            payload: { ...HintBlock({ hint, source }) },
        });
    }
}

async function drainIterator(
    iterator: AsyncIterator<ToolChunk | ToolResponse>,
    items: Array<ToolChunk | ToolResponse>,
    signal: AbortSignal
): Promise<void> {
    while (true) {
        const next = await abortableNext(iterator, signal);
        if (next.done) return;
        items.push(next.value);
        if (next.value instanceof ToolResponse) return;
    }
}

async function abortableNext<T>(
    iterator: AsyncIterator<T>,
    signal: AbortSignal
): Promise<IteratorResult<T>> {
    if (signal.aborted) {
        await iterator.return?.();
        throw signal.reason ?? new Error('Background tool cancelled.');
    }
    let onAbort = (): void => {};
    const aborted = new Promise<never>((_, reject) => {
        onAbort = (): void => {
            void iterator.return?.();
            reject(signal.reason ?? new Error('Background tool cancelled.'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([iterator.next(), aborted]);
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}

async function raceWithTimeout(
    promise: Promise<unknown>,
    milliseconds: number
): Promise<'completed' | 'timeout'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise.then(() => 'completed' as const),
            new Promise<'timeout'>(resolve => {
                timer = setTimeout(() => resolve('timeout'), milliseconds);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
