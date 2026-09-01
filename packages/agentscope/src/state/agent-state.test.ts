import { z } from 'zod';

import { setIdFactory, setTimestampFactory } from '../_utils/common';
import { TextBlock, ToolCallBlock, ToolResultBlock } from '../message';
import { AgentState, ReplyContext, parseAgentState } from './agent-state';

describe('AgentState', () => {
    beforeEach(() => {
        setIdFactory(() => 'generated-id');
        setTimestampFactory(() => '2026-09-01T12:34:56.123456');
    });

    afterEach(() => {
        setIdFactory(() => crypto.randomUUID().replaceAll('-', ''));
        setTimestampFactory(() => new Date().toISOString());
    });

    test('fills every Python state default and serializes snake_case', () => {
        expect(new AgentState().toJSON()).toEqual({
            session_id: 'generated-id',
            summary: '',
            context: [],
            reply_context: {
                reply_id: 'generated-id',
                cur_iter: 0,
                structured_schema: null,
                structured_output: null,
            },
            permission_context: {
                mode: 'default',
                working_directories: {},
                allow_rules: {},
                deny_rules: {},
                ask_rules: {},
            },
            tool_context: {
                max_cache_files: 100,
                max_cache_bytes: 25_000,
                read_file_cache: [],
                activated_groups: [],
            },
            tasks_context: { tasks: [] },
            middle_context: {},
        });
    });

    test('migrates legacy reply fields without overriding nested values', () => {
        const migrated = parseAgentState({
            session_id: 'session',
            reply_id: 'legacy-reply',
            cur_iter: 3,
        });
        expect(migrated.replyId).toBe('legacy-reply');
        expect(migrated.curIter).toBe(3);

        const nestedWins = parseAgentState({
            reply_id: 'legacy-reply',
            cur_iter: 3,
            reply_context: { reply_id: 'nested-reply', cur_iter: 4 },
        });
        expect(nestedWins.replyId).toBe('nested-reply');
        expect(nestedWins.curIter).toBe(4);
    });

    test('serializes an in-process Zod structured schema for persistence', () => {
        const state = new AgentState({
            replyContext: new ReplyContext({
                structuredSchema: z.object({ city: z.string(), temperature: z.number() }),
            }),
        });
        expect(state.toJSON().reply_context.structured_schema).toMatchObject({
            type: 'object',
            required: ['city', 'temperature'],
        });
    });

    test('appends blocks into one current assistant message', () => {
        const state = new AgentState({ sessionId: 'session' });
        state.replyId = 'reply';
        state.appendContext({ name: 'Friday', blocks: [TextBlock({ text: 'one' })] });
        state.appendContext({ name: 'Friday', blocks: [TextBlock({ text: 'two' })] });
        state.appendContext({ name: 'Other', blocks: [TextBlock({ text: 'three' })] });

        expect(state.context).toHaveLength(2);
        expect(state.context[0].content).toHaveLength(2);
        expect(state.context[0].id).toBe('reply');
        expect(state.context[1].name).toBe('Other');
    });

    test('finds awaiting and unfinished tool calls with Python tail semantics', () => {
        const state = new AgentState();
        state.replyId = 'reply';
        const asking = ToolCallBlock({ id: 'asking', name: 'a', input: '', state: 'asking' });
        const submitted = ToolCallBlock({
            id: 'submitted',
            name: 'b',
            input: '',
            state: 'submitted',
        });
        const resolved = ToolCallBlock({
            id: 'resolved',
            name: 'c',
            input: '',
            state: 'submitted',
        });
        state.appendContext({
            name: 'Friday',
            blocks: [
                asking,
                submitted,
                resolved,
                ToolResultBlock({ id: 'resolved', name: 'c', output: 'ok', state: 'success' }),
            ],
        });

        expect(state.hasAwaitingToolCalls({ name: 'Friday' })).toBe(true);
        expect(state.getAwaitingToolCalls({ name: 'Friday' }).map(call => call.id)).toEqual([
            'asking',
            'submitted',
        ]);
        expect(state.getUnfinishedToolCalls({ name: 'Friday' }).map(call => call.id)).toEqual([
            'asking',
            'submitted',
        ]);
        expect(state.getAwaitingToolCalls({ name: 'Other' })).toEqual([]);
    });

    test('round-trips a full state wire payload', () => {
        const state = new AgentState({
            sessionId: 'session',
            middleContext: { trace: 'value' },
        });
        state.appendContext({ name: 'Friday', blocks: [TextBlock({ text: 'hello' })] });
        expect(parseAgentState(state.toJSON()).toJSON()).toEqual(state.toJSON());
    });
});
