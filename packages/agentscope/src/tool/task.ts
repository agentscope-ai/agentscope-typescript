/* eslint-disable jsdoc/require-jsdoc */

import { z } from 'zod';

import { DeveloperOrientedException } from '../exception';
import { TextBlock } from '../message';
import type { PermissionDecision } from '../permission';
import { PermissionBehavior, createPermissionDecision } from '../permission';
import { AgentState, createTask } from '../state';
import { ToolBase } from './base';
import { ToolChunk } from './response';

abstract class TaskToolBase extends ToolBase {
    readonly isConcurrencySafe = true;
    readonly isReadOnly = false;
    override isStateInjected = true;

    async checkPermissions(): Promise<PermissionDecision> {
        return createPermissionDecision({
            behavior: PermissionBehavior.ALLOW,
            message: `${this.name} is always allowed to be called.`,
        });
    }

    protected state(input: Record<string, unknown>): AgentState {
        if (!(input._agent_state instanceof AgentState)) {
            throw new DeveloperOrientedException(
                `Error: ${this.name} requires AgentState to be provided, got ${String(input._agent_state)} instead.`
            );
        }
        return input._agent_state;
    }
}

/** Create one task in the current AgentState. */
export class TaskCreateTool extends TaskToolBase {
    readonly name = 'TaskCreate';
    readonly description = 'Create a structured task in the current agent session.';
    readonly inputSchema = z.object({
        subject: z.string(),
        description: z.string(),
        metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    });

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const parsed = this.inputSchema.parse(input);
        const state = this.state(input);
        let maximum = 0;
        for (const task of state.tasksContext.tasks) {
            const numeric = Number(task.id);
            if (Number.isInteger(numeric)) maximum = Math.max(maximum, numeric);
        }
        const id = String(maximum + 1);
        state.tasksContext.tasks.push(
            createTask({
                id,
                subject: parsed.subject,
                description: parsed.description,
                metadata: parsed.metadata ?? {},
            })
        );
        return chunk(`Task (id=${id}) created successfully: ${parsed.subject}`);
    }
}

/** Retrieve one task from the current AgentState. */
export class TaskGetTool extends TaskToolBase {
    readonly name = 'TaskGet';
    readonly description = 'Retrieve a task by its ID from the task list.';
    readonly inputSchema = z.object({ task_id: z.string() });

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const parsed = this.inputSchema.parse(input);
        const task = this.state(input).tasksContext.tasks.find(
            value => value.id === parsed.task_id
        );
        if (!task) return chunk('Task not found', 'error');
        const lines = [
            `Task (id=${task.id}): ${task.subject}`,
            `Status: ${task.state}`,
            `Description: ${task.description}`,
        ];
        if (task.owner) lines.push(`Owner: ${task.owner}`);
        if (task.blocked_by.length) {
            lines.push(`Blocked by: ${task.blocked_by.map(id => `#${id}`).join(', ')}`);
        }
        if (task.blocks.length) lines.push(`Blocks: ${task.blocks.map(id => `#${id}`).join(', ')}`);
        if (Object.keys(task.metadata).length)
            lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);
        return chunk(lines.join('\n'));
    }
}

/** List all tasks from the current AgentState. */
export class TaskListTool extends TaskToolBase {
    readonly name = 'TaskList';
    readonly description = 'List all tasks in the current agent session.';
    readonly inputSchema = z.object({});

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const tasks = this.state(input).tasksContext.tasks;
        if (!tasks.length) return chunk('No tasks available.');
        return chunk(
            tasks
                .map(task => {
                    const owner = task.owner ? `(${task.owner})` : '';
                    const blocked = task.blocked_by.length
                        ? `[blocked by ${task.blocked_by.join(', ')}]`
                        : '';
                    return `${task.id} [${task.state}] ${task.subject}${owner}${blocked}`;
                })
                .join('\n')
        );
    }
}

