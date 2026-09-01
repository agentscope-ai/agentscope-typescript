import { Agent } from './agent';
import { ContextConfig, InjectionConfig, ReActConfig } from './config';
import { QueueModel, TestTool, response, streamResponse } from './test-helpers';
import { EventType } from '../event';
import { TextBlock, ThinkingBlock, ToolCallBlock, UserMsg, getContentBlocks } from '../message';
import { ChatResponse, ChatUsage } from '../model';
import { AgentState } from '../state';
import { Toolkit } from '../tool';
import { ToolChoice } from '../tool/types';

describe('Agent core Python parity', () => {
    test('configuration defaults are isolated and invalid ratios are rejected', () => {
        const first = new Agent({ name: 'a', systemPrompt: 'p', model: new QueueModel() });
        const second = new Agent({ name: 'b', systemPrompt: 'p', model: new QueueModel() });
        first.reactConfig.maxIters = 3;
        expect(second.reactConfig.maxIters).toBe(50);
        expect(
            () =>
                new Agent({
                    name: 'a',
                    systemPrompt: 'p',
                    model: new QueueModel(),
                    contextConfig: new ContextConfig({ triggerRatio: 0.5, reserveRatio: 0.5 }),
                })
        ).toThrow('reserveRatio');
        expect(() => new InjectionConfig({ template: 'missing' })).toThrow('runtime_state');
        expect(new ContextConfig({ toolResultLimit: -1 }).toolResultLimit).toBe(-1);
        expect(new ReActConfig({ maxIters: -1 }).maxIters).toBe(-1);
        expect(new ContextConfig().compressionPrompt).toContain(
            'The current time is {current_time}.\nThis summary may itself be summarized'
        );
    });

    test('non-streaming reasoning emits a complete event lifecycle and usage', async () => {
        const model = new QueueModel();
        model.responses.push(
            response([TextBlock({ text: 'hello' })], {
                usage: new ChatUsage({
                    inputTokens: 11,
                    outputTokens: 7,
                    time: 0,
                    cacheInputTokens: 3,
                    cacheCreationInputTokens: 2,
                }),
            })
        );
        const agent = new Agent({
            name: 'Friday',
            systemPrompt: 'help',
            model,
            injectionConfig: { injectRuntimeState: false },
        });
        const events = [];
        const stream = agent.replyStream({ msgs: UserMsg({ name: 'user', content: 'hi' }) });
        let final;
        while (true) {
            const item = await stream.next();
            if (item.done) {
                final = item.value;
                break;
            }
            events.push(item.value);
        }
        expect(events.map(event => event.type)).toEqual([
            EventType.REPLY_START,
            EventType.MODEL_CALL_START,
            EventType.TEXT_BLOCK_START,
            EventType.TEXT_BLOCK_DELTA,
            EventType.TEXT_BLOCK_END,
            EventType.MODEL_CALL_END,
            EventType.REPLY_END,
        ]);
        expect(events.at(-2)).toMatchObject({
            input_tokens: 11,
            output_tokens: 7,
            cache_input_tokens: 3,
            cache_creation_input_tokens: 2,
        });
        expect(final).toMatchObject({
            id: agent.state.replyId,
            content: [{ type: 'text', text: 'hello' }],
            usage: {
                input_tokens: 11,
                output_tokens: 7,
                cache_input_tokens: 3,
                cache_creation_input_tokens: 2,
            },
        });
    });

    test('streaming closes active blocks and uses the terminal response', async () => {
        const model = new QueueModel();
        model.responses.push(
            streamResponse(
                [
                    new ChatResponse({
                        content: [ThinkingBlock({ thinking: 'consider' })],
                        isLast: false,
                    }),
                    new ChatResponse({
                        content: [TextBlock({ text: 'answer' })],
                        isLast: false,
                    }),
                ],
                response([ThinkingBlock({ thinking: 'consider' }), TextBlock({ text: 'answer' })])
            )
        );
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'p',
            model,
            injectionConfig: { injectRuntimeState: false },
        });
        const types = [];
        for await (const event of agent.replyStream()) types.push(event.type);
        expect(types).toEqual([
            EventType.REPLY_START,
            EventType.MODEL_CALL_START,
            EventType.THINKING_BLOCK_START,
            EventType.THINKING_BLOCK_DELTA,
            EventType.THINKING_BLOCK_END,
            EventType.TEXT_BLOCK_START,
            EventType.TEXT_BLOCK_DELTA,
            EventType.TEXT_BLOCK_END,
            EventType.MODEL_CALL_END,
            EventType.REPLY_END,
        ]);
    });

    test('thinking-only responses continue and max iterations force text-only finalization', async () => {
        const model = new QueueModel();
        model.responses.push(
            response([ThinkingBlock({ thinking: 'one' })]),
            response([ThinkingBlock({ thinking: 'two' })]),
            response([TextBlock({ text: 'final' })])
        );
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'p',
            model,
            reactConfig: new ReActConfig({ maxIters: 2 }),
            injectionConfig: { injectRuntimeState: false },
        });
        const final = await agent.reply();
        expect(final.content).toMatchObject([{ type: 'text', text: 'final' }]);
        expect(model.calls).toHaveLength(3);
        expect(model.calls.at(-1)?.normalizedToolChoice).toEqual(new ToolChoice({ mode: 'none' }));
    });

    test('sequential and concurrent tool batches preserve ReAct round counting', async () => {
        const sequential = new TestTool('Sequential', { concurrencySafe: false });
        const first = new TestTool('First', { delay: 15 });
        const second = new TestTool('Second', { delay: 1 });
        const model = new QueueModel();
        model.responses.push(
            response([
                ToolCallBlock({ id: 's', name: 'Sequential', input: '{"value":"s"}' }),
                ToolCallBlock({ id: 'a', name: 'First', input: '{"value":"a"}' }),
                ToolCallBlock({ id: 'b', name: 'Second', input: '{"value":"b"}' }),
            ]),
            response([TextBlock({ text: 'done' })])
        );
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'p',
            model,
            toolkit: new Toolkit({ tools: [sequential, first, second] }),
            injectionConfig: { injectRuntimeState: false },
        });
        const events = [];
        for await (const event of agent.replyStream()) events.push(event);
        expect(sequential.calls).toEqual(['s']);
        expect(first.calls).toEqual(['a']);
        expect(second.calls).toEqual(['b']);
        expect(agent.state.curIter).toBe(2);
        expect(
            events
                .filter(event => event.type === EventType.TOOL_RESULT_END)
                .map(event => (event.type === EventType.TOOL_RESULT_END ? event.tool_call_id : ''))
        ).toEqual(['s', 'b', 'a']);
    });

    test('runtime injection is persistent, configurable, and independently emits a hint event', async () => {
        const model = new QueueModel();
        model.responses.push(response([TextBlock({ text: 'done' })]));
        const state = new AgentState();
        state.tasksContext.tasks.push({
            id: 'task',
            subject: 'task',
            description: 'task',
            state: 'pending',
            metadata: {},
            created_at: '2026-01-01T00:00:00Z',
            owner: null,
            blocks: [],
            blocked_by: [],
        });
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'p',
            model,
            state,
            injectionConfig: { extraFields: { project: 'agentscope' } },
        });
        const events = [];
        for await (const event of agent.replyStream()) events.push(event);
        expect(events.some(event => event.type === EventType.HINT_BLOCK)).toBe(true);
        const hint = getContentBlocks(agent.context[0], 'hint')[0];
        expect(hint.hint).toEqual(expect.stringContaining('<current-time>'));
        expect(hint.hint).toEqual(expect.stringContaining('<tasks>'));
        expect(hint.hint).toEqual(expect.stringContaining('<project>agentscope</project>'));
    });
});
