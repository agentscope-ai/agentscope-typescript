/* eslint-disable jsdoc/require-jsdoc */

import { TextBlock } from '@agentscope-ai/agentscope/message';
import type { PermissionContext, PermissionDecision } from '@agentscope-ai/agentscope/permission';
import { createPermissionDecision, PermissionBehavior } from '@agentscope-ai/agentscope/permission';
import { ToolBase, ToolChunk } from '@agentscope-ai/agentscope/tool';
import { z } from 'zod';

import type { MessageBus } from '../message-bus';
import type { BackgroundTaskManager } from './background-task-manager';

/** Agent tool for stopping local or cross-worker background work. */
export class ToolStop extends ToolBase {
    readonly name = 'ToolStop';
    readonly description =
        'Stop a background tool execution by its task id. Use this when you want to cancel ' +
        'a previously offloaded tool that is still running in the background.';
    readonly inputSchema = z.object({
        task_id: z.string().describe('The task id of the background tool to stop.'),
    });
    readonly isConcurrencySafe = true;
    readonly isReadOnly = false;

    constructor(
        private readonly backgroundTasks: BackgroundTaskManager,
        private readonly messageBus: MessageBus,
        private readonly sessionId: string
    ) {
        super();
    }

    async checkPermissions(
        _toolInput: Record<string, unknown>,
        _context: PermissionContext
    ): Promise<PermissionDecision> {
        return createPermissionDecision({
            behavior: PermissionBehavior.ALLOW,
            message: `${this.name} is always allowed to be called.`,
        });
    }

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const { task_id: taskId } = this.inputSchema.parse(input);
        const local = this.backgroundTasks.tasks.get(taskId);
        if (local?.sessionId === this.sessionId) {
            this.backgroundTasks.tasks.delete(taskId);
            local.task.cancel();
            return result(`Task ${taskId} stopped successfully.`, 'success');
        }
        if (await this.messageBus.backgroundTaskExists(this.sessionId, taskId)) {
            await this.messageBus.taskPublishCancel(taskId);
            return result(
                `Cancel request sent for task ${taskId}. ` +
                    'The owning worker will stop it shortly.',
                'success'
            );
        }
        return result(`TaskNotFoundError: The task ${taskId} does not exist.`, 'error');
    }
}

function result(text: string, state: 'success' | 'error'): ToolChunk {
    return new ToolChunk({ content: [TextBlock({ text })], state });
}
