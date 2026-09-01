/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns */

import { logger } from '@agentscope-ai/agentscope/logger';
import { HintBlock } from '@agentscope-ai/agentscope/message';
import { createPermissionContext, PermissionMode } from '@agentscope-ai/agentscope/permission';
import { AgentState } from '@agentscope-ai/agentscope/state';
import { _generateId } from '@agentscope-ai/agentscope/utils';
import { CronExpressionParser } from 'cron-parser';

import { deliverToInbox } from '../bus-ops';
import { type BusPayload, type MessageBus, MessageBusKeys } from '../message-bus';
import { SessionConfigSchema, type ScheduleRecord, type StorageBase } from '../storage';
import type { WorkspaceManagerBase } from '../workspace-manager';
import { ScheduleCreate, ScheduleDelete, ScheduleList, ScheduleView } from './schedule-tools';

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MISFIRE_GRACE_MS = 300_000;
const WEEKDAY_INDEX: Record<string, number> = {
    mon: 0,
    tue: 1,
    wed: 2,
    thu: 3,
    fri: 4,
    sat: 5,
    sun: 6,
};

interface RegisteredSchedule {
    record: ScheduleRecord;
    version: string;
    nextRun: Date | null;
    timer: ReturnType<typeof setTimeout> | null;
}

export interface ScheduledTaskSummary {
    id: string;
    name: string;
    next_run: Date | null;
}

export interface SchedulerManagerOptions {
    enabled?: boolean;
    reconcileIntervalMs?: number;
    now?: () => Date;
}

/** Storage-backed owner for scheduled AgentScope session triggers. */
export class SchedulerManager {
    private readonly enabled: boolean;
    private readonly reconcileIntervalMs: number;
    private readonly now: () => Date;
    private readonly jobs = new Map<string, RegisteredSchedule>();
    private controller: AbortController | null = null;
    private loops: Promise<void>[] = [];

    constructor(
        private readonly storage: StorageBase,
        private readonly messageBus: MessageBus,
        private readonly workspaceManager: WorkspaceManagerBase,
        options: SchedulerManagerOptions = {}
    ) {
        this.enabled = options.enabled ?? true;
        this.reconcileIntervalMs = options.reconcileIntervalMs ?? 60_000;
        this.now = options.now ?? (() => new Date());
    }

    get running(): boolean {
        return this.controller !== null;
    }

    async open(): Promise<this> {
        if (!this.enabled || this.controller) return this;
        this.controller = new AbortController();
        const ready = deferred();
        this.loops = [
            this.listen(this.controller.signal, ready.resolve),
            this.periodic(this.controller.signal),
        ];
        await ready.promise;
        await this.reconcile();
        return this;
    }

    async close(): Promise<void> {
        this.controller?.abort();
        await Promise.allSettled(this.loops);
        this.loops = [];
        this.controller = null;
        for (const job of this.jobs.values()) {
            if (job.timer) clearTimeout(job.timer);
        }
        this.jobs.clear();
    }

    /** Validate cron syntax, timezone, and activation window before persistence. */
    static validateSchedule(record: ScheduleRecord): void {
        const fields = splitCron(record.data.cron_expression);
        validateTimezone(record.data.timezone);
        const startedAt = parseDate(record.data.started_at, 'started_at');
        const endedAt = record.data.ended_at ? parseDate(record.data.ended_at, 'ended_at') : null;
        if (endedAt && endedAt.getTime() <= startedAt.getTime()) {
            throw new Error('ended_at must be later than started_at');
        }
        const expression = expressionForParser(fields);
        CronExpressionParser.parse(expression, { tz: record.data.timezone });
    }

    validateSchedule(record: ScheduleRecord): void {
        SchedulerManager.validateSchedule(record);
    }

    /** Build the zero-argument callback used by a schedule timer. */
    buildTrigger(record: ScheduleRecord): () => Promise<void> {
        return async () => {
            if (!record.data.enabled) return;
            try {
                const session = record.data.stateful
                    ? await this.resolveStatefulSession(record)
                    : await this.createFreshSession(record);
                const hint = HintBlock({
                    hint:
                        `<scheduled-task>\n` + `${record.data.description}\n` + `</scheduled-task>`,
                    source: JSON.stringify({
                        label: 'schedule',
                        sublabel: record.data.name,
                    }),
                });
                await deliverToInbox(this.messageBus, {
                    userId: record.user_id,
                    sessionId: session.id,
                    agentId: record.agent_id,
                    payload: hint as unknown as BusPayload,
                });
            } catch (error) {
                logger.error(
                    'Schedule %s(%s) trigger failed: %s',
                    record.id,
                    record.data.name,
                    error
                );
            }
        };
    }

