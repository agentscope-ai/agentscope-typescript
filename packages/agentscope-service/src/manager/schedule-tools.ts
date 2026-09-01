/* eslint-disable jsdoc/require-jsdoc */

import { TextBlock } from '@agentscope-ai/agentscope/message';
import type { PermissionContext, PermissionDecision } from '@agentscope-ai/agentscope/permission';
import {
    createPermissionDecision,
    PermissionBehavior,
    PermissionMode,
} from '@agentscope-ai/agentscope/permission';
import { AgentState } from '@agentscope-ai/agentscope/state';
import { ToolBase, ToolChunk } from '@agentscope-ai/agentscope/tool';
import { z } from 'zod';

import type { MessageBus } from '../message-bus';
import {
    ScheduleRecordSchema,
    type ChatModelConfig,
    type ScheduleRecord,
    type StorageBase,
} from '../storage';

export interface ScheduleToolManager {
    validateSchedule(record: ScheduleRecord): void;
    notifyChanged(scheduleId: string): Promise<void>;
    getTask(scheduleId: string): { next_run: Date | null } | null;
    removeScheduleJob(scheduleId: string): void;
}

abstract class ScheduleToolBase extends ToolBase {
    async checkPermissions(
        _toolInput: Record<string, unknown>,
        _context: PermissionContext
    ): Promise<PermissionDecision> {
        return createPermissionDecision({
            behavior: PermissionBehavior.ALLOW,
            message: `${this.name} is always allowed to be called.`,
        });
    }
}

/** Agent-facing schedule creation tool. */
export class ScheduleCreate extends ScheduleToolBase {
    readonly name = 'ScheduleCreate';
    readonly description =
        'Create a recurring scheduled task for this agent. The description must contain all ' +
        'context needed when the task runs in a separate session.';
    readonly inputSchema = z.object({
        name: z.string().describe('Display name of the schedule.'),
        description: z.string().default(''),
        cron_expression: z
            .string()
            .describe("Standard 5-field cron expression, e.g. '0 9 * * 1-5'."),
        timezone: z.string().default('UTC'),
        enabled: z.boolean().default(true),
        started_at: z.union([z.string(), z.date()]).nullable().default(null),
        ended_at: z.union([z.string(), z.date()]).nullable().default(null),
        stateful: z.boolean().default(false),
        permission_mode: z.string().default(PermissionMode.DONT_ASK),
    });
    readonly isConcurrencySafe = false;
    readonly isReadOnly = false;
    override isStateInjected = true;

    constructor(
        private readonly userId: string,
        private readonly agentId: string,
        private readonly chatModelConfig: ChatModelConfig,
        private readonly storage: StorageBase,
        private readonly scheduler: ScheduleToolManager
    ) {
        super();
    }

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const values = this.inputSchema.parse(input);
        const agentState = input._agent_state;
        const permissionMode = Object.values(PermissionMode).includes(
            values.permission_mode as PermissionMode
        )
            ? (values.permission_mode as PermissionMode)
            : PermissionMode.DONT_ASK;
        const startedAt = toIsoString(values.started_at ?? new Date());
        const endedAt = values.ended_at ? toIsoString(values.ended_at) : null;
        const record = ScheduleRecordSchema.parse({
            user_id: this.userId,
            agent_id: this.agentId,
            data: {
                name: values.name,
                description: values.description,
                enabled: values.enabled,
                cron_expression: values.cron_expression,
                timezone: values.timezone,
                started_at: startedAt,
                ended_at: endedAt,
                stateful: values.stateful,
                permission_mode: permissionMode,
                source: 'AGENT',
                source_session_id: agentState instanceof AgentState ? agentState.sessionId : '',
                chat_model_config: this.chatModelConfig,
            },
        });

        this.scheduler.validateSchedule(record);
        await this.storage.upsertSchedule(this.userId, record);
        await this.scheduler.notifyChanged(record.id);
        return result(
            `Schedule ${pythonRepr(values.name)} created successfully.\n` +
                `Schedule ID: ${record.id}\n` +
                `Cron: ${values.cron_expression} (timezone: ${values.timezone})\n` +
                `Enabled: ${pythonBoolean(values.enabled)}\n` +
                `Started at: ${startedAt}\n` +
                `Ended at: ${endedAt ?? '(no end time)'}\n` +
                `Stateful: ${pythonBoolean(values.stateful)}`,
            'success'
        );
    }
}

/** Agent-facing schedule detail tool. */
export class ScheduleView extends ScheduleToolBase {
    readonly name = 'ScheduleView';
    readonly description =
        'View a scheduled task by id, including its cron, timezone, state, and next run.';
    readonly inputSchema = z.object({ schedule_id: z.string() });
    readonly isConcurrencySafe = true;
    readonly isReadOnly = true;

