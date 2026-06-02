import { Tool } from './base';
import { ToolResponse } from './response';
import { TaskCreate, TaskUpdate, TaskGet, TaskList, _resetTaskStore } from './task';

describe('Task Tools', () => {
    let taskCreate: Tool;
    let taskUpdate: Tool;
    let taskGet: Tool;
    let taskList: Tool;

    beforeEach(() => {
        _resetTaskStore();
        taskCreate = TaskCreate();
        taskUpdate = TaskUpdate();
        taskGet = TaskGet();
        taskList = TaskList();
    });

    const getTextFromResponse = (response: ToolResponse): string => {
        const textBlock = response.content.find(block => block.type === 'text');
        return textBlock && 'text' in textBlock ? textBlock.text : '';
    };

    describe('TaskCreate', () => {
        it('creates a task with pending state', () => {
            const response = taskCreate.call!({
                subject: 'Fix bug',
                description: 'Fix the authentication bug',
            }) as ToolResponse;
            const result = getTextFromResponse(response);
            expect(result).toContain('Task 1 created successfully');
            expect(result).toContain('Fix bug');
        });

        it('increments task IDs', () => {
            taskCreate.call!({ subject: 'Task 1', description: 'First task' });
            const response = taskCreate.call!({
                subject: 'Task 2',
                description: 'Second task',
            }) as ToolResponse;
            const result = getTextFromResponse(response);
            expect(result).toContain('Task 2 created successfully');
        });

        it('supports optional metadata', () => {
            const response = taskCreate.call!({
                subject: 'Run tests',
                description: 'Execute test suite',
                metadata: { priority: 'high' },
            }) as ToolResponse;
            const result = getTextFromResponse(response);
            expect(result).toContain('Task 1 created successfully');
        });
    });

    describe('TaskUpdate', () => {
        beforeEach(() => {
            taskCreate.call!({ subject: 'Task 1', description: 'First task' });
        });

        it('updates task state', () => {
            const response = taskUpdate.call!({
                taskId: '1',
                status: 'in_progress',
            }) as ToolResponse;
            const result = getTextFromResponse(response);
            expect(result).toContain('Task 1 updated successfully');

            // Verify the update by getting the task
            const getResponse = taskGet.call!({ taskId: '1' }) as ToolResponse;
            const getResult = getTextFromResponse(getResponse);
            expect(getResult).toContain('State: in_progress');
        });

        it('updates task subject and description', () => {
            taskUpdate.call!({
                taskId: '1',
                subject: 'Updated subject',
                description: 'Updated description',
            });

            const getResponse = taskGet.call!({ taskId: '1' }) as ToolResponse;
            const result = getTextFromResponse(getResponse);
            expect(result).toContain('Updated subject');
            expect(result).toContain('Updated description');
        });

        it('merges metadata', () => {
            taskUpdate.call!({
                taskId: '1',
                metadata: { key1: 'value1', key2: 'value2' },
            });

            taskUpdate.call!({
                taskId: '1',
                metadata: { key2: 'updated', key3: 'value3' },
            });

            const getResponse = taskGet.call!({ taskId: '1' }) as ToolResponse;
            const result = getTextFromResponse(getResponse);
            expect(result).toContain('key1');
            expect(result).toContain('value1');
            expect(result).toContain('key2');
            expect(result).toContain('updated');
            expect(result).toContain('key3');
        });

        it('deletes metadata keys when set to null', () => {
            taskUpdate.call!({
                taskId: '1',
                metadata: { key1: 'value1', key2: 'value2' },
            });

            taskUpdate.call!({
                taskId: '1',
                metadata: { key1: null },
            });

            const getResponse = taskGet.call!({ taskId: '1' }) as ToolResponse;
            const result = getTextFromResponse(getResponse);
            expect(result).not.toContain('key1');
            expect(result).toContain('key2');
        });

        it('adds task dependencies', () => {
            taskCreate.call!({ subject: 'Task 2', description: 'Second task' });

            taskUpdate.call!({
                taskId: '1',
                addBlocks: ['2'],
            });

            taskUpdate.call!({
                taskId: '2',
                addBlockedBy: ['1'],
            });

            const getResponse = taskGet.call!({ taskId: '1' }) as ToolResponse;
            const result = getTextFromResponse(getResponse);
            expect(result).toContain('Blocks: 2');

            const getResponse2 = taskGet.call!({ taskId: '2' }) as ToolResponse;
            const result2 = getTextFromResponse(getResponse2);
            expect(result2).toContain('Blocked By: 1');
        });

        it('deduplicates dependencies', () => {
            taskCreate.call!({ subject: 'Task 2', description: 'Second task' });

            taskUpdate.call!({
                taskId: '1',
                addBlocks: ['2'],
            });

            taskUpdate.call!({
                taskId: '1',
                addBlocks: ['2'],
            });

            const getResponse = taskGet.call!({ taskId: '1' }) as ToolResponse;
            const result = getTextFromResponse(getResponse);
            // Should only appear once
            expect(result.match(/Blocks: 2/g)?.length).toBe(1);
        });

        it('throws on non-existent task', () => {
            expect(() => taskUpdate.call!({ taskId: '999', status: 'completed' })).toThrow(
                'Task not found: 999'
            );
        });

        it('throws when adding non-existent dependency', () => {
            expect(() => taskUpdate.call!({ taskId: '1', addBlocks: ['999'] })).toThrow(
                'Cannot add dependency: task 999 does not exist'
            );
        });

        it('deletes task when status is deleted', () => {
            const response = taskUpdate.call!({
                taskId: '1',
                status: 'deleted',
            }) as ToolResponse;
            const result = getTextFromResponse(response);
            expect(result).toContain('Task 1 deleted successfully');

            // Verify task is gone
            expect(() => taskGet.call!({ taskId: '1' })).toThrow('Task not found: 1');
        });
    });

    describe('TaskGet', () => {
        it('returns full task details', () => {
            taskCreate.call!({
                subject: 'Test task',
                description: 'Test description',
                metadata: { priority: 'high' },
            });

            const response = taskGet.call!({ taskId: '1' }) as ToolResponse;
            const result = getTextFromResponse(response);

            expect(result).toContain('Task 1: Test task');
            expect(result).toContain('State: pending');
            expect(result).toContain('Description: Test description');
            expect(result).toContain('priority');
            expect(result).toContain('high');
            expect(result).toContain('Created:');
        });

        it('throws on non-existent task', () => {
            expect(() => taskGet.call!({ taskId: '999' })).toThrow('Task not found: 999');
        });
    });

    describe('TaskList', () => {
        it('returns empty message when no tasks exist', () => {
            const response = taskList.call!({}) as ToolResponse;
            const result = getTextFromResponse(response);
            expect(result).toBe('No tasks available.');
        });

        it('lists pending and in_progress tasks', () => {
            taskCreate.call!({ subject: 'Task 1', description: 'First' });
            taskCreate.call!({ subject: 'Task 2', description: 'Second' });
            taskUpdate.call!({ taskId: '2', status: 'in_progress' });

            const response = taskList.call!({}) as ToolResponse;
            const result = getTextFromResponse(response);

            expect(result).toContain('1 [pending] Task 1');
            expect(result).toContain('2 [in_progress] Task 2');
        });

        it('filters out completed tasks', () => {
            taskCreate.call!({ subject: 'Task 1', description: 'First' });
            taskCreate.call!({ subject: 'Task 2', description: 'Second' });
            taskUpdate.call!({ taskId: '1', status: 'completed' });

            const response = taskList.call!({}) as ToolResponse;
            const result = getTextFromResponse(response);

            expect(result).not.toContain('Task 1');
            expect(result).toContain('2 [pending] Task 2');
        });

        it('filters out deleted tasks', () => {
            taskCreate.call!({ subject: 'Task 1', description: 'First' });
            taskCreate.call!({ subject: 'Task 2', description: 'Second' });
            taskUpdate.call!({ taskId: '1', status: 'deleted' });

            const response = taskList.call!({}) as ToolResponse;
            const result = getTextFromResponse(response);

            expect(result).not.toContain('Task 1');
            expect(result).toContain('2 [pending] Task 2');
        });

        it('shows blocked tasks with dependencies', () => {
            taskCreate.call!({ subject: 'Task 1', description: 'First' });
            taskCreate.call!({ subject: 'Task 2', description: 'Second' });
            taskUpdate.call!({ taskId: '2', addBlockedBy: ['1'] });

            const response = taskList.call!({}) as ToolResponse;
            const result = getTextFromResponse(response);

            expect(result).toContain('2 [pending] Task 2[blocked by 1]');
        });

        it('sorts tasks by ID', () => {
            taskCreate.call!({ subject: 'Task 1', description: 'First' });
            taskCreate.call!({ subject: 'Task 2', description: 'Second' });
            taskCreate.call!({ subject: 'Task 3', description: 'Third' });

            const response = taskList.call!({}) as ToolResponse;
            const result = getTextFromResponse(response);

            const lines = result.split('\n');
            expect(lines[0]).toContain('1');
            expect(lines[1]).toContain('2');
            expect(lines[2]).toContain('3');
        });

        it('returns empty when all tasks are completed', () => {
            taskCreate.call!({ subject: 'Task 1', description: 'First' });
            taskCreate.call!({ subject: 'Task 2', description: 'Second' });
            taskUpdate.call!({ taskId: '1', status: 'completed' });
            taskUpdate.call!({ taskId: '2', status: 'completed' });

            const response = taskList.call!({}) as ToolResponse;
            const result = getTextFromResponse(response);

            expect(result).toBe('No tasks available.');
        });
    });
});