    /** Best-effort nudge; storage remains the source of truth. */
    async notifyChanged(scheduleId: string): Promise<void> {
        try {
            await this.messageBus.publish(MessageBusKeys.scheduleLifecycle(), {
                schedule_id: scheduleId,
            });
        } catch (error) {
            logger.error('Failed to publish schedule change %s: %s', scheduleId, error);
        }
    }

    /** Reconcile this node's timers with all enabled storage records. */
    async reconcile(): Promise<void> {
        if (!this.enabled) return;
        let records: ScheduleRecord[];
        try {
            records = await this.storage.listAllSchedules();
        } catch (error) {
            logger.error('Schedule reconcile failed to list records: %s', error);
            return;
        }
        const desired = new Map(
            records.filter(record => record.data.enabled).map(record => [record.id, record])
        );
        for (const scheduleId of this.jobs.keys()) {
            if (!desired.has(scheduleId)) this.removeJob(scheduleId);
        }
        for (const record of desired.values()) {
            const current = this.jobs.get(record.id);
            if (current?.version === record.updated_at) continue;
            if (current) this.removeJob(record.id);
            try {
                this.addJob(record);
            } catch (error) {
                logger.error('Cannot register schedule %s: %s', record.id, error);
            }
        }
    }

    async listTasks(): Promise<ScheduledTaskSummary[]> {
        return [...this.jobs.values()].map(job => ({
            id: job.record.id,
            name: job.record.data.name,
            next_run: job.nextRun,
        }));
    }

    getTask(scheduleId: string): ScheduledTaskSummary | null {
        const job = this.jobs.get(scheduleId);
        return job
            ? { id: job.record.id, name: job.record.data.name, next_run: job.nextRun }
            : null;
    }

    removeScheduleJob(scheduleId: string): void {
        this.removeJob(scheduleId);
    }

    async listTools(
        userId: string,
        agentId: string,
        chatModelConfig: ScheduleRecord['data']['chat_model_config']
    ): Promise<[ScheduleCreate, ScheduleView, ScheduleDelete, ScheduleList]> {
        return [
            new ScheduleCreate(userId, agentId, chatModelConfig, this.storage, this),
            new ScheduleView(userId, this, this.storage),
            new ScheduleDelete(userId, this, this.storage, this.messageBus),
            new ScheduleList(userId, this, this.storage),
        ];
    }

    private async resolveStatefulSession(record: ScheduleRecord) {
        const sessionId = `${record.id}_stateful`;
        const existing = await this.storage.getSession(record.user_id, record.agent_id, sessionId);
        if (existing) return existing;
        return this.createSession(record, sessionId, sessionId);
    }

    private createFreshSession(record: ScheduleRecord) {
        return this.createSession(record, undefined, _generateId());
    }

    private async createSession(
        record: ScheduleRecord,
        sessionId: string | undefined,
        workspaceSessionId: string
    ) {
        const workspaceId = await this.workspaceManager.assignWorkspaceId({
            userId: record.user_id,
            agentId: record.agent_id,
            sessionId: workspaceSessionId,
        });
        const permissionMode = record.data.permission_mode as PermissionMode;
        const state = new AgentState({
            permissionContext: createPermissionContext(permissionMode),
        });
        return this.storage.upsertSession({
            userId: record.user_id,
            agentId: record.agent_id,
            sessionId,
            config: SessionConfigSchema.parse({
                workspace_id: workspaceId,
                chat_model_config: record.data.chat_model_config,
            }),
            state: state.toJSON(),
            source: 'schedule',
            sourceScheduleId: record.id,
        });
    }

    private async listen(signal: AbortSignal, ready: () => void): Promise<void> {
        let backoffMs = 1_000;
        while (!signal.aborted) {
            try {
                for await (const _ of this.messageBus.subscribe(
                    MessageBusKeys.scheduleLifecycle(),
                    { onReady: ready, signal }
                )) {
                    backoffMs = 1_000;
                    await this.reconcile();
                }
                if (signal.aborted) break;
            } catch (error) {
                if (signal.aborted) break;
                logger.warning('Schedule lifecycle subscription lost: %s', error);
            } finally {
                ready();
            }
            if (!(await delay(backoffMs, signal))) break;
            backoffMs = Math.min(backoffMs * 2, 30_000);
        }
    }

    private async periodic(signal: AbortSignal): Promise<void> {
        while (await delay(this.reconcileIntervalMs, signal)) await this.reconcile();
    }

    private addJob(record: ScheduleRecord): void {
        SchedulerManager.validateSchedule(record);
        const job: RegisteredSchedule = {
            record,
            version: record.updated_at,
            nextRun: null,
            timer: null,
        };
        this.jobs.set(record.id, job);
        this.scheduleNext(job);
    }

    private removeJob(scheduleId: string): void {
        const job = this.jobs.get(scheduleId);
        if (job?.timer) clearTimeout(job.timer);
        this.jobs.delete(scheduleId);
    }

