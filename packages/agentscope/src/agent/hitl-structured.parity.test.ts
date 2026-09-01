/* eslint-disable jsdoc/require-jsdoc */

import { z } from 'zod';

import { Agent } from './agent';
import type { ReplyOptions } from './interfaces';
import { QueueModel, TestTool, response } from './test-helpers';
import { createEvent, EventType } from '../event';
import type {
    ExternalExecutionResultEvent,
    UserConfirmResultEvent,
    UserInterruptEvent,
} from '../event';
import { TextBlock, ToolCallBlock, ToolResultBlock, getContentBlocks } from '../message';
import { PermissionBehavior } from '../permission';
import { AgentState, parseAgentState } from '../state';
import { Toolkit } from '../tool';

async function collect(agent: Agent, options: ReplyOptions = {}) {
    const events = [];
    const stream = agent.replyStream({ ...options, yieldFinalMsg: false as const });
    while (true) {
        const item = await stream.next();
        if (item.done) return { events, final: item.value };
        events.push(item.value);
    }
}

describe('Agent HITL and structured output Python parity', () => {
    test('partial confirmations execute accepted calls without re-emitting parked calls', async () => {
        const first = new TestTool('First', { decision: PermissionBehavior.ASK });
        const second = new TestTool('Second', { decision: PermissionBehavior.ASK });
        const model = new QueueModel();
        model.responses.push(
            response([
                ToolCallBlock({ id: 'one', name: 'First', input: '{"value":"1"}' }),
                ToolCallBlock({ id: 'two', name: 'Second', input: '{"value":"2"}' }),
            ]),
            response([TextBlock({ text: 'done' })])
        );
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'p',
            model,
            toolkit: new Toolkit({ tools: [first, second] }),
            injectionConfig: { injectRuntimeState: false },
        });
        const parked = await collect(agent);
        expect(
            parked.events.filter(event => event.type === EventType.REQUIRE_USER_CONFIRM)
        ).toHaveLength(2);
        const callOne = getContentBlocks(agent.context.at(-1)!, 'tool_call')[0];
        const resumed = await collect(agent, {
            event: createEvent({
                type: EventType.USER_CONFIRM_RESULT,
                reply_id: agent.state.replyId,
                confirm_results: [{ confirmed: true, tool_call: callOne }],
            }) as UserConfirmResultEvent,
        });
        expect(first.calls).toEqual(['1']);
        expect(
            resumed.events.filter(event => event.type === EventType.REQUIRE_USER_CONFIRM)
        ).toEqual([]);
        expect(getContentBlocks(agent.context.at(-1)!, 'tool_call')[1].state).toBe('asking');
        const callTwo = getContentBlocks(agent.context.at(-1)!, 'tool_call')[1];
        const completed = await collect(agent, {
            event: createEvent({
                type: EventType.USER_CONFIRM_RESULT,
                reply_id: agent.state.replyId,
                confirm_results: [{ confirmed: true, tool_call: callTwo }],
            }) as UserConfirmResultEvent,
        });
        expect(second.calls).toEqual(['2']);
        expect(completed.final.content).toMatchObject([{ text: 'done' }]);
    });

    test('rejected calls become denied tool results', async () => {
        const tool = new TestTool('Danger', { decision: PermissionBehavior.ASK });
        const model = new QueueModel();
        model.responses.push(
            response([ToolCallBlock({ id: 'danger', name: 'Danger', input: '{}' })]),
            response([TextBlock({ text: 'alternative' })])
        );
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'p',
            model,
            toolkit: new Toolkit({ tools: [tool] }),
            injectionConfig: { injectRuntimeState: false },
        });
        await collect(agent);
        const call = getContentBlocks(agent.context.at(-1)!, 'tool_call')[0];
        const result = await collect(agent, {
            event: createEvent({
                type: EventType.USER_CONFIRM_RESULT,
                reply_id: agent.state.replyId,
                confirm_results: [{ confirmed: false, tool_call: call }],
            }) as UserConfirmResultEvent,
        });
        expect(result.events).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: EventType.TOOL_RESULT_END,
                    tool_call_id: 'danger',
                    state: 'denied',
                }),
            ])
        );
        expect(getContentBlocks(agent.context.at(-1)!, 'tool_result')[0].state).toBe('denied');
    });

    test('external execution parks, validates ids, and resumes with supplied result', async () => {
        const external = new TestTool('External', { external: true });
        const model = new QueueModel();
        model.responses.push(
            response([ToolCallBlock({ id: 'external', name: 'External', input: '{}' })]),
            response([TextBlock({ text: 'complete' })])
        );
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'p',
            model,
            toolkit: new Toolkit({ tools: [external] }),
            injectionConfig: { injectRuntimeState: false },
        });
        const parked = await collect(agent);
        expect(parked.events.at(-1)).toMatchObject({
            type: EventType.REQUIRE_EXTERNAL_EXECUTION,
            tool_calls: [{ id: 'external', state: 'submitted' }],
        });
        await expect(
            agent.reply({
                event: createEvent({
                    type: EventType.EXTERNAL_EXECUTION_RESULT,
                    reply_id: agent.state.replyId,
                    execution_results: [
                        ToolResultBlock({
                            id: 'wrong',
                            name: 'External',
                            output: 'bad',
                            state: 'success',
                        }),
                    ],
                }) as ExternalExecutionResultEvent,
            })
        ).rejects.toThrow('Unexpected external result ids');
        const completed = await agent.reply({
            event: createEvent({
                type: EventType.EXTERNAL_EXECUTION_RESULT,
                reply_id: agent.state.replyId,
                execution_results: [
                    ToolResultBlock({
                        id: 'external',
                        name: 'External',
                        output: 'external result',
                        state: 'success',
                    }),
                ],
            }) as ExternalExecutionResultEvent,
        });
        expect(completed.content).toMatchObject([{ text: 'complete' }]);
    });

    test('interrupting a parked reply closes every unfinished call', async () => {
        const tool = new TestTool('Confirm', { decision: PermissionBehavior.ASK });
        const model = new QueueModel();
        model.responses.push(
            response([ToolCallBlock({ id: 'pending', name: 'Confirm', input: '{}' })])
        );
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'p',
            model,
            toolkit: new Toolkit({ tools: [tool] }),
            injectionConfig: { injectRuntimeState: false },
        });
        await collect(agent);
        const interrupted = await collect(agent, {
            event: createEvent({
                type: EventType.USER_INTERRUPT,
                reply_id: agent.state.replyId,
            }) as UserInterruptEvent,
        });
        expect(interrupted.events.at(-1)).toMatchObject({
            type: EventType.REPLY_END,
            finished_reason: 'interrupted',
        });
        expect(interrupted.final).toMatchObject({ finished_reason: 'interrupted' });
        expect(getContentBlocks(agent.context.at(-1)!, 'tool_result')).toMatchObject([
            { id: 'pending', state: 'interrupted' },
        ]);
    });

    test('idle interrupt is a silent no-op', async () => {
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'p',
            model: new QueueModel(),
            injectionConfig: { injectRuntimeState: false },
        });
        await expect(
            agent.reply({
                event: createEvent({
                    type: EventType.USER_INTERRUPT,
                    reply_id: agent.state.replyId,
                }) as UserInterruptEvent,
            })
        ).rejects.toThrow('did not produce a final message');
    });

    test('structured output validates, fills JSON-schema defaults, and unmounts', async () => {
        const schema = {
            type: 'object',
            properties: {
                answer: { type: 'string' },
                count: { type: 'integer', default: 3 },
            },
            required: ['answer'],
            additionalProperties: false,
        };
        const model = new QueueModel();
        model.responses.push(
            response([
                ToolCallBlock({
                    id: 'structured',
                    name: 'GenerateStructuredOutput',
                    input: '{"answer":"yes"}',
                }),
            ]),
            response([TextBlock({ text: 'regular' })])
        );
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'p',
            model,
            injectionConfig: { injectRuntimeState: false },
        });
        const structured = await agent.reply({ structuredSchema: schema });
        expect(structured.structured_output).toEqual({ answer: 'yes', count: 3 });
        expect(await agent.toolkit.getTool('GenerateStructuredOutput')).not.toBeNull();
        const regular = await agent.reply();
        expect(regular.content).toMatchObject([{ text: 'regular' }]);
        expect(await agent.toolkit.getTool('GenerateStructuredOutput')).toBeNull();
    });

    test('invalid structured output produces an error result and retries', async () => {
        const schema = z.object({ answer: z.string() });
        const model = new QueueModel();
        model.responses.push(
            response([
                ToolCallBlock({
                    id: 'invalid',
                    name: 'GenerateStructuredOutput',
                    input: '{"answer":1}',
                }),
            ]),
            response([
                ToolCallBlock({
                    id: 'valid',
                    name: 'GenerateStructuredOutput',
                    input: '{"answer":"yes"}',
                }),
            ])
        );
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'p',
            model,
            injectionConfig: { injectRuntimeState: false },
        });
        const final = await agent.reply({ structuredSchema: schema });
        expect(final.structured_output).toEqual({ answer: 'yes' });
        expect(getContentBlocks(agent.context.at(-1)!, 'tool_result')).toMatchObject([
            { id: 'invalid', state: 'error' },
            { id: 'valid', state: 'success' },
        ]);
    });

    test('serialized structured schema can resume from AgentState', async () => {
        const state = parseAgentState(
            new AgentState({
                replyContext: undefined,
            }).toJSON()
        );
        state.replyContext.structuredSchema = {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
        };
        const model = new QueueModel();
        model.responses.push(
            response([
                ToolCallBlock({
                    id: 'value',
                    name: 'GenerateStructuredOutput',
                    input: '{"value":"persisted"}',
                }),
            ])
        );
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'p',
            model,
            state,
            injectionConfig: { injectRuntimeState: false },
        });
        const final = await agent.reply({ structuredSchema: state.replyContext.structuredSchema });
        expect(final.structured_output).toEqual({ value: 'persisted' });
    });
});
