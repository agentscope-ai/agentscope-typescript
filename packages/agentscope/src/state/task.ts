import { z } from 'zod';

import { _generateId, _generateTimestamp } from '../_utils/common';

export type TaskState = 'pending' | 'in_progress' | 'completed';

/** Python-compatible persisted task shape. */
export interface Task {
    subject: string;
    description: string;
    metadata: Record<string, unknown>;
    created_at: string;
    state: TaskState;
    id: string;
    owner: string | null;
    blocks: string[];
    blocked_by: string[];
}

export interface CreateTaskOptions {
    subject: string;
    description: string;
    metadata: Record<string, unknown>;
    createdAt?: string;
    state?: TaskState;
    id?: string;
    owner?: string | null;
    blocks?: string[];
    blockedBy?: string[];
}

/**
 * Create a task with Python-compatible defaults.
 * @param options Task fields using TypeScript naming.
 * @returns A persisted task value.
 */
export function createTask(options: CreateTaskOptions): Task {
    return {
        subject: options.subject,
        description: options.description,
        metadata: options.metadata,
        created_at: options.createdAt ?? _generateTimestamp(),
        state: options.state ?? 'pending',
        id: options.id ?? _generateId(),
        owner: options.owner ?? null,
        blocks: options.blocks ?? [],
        blocked_by: options.blockedBy ?? [],
    };
}

/** Runtime schema for Python-compatible task payloads. */
export const TaskSchema = z
    .object({
        subject: z.string(),
        description: z.string(),
        metadata: z.record(z.string(), z.unknown()),
        created_at: z.string().optional(),
        state: z.enum(['pending', 'in_progress', 'completed']).optional(),
        id: z.string().optional(),
        owner: z.string().nullable().optional(),
        blocks: z.array(z.string()).optional(),
        blocked_by: z.array(z.string()).optional(),
    })
    .transform(value =>
        createTask({
            subject: value.subject,
            description: value.description,
            metadata: value.metadata,
            createdAt: value.created_at,
            state: value.state,
            id: value.id,
            owner: value.owner,
            blocks: value.blocks,
            blockedBy: value.blocked_by,
        })
    );

/**
 * Parse an untrusted snake_case task payload.
 * @param input Untrusted input.
 * @returns A validated task.
 */
export function parseTask(input: unknown): Task {
    return TaskSchema.parse(input);
}