    private scheduleNext(job: RegisteredSchedule): void {
        if (this.jobs.get(job.record.id) !== job) return;
        const nextRun = nextRunFor(job.record, this.now());
        job.nextRun = nextRun;
        if (!nextRun) return;
        const remaining = nextRun.getTime() - this.now().getTime();
        const delayMs = Math.max(0, Math.min(remaining, MAX_TIMER_DELAY_MS));
        job.timer = setTimeout(() => void this.onTimer(job, nextRun), delayMs);
        job.timer.unref?.();
    }

    private async onTimer(job: RegisteredSchedule, expectedRun: Date): Promise<void> {
        if (this.jobs.get(job.record.id) !== job) return;
        job.timer = null;
        const now = this.now().getTime();
        if (now < expectedRun.getTime()) {
            this.scheduleNext(job);
            return;
        }
        const lateness = now - expectedRun.getTime();
        if (lateness < MISFIRE_GRACE_MS) await this.buildTrigger(job.record)();
        this.scheduleNext(job);
    }
}

function splitCron(expression: string): [string, string, string, string, string] {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) {
        throw new Error(`Expected a 5-field cron expression, got ${JSON.stringify(expression)}`);
    }
    return fields as [string, string, string, string, string];
}

function validateTimezone(timezone: string): void {
    if (!timezone) throw new Error('timezone must be a non-empty IANA name');
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
    } catch {
        throw new Error(`Invalid timezone ${JSON.stringify(timezone)}`);
    }
}

function parseDate(value: string, name: string): Date {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error(`${name} must be a valid date`);
    return date;
}

function expressionForParser(fields: readonly string[]): string {
    return [...fields.slice(0, 4), translatePythonDayOfWeek(fields[4])].join(' ');
}

function translatePythonDayOfWeek(field: string): string {
    if (field === '*') return '*';
    const days = new Set<number>();
    for (const part of field.toLowerCase().split(',')) {
        const [range, stepText] = part.split('/');
        if (!range || part.split('/').length > 2) throw new Error(`Invalid weekday ${field}`);
        const step = stepText === undefined ? 1 : Number(stepText);
        if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid weekday ${field}`);
        const [startText, endText] = range === '*' ? ['0', '6'] : range.split('-');
        if (!startText || range.split('-').length > 2) {
            throw new Error(`Invalid weekday ${field}`);
        }
        const start = parseWeekday(startText);
        const end = endText === undefined ? start : parseWeekday(endText);
        if (end < start) throw new Error(`Invalid weekday range ${range}`);
        for (let day = start; day <= end; day += step) days.add(day);
    }
    return [...days]
        .sort((left, right) => left - right)
        .map(day => String((day + 1) % 7))
        .join(',');
}

function parseWeekday(value: string): number {
    const named = WEEKDAY_INDEX[value];
    const day = named ?? Number(value);
    if (!Number.isInteger(day) || day < 0 || day > 6) {
        throw new Error(`Invalid weekday ${JSON.stringify(value)}`);
    }
    return day;
}

function nextRunFor(record: ScheduleRecord, currentDate: Date): Date | null {
    const fields = splitCron(record.data.cron_expression);
    const expectedWeekdays = expandPythonWeekdays(fields[4]);
    const bothDayFieldsRestricted = fields[2] !== '*' && fields[4] !== '*';
    const parserFields = [...fields];
    parserFields[4] = bothDayFieldsRestricted ? '*' : translatePythonDayOfWeek(fields[4]);
    const expression = CronExpressionParser.parse(parserFields.join(' '), {
        currentDate,
        startDate: record.data.started_at,
        endDate: record.data.ended_at ?? undefined,
        tz: record.data.timezone,
    });
    for (let attempt = 0; attempt < 10_000 && expression.hasNext(); attempt += 1) {
        const candidate = expression.next().toDate();
        if (
            !bothDayFieldsRestricted ||
            expectedWeekdays.has(weekdayInTimezone(candidate, record.data.timezone))
        ) {
            return candidate;
        }
    }
    return null;
}

function expandPythonWeekdays(field: string): Set<number> {
    if (field === '*') return new Set([0, 1, 2, 3, 4, 5, 6]);
    const translated = translatePythonDayOfWeek(field);
    return new Set(
        translated.split(',').map(value => {
            const cronDay = Number(value);
            return cronDay === 0 ? 6 : cronDay - 1;
        })
    );
}

function weekdayInTimezone(date: Date, timezone: string): number {
    const name = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
    })
        .format(date)
        .toLowerCase();
    return WEEKDAY_INDEX[name];
}

function deferred(): { promise: Promise<void>; resolve(): void } {
    let resolve = (): void => {};
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

function delay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
        if (signal.aborted) {
            resolve(false);
            return;
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve(true);
        }, milliseconds);
        timer.unref?.();
        const abort = (): void => {
            clearTimeout(timer);
            resolve(false);
        };
        signal.addEventListener('abort', abort, { once: true });
    });
}
