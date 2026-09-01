/* eslint-disable jsdoc/require-jsdoc */

import { randomUUID } from 'node:crypto';

import { MessageBus } from './base';
import type { BusEntry, BusPayload, MessageBusLock, SubscribeOptions } from './base';

interface QueueEntry {
    id: string;
    payload: BusPayload;
}

interface LockState {
    holder: string | null;
    waiters: Array<(token: string) => void>;
}

class AsyncChannel<T> implements AsyncIterableIterator<T> {
    private readonly buffered: T[] = [];
    private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
    private closed = false;

    [Symbol.asyncIterator](): AsyncIterableIterator<T> {
        return this;
    }

    next(): Promise<IteratorResult<T>> {
        const item = this.buffered.shift();
        if (item !== undefined) return Promise.resolve({ done: false, value: item });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise(resolve => this.waiters.push(resolve));
    }

    return(): Promise<IteratorResult<T>> {
        this.close();
        return Promise.resolve({ done: true, value: undefined });
    }

    push(value: T): void {
        if (this.closed) return;
        const waiter = this.waiters.shift();
        if (waiter) waiter({ done: false, value });
        else this.buffered.push(value);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const waiter of this.waiters.splice(0)) {
            waiter({ done: true, value: undefined });
        }
    }
}

/** Single-process message bus for development and tests. */
export class InMemoryMessageBus extends MessageBus {
    private sequence = 0;
    private readonly queues = new Map<string, QueueEntry[]>();
    private readonly logs = new Map<string, QueueEntry[]>();
    private readonly subscribers = new Map<string, Set<AsyncChannel<BusPayload>>>();
    private readonly locks = new Map<string, LockState>();
    private readonly tryLockTokens = new Map<string, string>();
    private readonly registries = new Map<string, Map<string, string>>();
    private readonly queueExpiries = new Map<string, number>();
    private readonly logExpiries = new Map<string, number>();
    private readonly registryExpiries = new Map<string, number>();

    async close(): Promise<void> {
        for (const subscribers of this.subscribers.values()) {
            for (const subscriber of subscribers) subscriber.close();
        }
        this.subscribers.clear();
    }

    async queuePush(
        key: string,
        payload: BusPayload,
        options: { ttlSeconds?: number } = {}
    ): Promise<string> {
        this.purgeExpired(this.queues, this.queueExpiries, key);
        const id = this.nextId();
        const queue = this.queues.get(key) ?? [];
        queue.push({ id, payload: structuredClone(payload) });
        this.queues.set(key, queue);
        this.refreshExpiry(this.queueExpiries, key, options.ttlSeconds);
        return id;
    }

    async queueDrain(key: string, maxCount = 100): Promise<BusEntry[]> {
        this.assertCount(maxCount);
        this.purgeExpired(this.queues, this.queueExpiries, key);
        const queue = this.queues.get(key);
        if (!queue || maxCount === 0) return [];
        const entries = queue.splice(0, maxCount);
        if (queue.length === 0) {
            this.queues.delete(key);
            this.queueExpiries.delete(key);
        }
        return entries.map(entry => [entry.id, structuredClone(entry.payload)] as const);
    }

    async queueDelete(key: string): Promise<void> {
        this.queues.delete(key);
        this.queueExpiries.delete(key);
    }

    async logAppend(
        key: string,
        payload: BusPayload,
        options: { ttlSeconds?: number; maxLength?: number } = {}
    ): Promise<string> {
        this.purgeExpired(this.logs, this.logExpiries, key);
        const id = this.nextId();
        const log = this.logs.get(key) ?? [];
        log.push({ id, payload: structuredClone(payload) });
        if (options.maxLength !== undefined) {
            this.assertCount(options.maxLength);
            log.splice(0, Math.max(0, log.length - options.maxLength));
        }
        this.logs.set(key, log);
        this.refreshExpiry(this.logExpiries, key, options.ttlSeconds);
        return id;
    }

    async logRead(key: string, since?: string, maxCount = 100): Promise<BusEntry[]> {
        this.assertCount(maxCount);
        this.purgeExpired(this.logs, this.logExpiries, key);
        const log = this.logs.get(key) ?? [];
        const start =
            since === undefined ? 0 : log.findIndex(entry => this.compareIds(entry.id, since) > 0);
        if (start < 0) return [];
        return log
            .slice(start, start + maxCount)
            .map(entry => [entry.id, structuredClone(entry.payload)] as const);
    }

    async logTrim(key: string, beforeId?: string): Promise<void> {
        this.purgeExpired(this.logs, this.logExpiries, key);
        if (beforeId === undefined) {
            this.logs.delete(key);
            this.logExpiries.delete(key);
            return;
        }
        const log = this.logs.get(key);
        if (!log) return;
        this.logs.set(
            key,
            log.filter(entry => this.compareIds(entry.id, beforeId) >= 0)
        );
    }

    async publish(key: string, payload: BusPayload): Promise<void> {
        for (const subscriber of this.subscribers.get(key) ?? []) {
            subscriber.push(structuredClone(payload));
        }
    }