/** Update task fields, relationships, status, or deletion. */
export class TaskUpdateTool extends TaskToolBase {
    readonly name = 'TaskUpdate';
    readonly description = 'Update a task in the current agent session.';
    readonly inputSchema = z.object({
        task_id: z.string(),
        subject: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        add_blocks: z.array(z.string()).nullable().optional(),
        status: z.enum(['pending', 'in_progress', 'completed', 'deleted']).nullable().optional(),
        add_blocked_by: z.array(z.string()).nullable().optional(),
        owner: z.string().nullable().optional(),
        metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    });

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const parsed = this.inputSchema.parse(input);
        const state = this.state(input);
        const index = state.tasksContext.tasks.findIndex(task => task.id === parsed.task_id);
        if (index === -1) {
            return chunk(
                `TaskNotFoundError: The task (id=${parsed.task_id}) does not exist.`,
                'error'
            );
        }
        const task = state.tasksContext.tasks[index];
        const updated: string[] = [];
        if (parsed.subject) {
            task.subject = parsed.subject;
            updated.push('subject');
        }
        if (parsed.description !== undefined && parsed.description !== null) {
            task.description = parsed.description;
            updated.push('description');
        }
        const ids = new Set(state.tasksContext.tasks.map(value => value.id));
        const addRelation = (blocker: string, blocked: string): void => {
            const blockerTask = state.tasksContext.tasks.find(value => value.id === blocker);
            const blockedTask = state.tasksContext.tasks.find(value => value.id === blocked);
            if (blockerTask && !blockerTask.blocks.includes(blocked))
                blockerTask.blocks.push(blocked);
            if (blockedTask && !blockedTask.blocked_by.includes(blocker)) {
                blockedTask.blocked_by.push(blocker);
            }
        };
        const blocks = (parsed.add_blocks ?? []).filter(
            id => ids.has(id) && !task.blocks.includes(id)
        );
        if (blocks.length) {
            updated.push('add_blocks');
            blocks.forEach(id => addRelation(task.id, id));
        }
        const blockedBy = (parsed.add_blocked_by ?? []).filter(
            id => ids.has(id) && !task.blocked_by.includes(id)
        );
        if (blockedBy.length) {
            updated.push('add_blocked_by');
            blockedBy.forEach(id => addRelation(id, task.id));
        }
        if (parsed.status === 'deleted') {
            state.tasksContext.tasks.splice(index, 1);
            for (const value of state.tasksContext.tasks) {
                value.blocks = value.blocks.filter(id => id !== parsed.task_id);
                value.blocked_by = value.blocked_by.filter(id => id !== parsed.task_id);
            }
            return chunk(`Task (id=${parsed.task_id}) has been deleted.`);
        }
        if (parsed.status) {
            task.state = parsed.status;
            updated.push('status');
        }
        if (parsed.owner !== undefined) {
            task.owner = parsed.owner;
            updated.push('owner');
        }
        if (parsed.metadata && Object.keys(parsed.metadata).length) {
            updated.push('metadata');
            for (const [key, value] of Object.entries(parsed.metadata)) {
                if (value === null) delete task.metadata[key];
                else task.metadata[key] = value;
            }
        }
        let message = updated.length
            ? `Update task (id=${parsed.task_id}) ${updated.join(', ')}.`
            : `No updates were made to the task (id=${parsed.task_id}). Make sure you provided at least one field to update and the values are correct.`;
        if (task.state === 'completed') {
            message +=
                '\n\nTask completed. Call TaskList now to find your next available task or see if your work unblocked others.';
        }
        return chunk(message);
    }
}

export function TaskCreate(): TaskCreateTool {
    return new TaskCreateTool();
}
export function TaskGet(): TaskGetTool {
    return new TaskGetTool();
}
export function TaskList(): TaskListTool {
    return new TaskListTool();
}
export function TaskUpdate(): TaskUpdateTool {
    return new TaskUpdateTool();
}

/** Legacy no-op: task storage now correctly belongs to AgentState. */
export function _resetTaskStore(): void {}

function chunk(text: string, state: 'running' | 'error' = 'running'): ToolChunk {
    return new ToolChunk({ content: [TextBlock({ text })], state });
}
