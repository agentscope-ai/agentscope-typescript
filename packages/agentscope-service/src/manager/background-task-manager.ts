/* eslint-disable jsdoc/require-jsdoc */

import { _generateId } from '@agentscope-ai/agentscope/utils';

import type { MessageBus } from '../message-bus';
import { ManagedTask, type AbortableWork } from './task';
import { ToolStop } from './tool-stop';

export interface BackgroundTask {
    id: string;
    task: ManagedTask<unknown>;
    sessionId: string;
    agentId: string;
    userId: string;
    toolName: string;
}

export interface RegisterBackgroundTaskOptions {
    sessionId: string;
    agentId: string;
    userId: string;
    toolName?: string;
}

/** Local task handles plus the cross-worker background-task registry. */
export class BackgroundTaskManager {
    readonly tasks = new Map<string, BackgroundTask>();

    constructor(readonly messageBus: MessageBus) {}

    async registerTask(
        work: AbortableWork<unknown>,
        options: RegisterBackgroundTaskOptions
    ): Promise<string> {
        const taskId = _generateId();
        const toolName = options.toolName ?? '';
        const task = new ManagedTask(work, `background-task:${taskId}`);
        const backgroundTask: BackgroundTask = {
            id: taskId,
            task,
            sessionId: options.sessionId,
            agentId: options.agentId,
            userId: options.userId,
            toolName,
        };
        this.tasks.set(taskId, backgroundTask);
        await this.messageBus.backgroundTaskRegister(
            options.sessionId,
            taskId,
            JSON.stringify({
                tool_name: toolName,
                agent_id: options.agentId,
                started_at: Date.now() / 1_000,
            })
        );
        const cleanup = (): void => {
            this.tasks.delete(taskId);
            void this.safeUnregister(options.sessionId, taskId);
        };
        void task.promise.then(cleanup, cleanup);
        return taskId;
    }

    listTools(sessionId: string): ToolStop[] {
        return [new ToolStop(this, this.messageBus, sessionId)];
    }

    cancelSessionTasks(sessionId: string): number {
        let cancelled = 0;
        for (const backgroundTask of this.tasks.values()) {
            if (backgroundTask.sessionId !== sessionId) continue;
            backgroundTask.task.cancel();
            cancelled += 1;
        }
        return cancelled;
    }

    cancelTask(taskId: string): boolean {
        const backgroundTask = this.tasks.get(taskId);
        if (!backgroundTask) return false;
        backgroundTask.task.cancel();
        return true;
    }

    async open(): Promise<this> {
        return this;
    }

    async close(): Promise<void> {
        const tasks = [...this.tasks.values()];
        for (const backgroundTask of tasks) backgroundTask.task.cancel();
        await Promise.allSettled(tasks.map(backgroundTask => backgroundTask.task.promise));
        this.tasks.clear();
    }

    private async safeUnregister(sessionId: string, taskId: string): Promise<void> {
        try {
            await this.messageBus.backgroundTaskUnregister(sessionId, taskId);
        } catch {
            // Completion cleanup is best-effort if the bus is shutting down.
        }
    }
}
