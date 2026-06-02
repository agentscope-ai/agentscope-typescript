import { z } from 'zod';

import { createToolResponse, ToolResponse } from './response';
import type { Task } from '../state';

export type { Task, TaskContext } from '../state';

/** Task state — mirrors Python's ``Literal["pending", "in_progress", "completed"]``. */
export type TaskState = Task['state'];

// Module-level storage
const taskStore = new Map<string, Task>();

/**
 * Generate the next sequential task ID based on existing tasks.
 * @returns A unique task ID as a string (e.g. "1", "2", "3").
 */
function generateId(): string {
    let maxNumeric = 0;
    for (const [id] of taskStore) {
        const n = Number(id);
        if (!isNaN(n) && n > maxNumeric) maxNumeric = n;
    }
    return String(maxNumeric + 1);
}

/**
 * Reset task store for testing purposes.
 * @internal
 */
export function _resetTaskStore(): void {
    taskStore.clear();
}

/**
 * Tool for creating tasks.
 * @returns A Tool object for creating tasks.
 */
export function TaskCreate() {
    return {
        name: 'TaskCreate',
        description: `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)

All tasks are created with state 'pending'.`,
        inputSchema: z.object({
            subject: z
                .string()
                .describe(
                    'A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")'
                ),
            description: z
                .string()
                .describe(
                    'Detailed description of what needs to be done, including context and acceptance criteria'
                ),
            metadata: z
                .record(z.string(), z.unknown())
                .optional()
                .describe('Arbitrary metadata to attach to the task'),
        }),
        requireUserConfirm: false,

        call({
            subject,
            description,
            metadata,
        }: {
            subject: string;
            description: string;
            metadata?: Record<string, unknown>;
        }): ToolResponse {
            const id = generateId();

            const task: Task = {
                id,
                subject,
                description,
                state: 'pending',
                metadata: metadata ?? {},
                owner: null,
                blocks: [],
                blocked_by: [],
                created_at: new Date().toISOString(),
            };

            taskStore.set(id, task);

            return createToolResponse({
                content: [
                    {
                        id: crypto.randomUUID(),
                        type: 'text',
                        text: `Task ${id} created successfully: ${subject}`,
                    },
                ],
                state: 'success',
            });
        },
    };
}

/**
 * Tool for updating tasks.
 * @returns A Tool object for updating tasks.
 */
export function TaskUpdate() {
    return {
        name: 'TaskUpdate',
        description: `Use this tool to update a task in the task list.

## When to Use This Tool

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to 'deleted' permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks`,
        inputSchema: z.object({
            taskId: z.string().describe('The ID of the task to update'),
            status: z
                .enum(['pending', 'in_progress', 'completed', 'deleted'])
                .optional()
                .describe('New status for the task'),
            subject: z.string().optional().describe('New subject for the task'),
            description: z.string().optional().describe('New description for the task'),
            owner: z.string().optional().describe('New owner for the task'),
            metadata: z
                .record(z.string(), z.unknown())
                .optional()
                .describe('Metadata keys to merge into the task. Set a key to null to delete it.'),
            addBlocks: z.array(z.string()).optional().describe('Task IDs that this task blocks'),
            addBlockedBy: z.array(z.string()).optional().describe('Task IDs that block this task'),
        }),
        requireUserConfirm: false,

        call({
            taskId,
            status,
            subject,
            description,
            owner,
            metadata,
            addBlocks,
            addBlockedBy,
        }: {
            taskId: string;
            status?: 'pending' | 'in_progress' | 'completed' | 'deleted';
            subject?: string;
            description?: string;
            owner?: string;
            metadata?: Record<string, unknown>;
            addBlocks?: string[];
            addBlockedBy?: string[];
        }): ToolResponse {
            const task = taskStore.get(taskId);
            if (!task) {
                throw new Error(`Task not found: ${taskId}`);
            }

            // Validate dependencies exist
            if (addBlocks) {
                for (const depId of addBlocks) {
                    if (!taskStore.has(depId)) {
                        throw new Error(`Cannot add dependency: task ${depId} does not exist`);
                    }
                }
            }
            if (addBlockedBy) {
                for (const depId of addBlockedBy) {
                    if (!taskStore.has(depId)) {
                        throw new Error(`Cannot add dependency: task ${depId} does not exist`);
                    }
                }
            }

            // Update fields
            if (subject !== undefined) task.subject = subject;
            if (description !== undefined) task.description = description;
            if (owner !== undefined) task.owner = owner;

            // Merge metadata
            if (metadata !== undefined) {
                for (const [key, value] of Object.entries(metadata)) {
                    if (value === null) {
                        delete task.metadata[key];
                    } else {
                        task.metadata[key] = value;
                    }
                }
            }

            // Add dependencies with deduplication
            if (addBlocks) {
                task.blocks = [...new Set([...task.blocks, ...addBlocks])];
            }
            if (addBlockedBy) {
                task.blocked_by = [...new Set([...task.blocked_by, ...addBlockedBy])];
            }

            // Handle status change
            if (status !== undefined) {
                if (status === 'deleted') {
                    taskStore.delete(taskId);
                    return createToolResponse({
                        content: [
                            {
                                id: crypto.randomUUID(),
                                type: 'text',
                                text: `Task ${taskId} deleted successfully`,
                            },
                        ],
                        state: 'success',
                    });
                }
                task.state = status;
            }

            return createToolResponse({
                content: [
                    {
                        id: crypto.randomUUID(),
                        type: 'text',
                        text: `Task ${taskId} updated successfully`,
                    },
                ],
                state: 'success',
            });
        },
    };
}

