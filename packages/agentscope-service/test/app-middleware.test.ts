/* eslint-disable jsdoc/require-jsdoc */

import { Agent } from '@agentscope-ai/agentscope/agent';
import { createEvent, EventType, ReplyFinishedReason } from '@agentscope-ai/agentscope/event';
import {
    AssistantMsg,
    HintBlock,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
} from '@agentscope-ai/agentscope/message';
import type {
    ActingStream,
    AgentStream,
    ReasoningStream,
} from '@agentscope-ai/agentscope/middleware';
import { ChatModelBase, ChatResponse } from '@agentscope-ai/agentscope/model';
import { createPermissionDecision, PermissionBehavior } from '@agentscope-ai/agentscope/permission';
import { AgentState, createTask } from '@agentscope-ai/agentscope/state';
import { ToolBase, ToolChunk, ToolResponse, Toolkit } from '@agentscope-ai/agentscope/tool';
import type { ToolChoice, ToolSchema } from '@agentscope-ai/agentscope/type';
import { z } from 'zod';

import { BackgroundTaskManager } from '../src/manager';
import type { BusPayload } from '../src/message-bus';
import { InMemoryMessageBus, MessageBusKeys } from '../src/message-bus';
import {
    InboxMiddleware,
    StateChangeMiddleware,
    TeamMemberLoopMiddleware,
    ToolOffloadMiddleware,
} from '../src/middleware';

class EmptyModel extends ChatModelBase {
    constructor() {
        super({ modelName: 'empty', stream: false });
    }
    protected async _callAPI(): Promise<ChatResponse> {
        return new ChatResponse({ content: [], isLast: true });
    }
    _formatToolChoice(_choice: ToolChoice): unknown {
        return undefined;
    }
    _formatToolSchemas(_tools: ToolSchema[]): unknown[] {
        return [];
    }
}

class StubTool extends ToolBase {
    readonly name = 'Slow';
    readonly description = 'Slow tool.';
    readonly inputSchema = z.object({});
    readonly isConcurrencySafe = true;
    readonly isReadOnly = true;
    checkPermissions() {
        return createPermissionDecision({
            behavior: PermissionBehavior.ALLOW,
            message: 'Allowed.',
        });
    }
    async call(): Promise<ToolChunk> {
        return new ToolChunk({ content: [] });
    }
}

class RecordingBus extends InMemoryMessageBus {
    readonly published: BusPayload[] = [];
    override async sessionPublishEvent(sessionId: string, event: BusPayload): Promise<string> {
        this.published.push(structuredClone(event));
        return super.sessionPublishEvent(sessionId, event);
    }
}

function agent(options: { state?: AgentState; tools?: ToolBase[] } = {}): Agent {
    return new Agent({
        name: 'worker',
        systemPrompt: 'Test.',
        model: new EmptyModel(),
        state: options.state ?? new AgentState({ sessionId: 'session' }),
        toolkit: new Toolkit({ tools: options.tools ?? [] }),
    });
}

