import fs from 'fs';
import path from 'path';

import { AgentOptions } from '@agentscope-ai/agentscope/agent';
import type { Msg } from '@agentscope-ai/agentscope/message';
import { createMsg } from '@agentscope-ai/agentscope/message';
import { LocalFileStorage } from '@agentscope-ai/agentscope/storage';
import { Toolkit } from '@agentscope-ai/agentscope/tool';
import {
    Schedule,
    ScheduleWithStatus,
    ScheduleExecution,
    ExecutionStartedEvent,
    ExecutionFinishedEvent,
} from '@shared/types/schedule';
import type { WebContents } from 'electron';
import cron, { ScheduledTask } from 'node-cron';

import { runAgent } from '../agent';
import { getConfig } from '../config';
import { getModel } from '../services/utils';
import { readJSON, writeJSON, remove, readJSONL } from '../storage';
import { PATHS } from '../storage/paths';

interface ScheduledEntry {
    schedule: Schedule;
    task: ScheduledTask;
}

const entries = new Map<string, ScheduledEntry>();

// Track running executions: scheduleId -> execution info
const runningExecutions = new Map<
    string,
    {
        executionId: string;
        startTime: number;
    }
>();

// WebContents reference for sending events
let webContentsRef: WebContents | null = null;

/**
 * Load all schedules from the storage directory
 *
 * @returns Array of all loaded schedules
 */
function loadAllSchedules(): Schedule[] {
    const scheduleRoot = path.join(PATHS.root, 'schedule');
    if (!fs.existsSync(scheduleRoot)) {
        return [];
    }

    const schedules: Schedule[] = [];
    const eventDirs = fs.readdirSync(scheduleRoot);

    for (const eventId of eventDirs) {
        const eventPath = PATHS.scheduleEvent(eventId);
        if (fs.existsSync(eventPath)) {
            try {
                const schedule = readJSON<Schedule | null>(eventPath, null);
                if (schedule) {
                    schedules.push(schedule);
                }
            } catch (error) {
                console.error(`Failed to load schedule ${eventId}:`, error);
            }
        }
    }

    return schedules;
}

/**
 * Save a schedule to storage
 *
 * @param schedule - The schedule to save
 */
function saveSchedule(schedule: Schedule): void {
    writeJSON(PATHS.scheduleEvent(schedule.id), schedule);
}

/**
 * Trigger a scheduled task execution
 *
 * @param schedule - The schedule to trigger
 */