/**
 * Tool for retrieving a single task.
 * @returns A Tool object for retrieving a task by ID.
 */
export function TaskGet() {
    return {
        name: 'TaskGet',
        description: `Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements`,
        inputSchema: z.object({
            taskId: z.string().describe('The ID of the task to retrieve'),
        }),
        requireUserConfirm: false,

        call({ taskId }: { taskId: string }): ToolResponse {
            const task = taskStore.get(taskId);
            if (!task) {
                throw new Error(`Task not found: ${taskId}`);
            }

            let text = `Task ${task.id}: ${task.subject}\n`;
            text += `State: ${task.state}\n`;
            text += `Description: ${task.description}\n`;

            if (task.owner) {
                text += `Owner: ${task.owner}\n`;
            }
            if (task.blocks.length > 0) {
                text += `Blocks: ${task.blocks.join(', ')}\n`;
            }
            if (task.blocked_by.length > 0) {
                text += `Blocked By: ${task.blocked_by.join(', ')}\n`;
            }
            if (task.metadata && Object.keys(task.metadata).length > 0) {
                text += `Metadata: ${JSON.stringify(task.metadata, null, 2)}\n`;
            }
            text += `Created: ${task.created_at}`;

            return createToolResponse({
                content: [
                    {
                        id: crypto.randomUUID(),
                        type: 'text',
                        text,
                    },
                ],
                state: 'success',
            });
        },
    };
}

/**
 * Tool for listing all active tasks.
 * @returns A Tool object for listing all active tasks.
 */
export function TaskList() {
    return {
        name: 'TaskList',
        description: `Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- After completing a task, to check for newly unblocked work or claim the next available task`,
        inputSchema: z.object({}),
        requireUserConfirm: false,

        call(): ToolResponse {
            const activeTasks = Array.from(taskStore.values())
                .filter(task => task.state === 'pending' || task.state === 'in_progress')
                .sort((a, b) => Number(a.id) - Number(b.id));

            if (activeTasks.length === 0) {
                return createToolResponse({
                    content: [
                        {
                            id: crypto.randomUUID(),
                            type: 'text',
                            text: 'No tasks available.',
                        },
                    ],
                    state: 'success',
                });
            }

            const lines = activeTasks.map(task => {
                let line = `${task.id} [${task.state}] ${task.subject}`;
                if (task.owner) {
                    line += `(${task.owner})`;
                }
                if (task.blocked_by.length > 0) {
                    line += `[blocked by ${task.blocked_by.join(', ')}]`;
                }
                return line;
            });

            return createToolResponse({
                content: [
                    {
                        id: crypto.randomUUID(),
                        type: 'text',
                        text: lines.join('\n'),
                    },
                ],
                state: 'success',
            });
        },
    };
}