describe('app middlewares', () => {
    test('InboxMiddleware drains, injects and emits each hint', async () => {
        const bus = new InMemoryMessageBus();
        const current = agent();
        const hint = HintBlock({ hint: 'New work.', source: 'test' });
        await bus.queuePush(MessageBusKeys.inbox('session'), { ...hint });
        const middleware = new InboxMiddleware(bus);
        const next = async function* (): ReasoningStream {};
        const events = [];
        for await (const event of middleware.onReasoning(current, {}, next)) events.push(event);
        expect(events).toEqual([
            expect.objectContaining({
                type: EventType.HINT_BLOCK,
                block_id: hint.id,
                hint: 'New work.',
            }),
        ]);
        expect(current.state.context).toEqual([
            expect.objectContaining({
                role: 'assistant',
                content: [hint],
            }),
        ]);
        expect(await bus.queueDrain(MessageBusKeys.inbox('session'))).toEqual([]);
    });

    test('StateChangeMiddleware publishes state and team invalidations', async () => {
        const bus = new RecordingBus();
        const current = agent();
        const middleware = new StateChangeMiddleware(bus, 'session');
        const toolCall = ToolCallBlock({ id: 'team-create', name: 'TeamCreate', input: '{}' });
        const next = async function* (): ActingStream {
            current.state.tasksContext.tasks.push(
                createTask({ id: '1', subject: 'Test', description: 'Test.', metadata: {} })
            );
            yield new ToolChunk({ content: [] });
        };
        for await (const _ of middleware.onActing(current, { toolCall }, next)) {
            // Drain the wrapped stream.
        }
        expect(bus.published).toEqual([
            expect.objectContaining({ type: EventType.CUSTOM, name: 'state_updated' }),
            expect.objectContaining({ type: EventType.CUSTOM, name: 'team_updated' }),
        ]);
    });

    test('TeamMemberLoopMiddleware accepts a successful leader report and nudges otherwise', async () => {
        const reportedState = new AgentState({ sessionId: 'session' });
        const call = ToolCallBlock({
            id: 'call',
            name: 'TeamSay',
            input: JSON.stringify({ content: 'Done.', to: 'leader' }),
        });
        reportedState.context.push(
            AssistantMsg({
                id: reportedState.replyId,
                name: 'worker',
                content: [
                    call,
                    ToolResultBlock({ id: call.id, name: call.name, output: [], state: 'success' }),
                ],
            })
        );
        const completed = createEvent({
            type: EventType.REPLY_END,
            session_id: 'session',
            reply_id: reportedState.replyId,
            finished_reason: ReplyFinishedReason.COMPLETED,
        });
        const pass = async function* (): AgentStream {
            yield completed;
        };
        const middleware = new TeamMemberLoopMiddleware('leader');
        const passed = [];
        for await (const event of middleware.onReply(agent({ state: reportedState }), {}, pass)) {
            passed.push(event);
        }
        expect(passed).toEqual([completed]);

        const unreported = agent({ state: new AgentState({ sessionId: 'session' }) });
        const nudged = [];
        for await (const event of middleware.onReply(unreported, {}, pass)) nudged.push(event);
        expect(nudged).toEqual([expect.objectContaining({ type: EventType.HINT_BLOCK })]);
        expect(unreported.state.context.at(-1)?.content).toEqual([
            expect.objectContaining({ type: 'hint', hint: expect.stringContaining('TeamSay') }),
        ]);
    });

    test('ToolOffloadMiddleware returns a placeholder and later delivers full output', async () => {
        const bus = new InMemoryMessageBus();
        const manager = new BackgroundTaskManager(bus);
        const slow = new StubTool();
        const current = agent({ tools: [slow] });
        const middleware = new ToolOffloadMiddleware(manager, bus, 'u', 'agent', 5);
        const call = ToolCallBlock({ id: 'call', name: slow.name, input: '{}' });
        const next = async function* (): ActingStream {
            await new Promise(resolve => setTimeout(resolve, 20));
            yield new ToolResponse({
                id: call.id,
                content: [TextBlock({ text: 'Finished.' })],
            });
        };
        const foreground = [];
        for await (const item of middleware.onActing(current, { toolCall: call }, next)) {
            foreground.push(item);
        }
        expect(foreground).toEqual([
            expect.objectContaining({ state: 'success' }),
            expect.objectContaining({ state: 'success', id: call.id }),
        ]);
        await new Promise(resolve => setTimeout(resolve, 35));
        const entries = await bus.queueDrain(MessageBusKeys.inbox('session'));
        expect(entries).toEqual([
            [
                expect.any(String),
                expect.objectContaining({
                    type: 'hint',
                    hint: [
                        expect.objectContaining({
                            type: 'text',
                            text: expect.stringContaining('Finished.'),
                        }),
                    ],
                }),
            ],
        ]);
    });
});