    constructor(
        private readonly userId: string,
        private readonly scheduler: ScheduleToolManager,
        private readonly storage: StorageBase
    ) {
        super();
    }

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const { schedule_id: scheduleId } = this.inputSchema.parse(input);
        const record = await this.storage.getSchedule(this.userId, scheduleId);
        if (!record) {
            return result(
                `ScheduleNotFoundError: Schedule with id ${pythonRepr(scheduleId)} not found.`,
                'error'
            );
        }
        const nextRun = this.scheduler.getTask(scheduleId)?.next_run;
        const text =
            `Schedule ID:     ${record.id}\n` +
            `Name:            ${record.data.name}\n` +
            `Description:     ${record.data.description || '(none)'}\n` +
            `Status:          ${record.data.enabled ? 'enabled' : 'disabled'}\n` +
            `Cron:            ${record.data.cron_expression}` +
            ` (timezone: ${record.data.timezone})\n` +
            `Next run:        ${nextRun?.toISOString() ?? 'not in scheduler (may be disabled)'}\n` +
            `Stateful:        ${pythonBoolean(record.data.stateful)}\n` +
            `Permission mode: ${record.data.permission_mode}\n` +
            `Source:          ${record.data.source}\n` +
            `Source session:  ${record.data.source_session_id || '(none)'}\n` +
            `Agent ID:        ${record.agent_id}\n` +
            `Created at:      ${record.created_at}\n` +
            `Updated at:      ${record.updated_at}\n`;
        return result(text, 'success');
    }
}

/** Agent-facing schedule listing tool. */
export class ScheduleList extends ScheduleToolBase {
    readonly name = 'ScheduleList';
    readonly description = 'List all scheduled tasks owned by the current user.';
    readonly inputSchema = z.object({});
    readonly isConcurrencySafe = true;
    readonly isReadOnly = true;

    constructor(
        private readonly userId: string,
        private readonly scheduler: ScheduleToolManager,
        private readonly storage: StorageBase
    ) {
        super();
    }

    async call(_input: Record<string, unknown>): Promise<ToolChunk> {
        const records = await this.storage.listSchedules(this.userId);
        if (records.length === 0) return result('No scheduled tasks found.', 'success');
        const lines = [`Found ${records.length} scheduled task(s):\n`];
        for (const record of records) {
            const nextRun = this.scheduler.getTask(record.id)?.next_run;
            lines.push(
                `- [${record.data.enabled ? 'enabled' : 'disabled'}] ` +
                    `${pythonRepr(record.data.name)}  (ID: ${record.id})\n` +
                    `  Cron:      ${record.data.cron_expression} (${record.data.timezone})\n` +
                    `  Next run:  ${nextRun?.toISOString() ?? 'not in scheduler'}\n` +
                    `  Stateful:  ${pythonBoolean(record.data.stateful)}` +
                    `  |  Agent: ${record.agent_id}\n` +
                    `  Source:    ${record.data.source}\n`
            );
        }
        return result(lines.join('\n'), 'success');
    }
}

/** Agent-facing permanent schedule deletion tool. */
export class ScheduleDelete extends ScheduleToolBase {
    readonly name = 'ScheduleDelete';
    readonly description = 'Permanently delete a scheduled task by its schedule id.';
    readonly inputSchema = z.object({ schedule_id: z.string() });
    readonly isConcurrencySafe = false;
    readonly isReadOnly = false;

    constructor(
        private readonly userId: string,
        private readonly scheduler: ScheduleToolManager,
        private readonly storage: StorageBase,
        private readonly messageBus: MessageBus
    ) {
        super();
    }

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const { schedule_id: scheduleId } = this.inputSchema.parse(input);
        if (!(await this.storage.getSchedule(this.userId, scheduleId))) {
            return result(
                `ScheduleNotFoundError: Schedule with id ${pythonRepr(scheduleId)} ` +
                    'not found in storage.',
                'error'
            );
        }
        this.scheduler.removeScheduleJob(scheduleId);
        for (const session of await this.storage.listSessionsBySchedule(this.userId, scheduleId)) {
            await this.messageBus.sessionPublishCancel(session.id);
            await this.storage.deleteSession(this.userId, session.agent_id, session.id);
            await this.messageBus.sessionPurge(session.id);
        }
        const deleted = await this.storage.deleteSchedule(this.userId, scheduleId);
        if (!deleted) {
            return result(
                `ScheduleNotFoundError: Schedule with id ${pythonRepr(scheduleId)} ` +
                    'not found in storage.',
                'error'
            );
        }
        return result(
            `Schedule ${pythonRepr(scheduleId)} has been permanently deleted.`,
            'success'
        );
    }
}

function result(text: string, state: 'success' | 'error'): ToolChunk {
    return new ToolChunk({ content: [TextBlock({ text })], state });
}

function toIsoString(value: string | Date): string {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid ISO-8601 datetime.');
    return date.toISOString();
}

function pythonRepr(value: string): string {
    return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function pythonBoolean(value: boolean): string {
    return value ? 'True' : 'False';
}
