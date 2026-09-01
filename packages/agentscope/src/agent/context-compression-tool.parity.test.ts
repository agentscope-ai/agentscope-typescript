/* eslint-disable jsdoc/require-jsdoc */

import { Agent } from './agent';
import { QueueModel, response } from './test-helpers';
import { TextBlock, ToolCallBlock, UserMsg, AssistantMsg } from '../message';
import type { Msg } from '../message';
import { StructuredResponse } from '../model';
import type { ChatModelCallStructuredOptions } from '../model/base';
import { AgentState } from '../state';
import { Toolkit, ToolChunk } from '../tool';

const SUMMARY = {
    task_overview: 'task',
    current_state: 'complete',
    important_discoveries: 'none',
    next_steps: 'continue',
    context_to_preserve: 'none',
};

class CompressionModel extends QueueModel {
    tokenCount = 700;
    structuredError: Error | null = null;

    override async countTokens(): Promise<number> {
        return this.tokenCount;
    }

    override async generateStructuredOutput(
        _options: ChatModelCallStructuredOptions
    ): Promise<StructuredResponse> {
        if (this.structuredError) throw this.structuredError;
        return new StructuredResponse({ content: SUMMARY });
    }
}

function context(): Msg[] {
    return [0, 1, 2, 3].map(index =>
        UserMsg({ id: `${index}`, name: 'user', content: `${index}`.repeat(80) })
    );
}

function createCompressionAgent(model: CompressionModel, state = new AgentState()): Agent {
    state.context = state.context.length ? state.context : context();
    return new Agent({
        name: 'Friday',
        systemPrompt: 'You are helpful.',
        model,
        toolkit: new Toolkit(),
        state,
        contextConfig: {
            triggerRatio: 0.8,
            reserveRatio: 0.1,
            contextBufferRatio: 0.2,
            compressionToolEnabled: true,
        },
        injectionConfig: { injectRuntimeState: false },
    });
}

async function callCompressionTool(agent: Agent): Promise<ToolChunk> {
    return (
        agent as unknown as {
            compressContextTool(): Promise<ToolChunk>;
        }
    ).compressContextTool();
}

describe('agent-driven context compression parity', () => {
    test('compresses at the recommendation threshold below the hard threshold', async () => {
        const model = new CompressionModel({ contextSize: 1_000 });
        const agent = createCompressionAgent(model);

        expect((await callCompressionTool(agent)).toJSON()).toMatchObject({
            content: [{ type: 'text', text: 'Context compressed successfully.' }],
            state: 'success',
            is_last: true,
        });
        expect(agent.state.summary).toContain('# Current State\ncomplete');
        expect(agent.state.context.map(message => message.id)).toEqual(['3']);
    });

    test('leaves a small context unchanged', async () => {
        const model = new CompressionModel({ contextSize: 1_000 });
        model.tokenCount = 600;
        const agent = createCompressionAgent(model);
        const before = structuredClone(agent.state.context);

        expect((await callCompressionTool(agent)).toJSON()).toMatchObject({
            content: [
                {
                    type: 'text',
                    text: 'The context is not long enough to compress, so it remains unchanged.',
                },
            ],
            state: 'success',
        });
        expect(agent.state.context).toEqual(before);
        expect(agent.state.summary).toBe('');
    });

    test('can preserve context on summary failure and report the tool error', async () => {
        const model = new CompressionModel({ contextSize: 1_000 });
        model.structuredError = new Error('simulated compression overflow');
        model.tokenCount = 900;
        const agent = createCompressionAgent(model);
        agent.contextConfig.compressionFallbackToTruncation = false;
        const before = structuredClone(agent.state.context);

        await expect(agent.compressContext()).rejects.toThrow('simulated compression overflow');
        expect(agent.state.context).toEqual(before);
        expect((await callCompressionTool(agent)).toJSON()).toMatchObject({
            content: [
                {
                    type: 'text',
                    text: 'Context compression failed: simulated compression overflow',
                },
            ],
            state: 'error',
        });
    });

    test('registers one stable allowed tool and recommends it only between tasks', async () => {
        const model = new CompressionModel({ contextSize: 1_000 });
        model.responses.push(
            response([TextBlock({ text: 'done' })]),
            response([TextBlock({ text: 'done again' })])
        );
        const agent = new Agent({
            name: 'Friday',
            systemPrompt: 'You are helpful.',
            model,
            toolkit: new Toolkit(),
            contextConfig: { compressionToolEnabled: true },
        });

        await agent.reply({ inputs: UserMsg({ name: 'user', content: 'hello' }) });
        const tool = await agent.toolkit.getTool('CompressContext');
        expect(tool).not.toBeNull();
        expect(
            agent.state.context
                .flatMap(message => message.content)
                .find(block => block.type === 'hint')
        ).toEqual(
            expect.objectContaining({
                type: 'hint',
                hint: expect.stringContaining('calling `CompressContext`'),
            })
        );
        await agent.reply({ inputs: UserMsg({ name: 'user', content: 'again' }) });
        expect(await agent.toolkit.getTool('CompressContext')).toBe(tool);

        const busyModel = new CompressionModel({ contextSize: 1_000 });
        busyModel.responses.push(response([TextBlock({ text: 'done' })]));
        const busyState = new AgentState();
        busyState.tasksContext.tasks.push({
            id: 'task',
            subject: 'task',
            description: 'task',
            state: 'in_progress',
            metadata: {},
            created_at: '2026-01-01T00:00:00Z',
            owner: null,
            blocks: [],
            blocked_by: [],
        });
        const busy = new Agent({
            name: 'Friday',
            systemPrompt: 'You are helpful.',
            model: busyModel,
            state: busyState,
            contextConfig: { compressionToolEnabled: true },
        });
        await busy.reply({ inputs: UserMsg({ name: 'user', content: 'work' }) });
        const hint = busy.state.context
            .flatMap(message => message.content)
            .find(block => block.type === 'hint');
        expect(hint && hint.type === 'hint' ? hint.hint : '').not.toContain('CompressContext');
    });

    test('keeps an unfinished compression call in retained context', async () => {
        const model = new CompressionModel({ contextSize: 1_000 });
        const state = new AgentState({
            context: [
                ...context(),
                AssistantMsg({
                    id: 'reply',
                    name: 'Friday',
                    content: [
                        ToolCallBlock({ id: 'compress', name: 'CompressContext', input: '{}' }),
                    ],
                }),
            ],
        });
        state.replyId = 'reply';
        const agent = createCompressionAgent(model, state);

        await callCompressionTool(agent);

        expect(
            agent.state.context.flatMap(message =>
                message.content.filter(block => block.type === 'tool_call')
            )
        ).toEqual([expect.objectContaining({ id: 'compress', name: 'CompressContext' })]);
    });
});