    async *subscribe(key: string, options: SubscribeOptions = {}): AsyncIterable<BusPayload> {
        const channel = new AsyncChannel<BusPayload>();
        const abort = (): void => channel.close();
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) channel.close();
        const subscribers = this.subscribers.get(key) ?? new Set<AsyncChannel<BusPayload>>();
        subscribers.add(channel);
        this.subscribers.set(key, subscribers);
        try {
            options.onReady?.();
            for await (const payload of channel) yield payload;
        } finally {
            options.signal?.removeEventListener('abort', abort);
            subscribers.delete(channel);
            channel.close();
            if (subscribers.size === 0) this.subscribers.delete(key);
        }
    }

    async acquireLock(
        key: string,
        _options: { ttlSeconds?: number } = {}
    ): Promise<MessageBusLock> {
        const token = await this.claimLock(key);
        let released = false;
        return {
            key,
            release: async () => {
                if (released) return;
                released = true;
                this.releaseToken(key, token);
            },
        };
    }

    async isLocked(key: string): Promise<boolean> {
        return this.locks.get(key)?.holder !== null && this.locks.get(key)?.holder !== undefined;
    }

    async tryLock(key: string, options: { ttlSeconds?: number } = {}): Promise<boolean> {
        const state = this.locks.get(key) ?? { holder: null, waiters: [] };
        if (state.holder !== null) return false;
        const token = randomUUID();
        state.holder = token;
        this.locks.set(key, state);
        this.tryLockTokens.set(key, token);
        if (options.ttlSeconds !== undefined) {
            setTimeout(() => this.releaseToken(key, token), options.ttlSeconds * 1_000).unref();
        }
        return true;
    }

    async unlock(key: string): Promise<void> {
        const token = this.tryLockTokens.get(key);
        if (!token) return;
        this.tryLockTokens.delete(key);
        this.releaseToken(key, token);
    }

    async registrySet(
        namespace: string,
        field: string,
        value: string,
        options: { ttlSeconds?: number } = {}
    ): Promise<void> {
        this.purgeExpired(this.registries, this.registryExpiries, namespace);
        const registry = this.registries.get(namespace) ?? new Map<string, string>();
        registry.set(field, value);
        this.registries.set(namespace, registry);
        this.refreshExpiry(this.registryExpiries, namespace, options.ttlSeconds);
    }

    async registrySetIf(
        namespace: string,
        field: string,
        value: string,
        options: { expected: string; ttlSeconds?: number }
    ): Promise<boolean> {
        this.purgeExpired(this.registries, this.registryExpiries, namespace);
        if (this.registries.get(namespace)?.get(field) !== options.expected) return false;
        this.registries.get(namespace)!.set(field, value);
        this.refreshExpiry(this.registryExpiries, namespace, options.ttlSeconds);
        return true;
    }

    async registryPop(namespace: string, field: string): Promise<string | null> {
        this.purgeExpired(this.registries, this.registryExpiries, namespace);
        const registry = this.registries.get(namespace);
        const value = registry?.get(field) ?? null;
        registry?.delete(field);
        return value;
    }

    async registryDelete(namespace: string, field: string): Promise<void> {
        this.purgeExpired(this.registries, this.registryExpiries, namespace);
        this.registries.get(namespace)?.delete(field);
    }

    async registryExists(namespace: string, field: string): Promise<boolean> {
        this.purgeExpired(this.registries, this.registryExpiries, namespace);
        return this.registries.get(namespace)?.has(field) ?? false;
    }

    async registryGetAll(namespace: string): Promise<Record<string, string>> {
        this.purgeExpired(this.registries, this.registryExpiries, namespace);
        return Object.fromEntries(this.registries.get(namespace) ?? []);
    }

    async registryGet(namespace: string, field: string): Promise<string | null> {
        this.purgeExpired(this.registries, this.registryExpiries, namespace);
        return this.registries.get(namespace)?.get(field) ?? null;
    }

    async registryDrop(namespace: string): Promise<void> {
        this.registries.delete(namespace);
        this.registryExpiries.delete(namespace);
    }

    private nextId(): string {
        this.sequence += 1;
        return `${this.sequence}-0`;
    }

    private compareIds(left: string, right: string): number {
        const [leftTime, leftSequence] = left.split('-').map(Number);
        const [rightTime, rightSequence] = right.split('-').map(Number);
        return leftTime - rightTime || leftSequence - rightSequence;
    }

    private assertCount(value: number): void {
        if (!Number.isInteger(value) || value < 0) {
            throw new Error('count must be a non-negative integer.');
        }
    }

    private async claimLock(key: string): Promise<string> {
        const state = this.locks.get(key) ?? { holder: null, waiters: [] };
        this.locks.set(key, state);
        if (state.holder === null) {
            const token = randomUUID();
            state.holder = token;
            return token;
        }
        return new Promise(resolve => state.waiters.push(resolve));
    }

    private releaseToken(key: string, token: string): void {
        const state = this.locks.get(key);
        if (!state || state.holder !== token) return;
        const waiter = state.waiters.shift();
        if (waiter) {
            const nextToken = randomUUID();
            state.holder = nextToken;
            waiter(nextToken);
        } else {
            state.holder = null;
            this.locks.delete(key);
        }
    }

    private refreshExpiry(expiries: Map<string, number>, key: string, ttl?: number): void {
        if (ttl !== undefined) expiries.set(key, Date.now() + ttl * 1_000);
    }

    private purgeExpired<T>(
        values: Map<string, T>,
        expiries: Map<string, number>,
        key: string
    ): void {
        const expiry = expiries.get(key);
        if (expiry !== undefined && expiry <= Date.now()) {
            values.delete(key);
            expiries.delete(key);
        }
    }
}
