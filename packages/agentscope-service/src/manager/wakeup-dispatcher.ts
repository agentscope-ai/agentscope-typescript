/* eslint-disable jsdoc/require-jsdoc */

import {
    createEvent,
    EventType,
    parseAgentEvent,
    type ExternalExecutionResultEvent,
    type UserConfirmResultEvent,
    type UserInterruptEvent,
} from '@agentscope-ai/agentscope/event';
import { parseMsg, type Msg } from '@agentscope-ai/agentscope/message';
import { ErrorInfo, ErrorType, ReplyFinishedReason } from '@agentscope-ai/agentscope/type';

import { type BusPayload, type MessageBus, MessageBusKeys } from '../message-bus';
import type { StorageBase } from '../storage';
import type { ChatRunRegistry } from './chat-run-registry';

export type WakeupInput =
    | UserConfirmResultEvent
    | ExternalExecutionResultEvent
    | UserInterruptEvent
    | Msg
    | null;

export interface WakeupChatService {
    run(options: {
        userId: string;
        sessionId: string;
        agentId: string;
        input: WakeupInput;
        signal: AbortSignal;
    }): Promise<void>;
}

export interface WakeupDispatcherOptions {
    retryBackoffMs?: number;
}

/** Serial consumer of durable cross-session run triggers. */
export class WakeupDispatcher {
    private readonly retryBackoffMs: number;
    private controller: AbortController | null = null;
    private loop: Promise<void> | null = null;
    private readonly retries = new Set<Promise<void>>();

    constructor(
        private readonly messageBus: MessageBus,
        private readonly storage: StorageBase,
        private readonly chatService: WakeupChatService,
        private readonly registry: ChatRunRegistry,
        options: WakeupDispatcherOptions = {}
    ) {
        this.retryBackoffMs = options.retryBackoffMs ?? 100;
    }

    async open(): Promise<this> {
        if (this.controller) return this;
        this.controller = new AbortController();
        const ready = deferred();
        this.loop = this.listen(this.controller.signal, ready.resolve);
        await ready.promise;
        await this.drainOnce();
        return this;
    }

    async close(): Promise<void> {
        this.controller?.abort();
        await Promise.allSettled([...(this.loop ? [this.loop] : []), ...this.retries]);
        this.retries.clear();
        this.loop = null;
        this.controller = null;
    }

    async drainOnce(): Promise<void> {
        let entries: BusPayload[];
        try {
            entries = await this.messageBus.dequeueWakeups(64);
        } catch {
            return;
        }
        for (const payload of entries) {
            const userId = payload.user_id;
            const sessionId = payload.session_id;
            const agentId = payload.agent_id;
            if (
                typeof userId !== 'string' ||
                typeof sessionId !== 'string' ||
                typeof agentId !== 'string'
            ) {
                continue;
            }
            const kind =
                typeof payload.kind === 'string' ? payload.kind : MessageBusKeys.WAKEUP_KIND_WAKE;
            await this.dispatchOne({
                userId,
                sessionId,
                agentId,
                kind,
                rawInput: isBusPayload(payload.input) ? payload.input : null,
            });
        }
    }

    private async listen(signal: AbortSignal, ready: () => void): Promise<void> {
        try {
            for await (const _ of this.messageBus.subscribeWakeupSignal({
                onReady: ready,
                signal,
            })) {
                await this.drainOnce();
            }
        } finally {
            ready();
        }
    }

    private async dispatchOne(options: {
        userId: string;
        sessionId: string;
        agentId: string;
        kind: string;
        rawInput: BusPayload | null;
    }): Promise<void> {
        const carriesInput =
            options.kind === MessageBusKeys.WAKEUP_KIND_RESUME ||
            options.kind === MessageBusKeys.WAKEUP_KIND_MESSAGE;
        let input: WakeupInput = null;
        if (carriesInput) {
            if (!options.rawInput) return;
            try {
                input = parseWakeupInput(options.kind, options.rawInput);
            } catch {
                return;
            }
        }
        if (await this.messageBus.sessionIsRunning(options.sessionId)) {
            this.scheduleRetry(options);
            return;
        }
        const session = await this.storage.getSession(
            options.userId,
            options.agentId,
            options.sessionId
        );
        if (!session) {
            await this.messageBus.sessionPublishEvent(
                options.sessionId,
                createEvent({
                    type: EventType.REPLY_END,
                    session_id: options.sessionId,
                    reply_id: '',
                    finished_reason: ReplyFinishedReason.ERROR,
                    error: new ErrorInfo({
                        type: ErrorType.INTERNAL,
                        message: 'Session no longer exists.',
                    }),
                }) as unknown as BusPayload
            );
            return;
        }
        try {
            this.registry.spawn(
                signal =>
                    this.chatService.run({
                        userId: options.userId,
                        sessionId: options.sessionId,
                        agentId: options.agentId,
                        input,
                        signal,
                    }),
                {
                    sessionId: options.sessionId,
                    name: `${options.kind}-run:${options.sessionId}`,
                }
            );
        } catch {
            this.scheduleRetry(options);
        }
    }

    private scheduleRetry(options: {
        userId: string;
        sessionId: string;
        agentId: string;
        kind: string;
        rawInput: BusPayload | null;
    }): void {
        const signal = this.controller?.signal;
        if (!signal || signal.aborted) return;
        const retry = delay(this.retryBackoffMs, signal)
            .then(async ready => {
                if (!ready) return;
                await this.messageBus.enqueueInput(
                    options.userId,
                    options.sessionId,
                    options.agentId,
                    {
                        kind: normalizeKind(options.kind),
                        input: options.rawInput,
                    }
                );
            })
            .catch(() => undefined);
        this.retries.add(retry);
        void retry.finally(() => this.retries.delete(retry));
    }
}

function parseWakeupInput(kind: string, rawInput: BusPayload): Exclude<WakeupInput, null> {
    if (kind === MessageBusKeys.WAKEUP_KIND_MESSAGE) return parseMsg(rawInput);
    const event = parseAgentEvent(rawInput);
    if (
        event.type !== EventType.USER_CONFIRM_RESULT &&
        event.type !== EventType.EXTERNAL_EXECUTION_RESULT &&
        event.type !== EventType.USER_INTERRUPT
    ) {
        throw new Error(`Unsupported resume event ${event.type}.`);
    }
    return event;
}

function normalizeKind(kind: string): 'wake' | 'resume' | 'message' {
    if (kind === MessageBusKeys.WAKEUP_KIND_RESUME) return 'resume';
    if (kind === MessageBusKeys.WAKEUP_KIND_MESSAGE) return 'message';
    return 'wake';
}

function isBusPayload(value: unknown): value is BusPayload {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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