async function triggerSchedule(schedule: Schedule) {
    if (!webContentsRef) {
        console.error(
            `[SCHEDULE ${schedule.id}] WebContents not available, cannot trigger schedule`
        );
        return;
    }

    // Generate execution ID using timestamp
    const executionId = new Date().toISOString();
    const startTime = Date.now();

    // Create execution record
    const execution: ScheduleExecution = {
        executionId,
        scheduleId: schedule.id,
        startTime,
        status: 'running',
    };

    // Add to running executions
    runningExecutions.set(schedule.id, {
        executionId,
        startTime,
    });

    // Send started event to frontend
    const startedEvent: ExecutionStartedEvent = {
        scheduleId: schedule.id,
        executionId,
        startTime,
    };
    webContentsRef.send('schedule:execution:started', startedEvent);

    // Save execution record to file system
    const executionMetaPath = path.join(
        PATHS.scheduleDir(schedule.id),
        'executions',
        `${executionId}.json`
    );
    fs.mkdirSync(path.dirname(executionMetaPath), { recursive: true });
    writeJSON(executionMetaPath, execution);

    // Trigger the scheduled task
    const config = getConfig();

    const agentConfig = config.agents?.[schedule.agentKey];
    if (!agentConfig) {
        const error = `Agent with key ${schedule.agentKey} not found in configuration.`;
        console.error(`[SCHEDULE ${schedule.id}] ${error}`);
        await finishExecution(schedule.id, executionId, 'failed', error);
        return;
    }

    let modelConfig = config.models?.[agentConfig.modelKey];
    if (!modelConfig && Object.keys(config.models || {}).length > 0) {
        const firstModelKey = Object.keys(config.models)[0];
        modelConfig = config.models[firstModelKey];
        console.warn(
            `[SCHEDULE ${schedule.id}] Model "${agentConfig.modelKey}" not found for agent "${agentConfig.name}". Using "${firstModelKey}" instead.`
        );
    }

    if (!modelConfig) {
        const error = 'No model configured. Please configure a model in Settings > Models first.';
        console.error(`[SCHEDULE ${schedule.id}] ${error}`);
        await finishExecution(schedule.id, executionId, 'failed', error);
        return;
    }

    const model = getModel(modelConfig);

    // Use execution-specific storage path
    const storage = new LocalFileStorage({
        pathSegments: [PATHS.root, 'schedule', schedule.id, 'executions', executionId],
        offloadPathSegments: [PATHS.offloadDir(`schedule-${schedule.id}-${executionId}`)],
    });

    // tool
    const toolkit = new Toolkit();
    const sessionsDir = path.join(PATHS.scheduleDir(schedule.id), 'sessions');

    const sysPrompt = `You're a helpful assistant for scheduled tasks named "${agentConfig.name}".

## Your Goal
A scheduled task has been created to execute you at a specific time or interval. You're now being triggered by the scheduler to perform your task. Your goal is to complete the task as effectively as possible within the constraints of the scheduling system.

## Schedule Task
\`\`\`
${JSON.stringify(schedule, null, 2)}
\`\`\`

## Available Resources
- The schedule task may be executed for several times, so first check the ${sessionsDir} for any previous experience and try to learn from it. They're named in date format like "2024-01-01T00:00:00.000Z.jsonl".

## Constraints
- The user is not available during your execution, so you have to figure out everything by yourself.
- When you finish or fail the task for certain reason, you MUST write a summary of this execution in Markdown format.
`;

    const agentOptions: AgentOptions = {
        name: agentConfig.name,
        sysPrompt,
        model,
        maxIters: agentConfig.maxIters,
        compressionConfig: {
            enabled: true,
            triggerThreshold: agentConfig.compressionTrigger,
            keepRecent: agentConfig.compressionKeepRecent,
        },
        storage,
        toolkit,
    };

    // Execute agent
    try {
        await runAgent(
            agentOptions,
            // Send agent events to schedule-specific channel
            event => webContentsRef!.send(`agent:event:schedule:${schedule.id}`, event),
            createMsg({
                name: 'user',
                content: [
                    {
                        id: crypto.randomUUID(),
                        type: 'text',
                        created_at: new Date().toISOString(),
                        text: '<system-reminder>Now begin to execute the scheduled task!</system-reminder>',
                    },
                ],
                role: 'user',
            })
        );

        // Execution completed successfully
        await finishExecution(schedule.id, executionId, 'completed');
    } catch (error) {
        // Execution failed
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[SCHEDULE ${schedule.id}] Execution failed:`, error);
        await finishExecution(schedule.id, executionId, 'failed', errorMessage);
    }
}

/**
 * Finish an execution and send event to frontend
 * @param scheduleId
 * @param executionId
 * @param status
 * @param error
 */
async function finishExecution(
    scheduleId: string,
    executionId: string,
    status: 'completed' | 'failed',
    error?: string
) {
    const endTime = Date.now();

    // Remove from running executions
    runningExecutions.delete(scheduleId);

    // Update execution record
    const executionMetaPath = path.join(
        PATHS.scheduleDir(scheduleId),
        'executions',
        `${executionId}.json`
    );

    if (fs.existsSync(executionMetaPath)) {
        const execution = readJSON<ScheduleExecution>(executionMetaPath, {} as ScheduleExecution);
        execution.endTime = endTime;
        execution.status = status;
        if (error) {
            execution.error = error;
        }
        writeJSON(executionMetaPath, execution);
    }

    // Send finished event to frontend
    if (webContentsRef) {
        const finishedEvent: ExecutionFinishedEvent = {
            scheduleId,
            executionId,
            status,
            endTime,
            error,
        };
        webContentsRef.send('schedule:execution:finished', finishedEvent);
    }
}

/**
 * Initialize the scheduler by loading and starting all enabled schedules
 *
 * @param webContents - The web contents for sending events to frontend
 */
export async function initScheduler(webContents: WebContents): Promise<void> {
    // Store webContents reference
    webContentsRef = webContents;

    const schedules = loadAllSchedules();

    for (const schedule of schedules) {
        if (schedule.enabled) {
            const task = cron.schedule(schedule.cronExpr, () => triggerSchedule(schedule));
            task.start();
            entries.set(schedule.id, { schedule, task });
        }
    }
}

/**
 * Shutdown the scheduler by stopping all scheduled tasks
 */
export async function shutdownScheduler(): Promise<void> {
    for (const entry of entries.values()) {
        entry.task.stop();
    }
    entries.clear();
}

/**
 * Create a new schedule and start its cron task
 *
 * @param params - Schedule parameters without ID
 * @returns The created schedule with generated ID
 */
export function createSchedule(params: Omit<Schedule, 'id'>): Schedule {
    const schedule: Schedule = { id: crypto.randomUUID(), ...params };

    const task = cron.schedule(schedule.cronExpr, () => triggerSchedule(schedule));
    if (schedule.enabled) task.start();

    entries.set(schedule.id, { schedule, task });
    saveSchedule(schedule);

    return schedule;
}

/**
 * Delete a schedule by ID, stopping its task and removing from storage
 *
 * @param id - The schedule ID to delete
 * @returns True if deleted successfully, false if not found
 */
export function deleteSchedule(id: string): boolean {
    const entry = entries.get(id);
    if (!entry) return false;

    entry.task.stop();
    entries.delete(id);

    // Delete schedule directory (cascade delete)
    remove(PATHS.scheduleDir(id));

    return true;
}

/**
 * Get a schedule by ID
 *
 * @param id - The schedule ID to retrieve
 * @returns The schedule if found, undefined otherwise
 */
export function getSchedule(id: string): Schedule | undefined {
    return entries.get(id)?.schedule;
}

/**
 * List all schedules with runtime status
 *
 * @returns Array of all schedules with running execution info
 */
export function listSchedules(): ScheduleWithStatus[] {
    return Array.from(entries.values()).map(e => {
        const schedule = e.schedule;
        const runningExecution = runningExecutions.get(schedule.id);

        return {
            ...schedule,
            runningExecution,
        };
    });
}

/**
 * Update a schedule with partial changes, restarting task if needed
 *
 * @param id - The schedule ID to update
 * @param patch - Partial schedule updates to apply
 * @returns The updated schedule if found, null otherwise
 */
export function updateSchedule(id: string, patch: Partial<Omit<Schedule, 'id'>>): Schedule | null {
    const entry = entries.get(id);
    if (!entry) return null;

    const updated: Schedule = { ...entry.schedule, ...patch };

    // If cronExpr or enabled changed, restart the task
    if (patch.cronExpr !== undefined || patch.enabled !== undefined) {
        entry.task.stop();
        const task = cron.schedule(updated.cronExpr, () => triggerSchedule(updated));
        if (updated.enabled) task.start();
        entries.set(id, { schedule: updated, task });
    } else {
        entries.set(id, { schedule: updated, task: entry.task });
    }

    saveSchedule(updated);

    return updated;
}

/**
 * Get messages for a specific execution
 *
 * @param scheduleId - The schedule ID
 * @param executionId - The execution ID
 * @returns Array of messages for the execution
 */
export function getExecutionMessages(scheduleId: string, executionId: string): Msg[] {
    const schedule = entries.get(scheduleId)?.schedule;
    if (!schedule) return [];

    const contextPath = path.join(
        PATHS.scheduleDir(scheduleId),
        'executions',
        executionId,
        schedule.agentKey,
        'context.jsonl'
    );

    if (!fs.existsSync(contextPath)) return [];

    try {
        return readJSONL<Msg>(contextPath);
    } catch {
        return [];
    }
}

/**
 * Get all executions for a schedule (including running and historical)
 *
 * @param scheduleId - The schedule ID
 * @returns Array of all executions
 */
export function getExecutions(scheduleId: string): ScheduleExecution[] {
    const executionsDir = path.join(PATHS.scheduleDir(scheduleId), 'executions');

    if (!fs.existsSync(executionsDir)) {
        return [];
    }

    const executions: ScheduleExecution[] = [];

    try {
        const files = fs.readdirSync(executionsDir);

        for (const file of files) {
            if (file.endsWith('.json')) {
                const executionPath = path.join(executionsDir, file);
                try {
                    const execution = readJSON<ScheduleExecution>(
                        executionPath,
                        {} as ScheduleExecution
                    );
                    executions.push(execution);
                } catch (error) {
                    console.error(`Failed to load execution ${file}:`, error);
                }
            }
        }
    } catch (error) {
        console.error(`Failed to read executions directory for schedule ${scheduleId}:`, error);
    }

    // Sort by startTime descending (most recent first)
    executions.sort((a, b) => b.startTime - a.startTime);

    return executions;
}
