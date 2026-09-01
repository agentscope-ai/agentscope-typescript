import { PermissionBehavior } from '../permission';
import { AgentState, createTask } from '../state';
import type { ToolChunk } from './response';
import { TaskCreate, TaskGet, TaskList, TaskUpdate } from './task';

const text = (chunk: ToolChunk): string =>
    chunk.content[0].type === 'text' ? chunk.content[0].text : '';

describe('Task tools', () => {
    test('create derives sequential numeric IDs from AgentState', async () => {
        const state = new AgentState();
        state.tasksContext.tasks.push(
            createTask({ id: 'legacy', subject: 'old', description: '', metadata: {} }),
            createTask({ id: '4', subject: 'numeric', description: '', metadata: {} })
        );
        const result = await TaskCreate().call({
            subject: 'new',
            description: 'description',
            metadata: { priority: 'high' },
            _agent_state: state,
        });
        expect(text(result)).toBe('Task (id=5) created successfully: new');
        expect(state.tasksContext.tasks.at(-1)).toMatchObject({
            id: '5',
            state: 'pending',
            metadata: { priority: 'high' },
        });
    });

    test('get and list render all Python fields and states', async () => {
        const state = new AgentState();
        state.tasksContext.tasks.push(
            createTask({
                id: '1',
                subject: 'first',
                description: 'details',
                metadata: { priority: 'high' },
                owner: 'agent',
                blocks: ['2'],
            }),
            createTask({
                id: '2',
                subject: 'second',
                description: 'details',
                metadata: {},
                blockedBy: ['1'],
                state: 'completed',
            })
        );
        const details = text(await TaskGet().call({ task_id: '1', _agent_state: state }));
        expect(details).toContain('Task (id=1): first');
        expect(details).toContain('Status: pending');
        expect(details).toContain('Owner: agent');
        expect(details).toContain('Blocks: #2');
        const list = text(await TaskList().call({ _agent_state: state }));
        expect(list).toBe('1 [pending] first(agent)\n2 [completed] second[blocked by 1]');
        expect((await TaskGet().call({ task_id: 'missing', _agent_state: state })).state).toBe(
            'error'
        );
    });

    test('update maintains reciprocal dependencies, metadata, completion, and deletion', async () => {
        const state = new AgentState();
        state.tasksContext.tasks.push(
            createTask({ id: '1', subject: 'first', description: '', metadata: { remove: true } }),
            createTask({ id: '2', subject: 'second', description: '', metadata: {} })
        );
        const updated = await TaskUpdate().call({
            task_id: '1',
            subject: 'updated',
            add_blocks: ['2', 'missing'],
            status: 'completed',
            owner: 'agent',
            metadata: { remove: null, keep: 1 },
            _agent_state: state,
        });
        expect(text(updated)).toContain('subject, add_blocks, status, owner, metadata');
        expect(text(updated)).toContain('Task completed. Call TaskList');
        expect(state.tasksContext.tasks[0]).toMatchObject({
            subject: 'updated',
            blocks: ['2'],
            owner: 'agent',
            metadata: { keep: 1 },
        });
        expect(state.tasksContext.tasks[1].blocked_by).toEqual(['1']);

        expect(
            text(
                await TaskUpdate().call({
                    task_id: '1',
                    status: 'deleted',
                    _agent_state: state,
                })
            )
        ).toBe('Task (id=1) has been deleted.');
        expect(state.tasksContext.tasks[0].blocked_by).toEqual([]);
    });

    test('always allows task tools and requires an injected AgentState', async () => {
        const tool = TaskCreate();
        expect((await tool.checkPermissions()).behavior).toBe(PermissionBehavior.ALLOW);
        await expect(tool.call({ subject: 'x', description: 'x' })).rejects.toThrow(
            'requires AgentState'
        );
        expect(text(await TaskList().call({ _agent_state: new AgentState() }))).toBe(
            'No tasks available.'
        );
    });
});
