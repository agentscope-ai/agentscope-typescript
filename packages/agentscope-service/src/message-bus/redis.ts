/* eslint-disable jsdoc/require-jsdoc */

import { randomUUID } from 'node:crypto';

import { MessageBus } from './base';
import type { BusEntry, BusPayload, MessageBusLock, SubscribeOptions } from './base';

interface RedisStreamEntry {
    id: string;
    message: Record<string, string>;
}

interface NodeRedisBusClientLike {
    isOpen?: boolean;
    connect(): Promise<unknown>;
    quit(): Promise<unknown>;
    duplicate(): NodeRedisBusClientLike;
    xAdd(
        key: string,
        id: string,
        message: Record<string, string>,
        options?: Record<string, unknown>
    ): Promise<string>;
    xRange(
        key: string,
        start: string,
        end: string,
        options?: { COUNT?: number }
    ): Promise<RedisStreamEntry[]>;
    xTrim(key: string, strategy: 'MINID', threshold: string): Promise<number>;
    eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
    expire(key: string, seconds: number): Promise<boolean | number>;
    del(key: string): Promise<number>;
    publish(key: string, payload: string): Promise<number>;
    subscribe(key: string, listener: (message: string) => void): Promise<unknown>;
    unsubscribe(key: string): Promise<unknown>;
    set(
        key: string,
        value: string,
        options?: { NX?: boolean; EX?: number }
    ): Promise<string | null>;
    exists(key: string): Promise<number>;
    get(key: string): Promise<string | null>;
    hSet(key: string, field: string, value: string): Promise<number>;
    hDel(key: string, field: string): Promise<number>;
    hExists(key: string, field: string): Promise<boolean | number>;
    hGetAll(key: string): Promise<Record<string, string>>;
    hGet(key: string, field: string): Promise<string | null>;
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

const QUEUE_DRAIN_SCRIPT = `
local entries = redis.call('XRANGE', KEYS[1], '-', '+', 'COUNT', ARGV[1])
for _, entry in ipairs(entries) do redis.call('XDEL', KEYS[1], entry[1]) end
return entries
`;

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

const RENEW_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('EXPIRE', KEYS[1], ARGV[2])
`;

export interface RedisMessageBusOptions {
    url?: string;
    client?: NodeRedisBusClientLike;
    clientOptions?: Record<string, unknown>;
    lockRetryDelayMs?: number;
}

/** Redis Streams, Pub/Sub, Hashes, and token-owned locks message bus. */
export class RedisMessageBus extends MessageBus {
    private client: NodeRedisBusClientLike | null;
    private readonly externalClient: NodeRedisBusClientLike | null;
    private readonly url: string;
    private readonly clientOptions: Record<string, unknown>;
    private readonly lockRetryDelayMs: number;
    private readonly tryLockTokens = new Map<string, string>();
    private readonly subscriptions = new Set<AsyncChannel<BusPayload>>();

    constructor(options: RedisMessageBusOptions = {}) {
        super();
        this.externalClient = options.client ?? null;
        this.client = options.client ?? null;
        this.url = options.url ?? 'redis://localhost:6379';
        this.clientOptions = options.clientOptions ?? {};
        this.lockRetryDelayMs = options.lockRetryDelayMs ?? 100;
    }

    async open(): Promise<this> {
        if (!this.client) {
            let redis: { createClient(options: Record<string, unknown>): NodeRedisBusClientLike };
            try {
                redis = (await import('redis')) as unknown as {
                    createClient(options: Record<string, unknown>): NodeRedisBusClientLike;
                };
            } catch (error) {
                throw new Error("The optional 'redis' package is required for RedisMessageBus.", {
                    cause: error,
                });
            }
            this.client = redis.createClient({ url: this.url, ...this.clientOptions });
        }
        if (!this.client.isOpen) await this.client.connect();
        return this;
    }

    async close(): Promise<void> {
        for (const subscription of this.subscriptions) subscription.close();
        this.subscriptions.clear();
        if (this.client && this.client !== this.externalClient && this.client.isOpen) {
            await this.client.quit();
        }
        if (!this.externalClient) this.client = null;
    }

    async queuePush(
        key: string,
        payload: BusPayload,
        options: { ttlSeconds?: number } = {}
    ): Promise<string> {
        const id = await this.requireClient().xAdd(key, '*', {
            payload: JSON.stringify(payload),
        });
        if (options.ttlSeconds !== undefined) {
            await this.requireClient().expire(key, options.ttlSeconds);
        }
        return id;
    }

    async queueDrain(key: string, maxCount = 100): Promise<BusEntry[]> {
        this.assertCount(maxCount);
        if (maxCount === 0) return [];
        const result = await this.requireClient().eval(QUEUE_DRAIN_SCRIPT, {
            keys: [key],
            arguments: [String(maxCount)],
        });
        return this.parseLuaEntries(result);
    }

    async queueDelete(key: string): Promise<void> {
        await this.requireClient().del(key);
    }

    async logAppend(
        key: string,
        payload: BusPayload,
        options: { ttlSeconds?: number; maxLength?: number } = {}
    ): Promise<string> {
        const xAddOptions =
            options.maxLength === undefined
                ? undefined
                : {
                      TRIM: {
                          strategy: 'MAXLEN',
                          strategyModifier: '~',
                          threshold: options.maxLength,
                      },
                  };
        const id = await this.requireClient().xAdd(
            key,
            '*',
            { payload: JSON.stringify(payload) },
            xAddOptions
        );
        if (options.ttlSeconds !== undefined) {
            await this.requireClient().expire(key, options.ttlSeconds);
        }
        return id;
    }

    async logRead(key: string, since?: string, maxCount = 100): Promise<BusEntry[]> {
        this.assertCount(maxCount);
        if (maxCount === 0) return [];
        const entries = await this.requireClient().xRange(
            key,
            since === undefined ? '-' : `(${since}`,
            '+',
            { COUNT: maxCount }
        );
        return entries
            .filter(entry => typeof entry.message.payload === 'string')
            .map(entry => [entry.id, JSON.parse(entry.message.payload) as BusPayload] as const);
    }

    async logTrim(key: string, beforeId?: string): Promise<void> {
        if (beforeId === undefined) await this.requireClient().del(key);
        else await this.requireClient().xTrim(key, 'MINID', beforeId);
    }

    async publish(key: string, payload: BusPayload): Promise<void> {
        await this.requireClient().publish(key, JSON.stringify(payload));
    }

    async *subscribe(key: string, options: SubscribeOptions = {}): AsyncIterable<BusPayload> {
        const subscriber = this.requireClient().duplicate();
        const channel = new AsyncChannel<BusPayload>();
        const abort = (): void => channel.close();
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) channel.close();
        this.subscriptions.add(channel);
        try {
            if (!subscriber.isOpen) await subscriber.connect();
            await subscriber.subscribe(key, raw => {
                channel.push(JSON.parse(raw) as BusPayload);
            });
            options.onReady?.();
            for await (const payload of channel) yield payload;
        } finally {
            options.signal?.removeEventListener('abort', abort);
            this.subscriptions.delete(channel);
            channel.close();
            if (subscriber.isOpen) {
                await subscriber.unsubscribe(key);
                await subscriber.quit();
            }
        }
    }

    async acquireLock(key: string, options: { ttlSeconds?: number } = {}): Promise<MessageBusLock> {
        const ttlSeconds = options.ttlSeconds ?? 600;
        const token = randomUUID();
        while (
            !(await this.requireClient().set(key, token, {
                NX: true,
                EX: ttlSeconds,
            }))
        ) {
            await new Promise(resolve => setTimeout(resolve, this.lockRetryDelayMs));
        }
        const heartbeat = setInterval(
            () => {
                void this.renewLock(key, token, ttlSeconds);
            },
            Math.max(1_000, (ttlSeconds * 1_000) / 2)
        );
        heartbeat.unref();
        let released = false;
        return {
            key,
            release: async () => {
                if (released) return;
                released = true;
                clearInterval(heartbeat);
                await this.releaseLock(key, token);
            },
        };
    }

    async isLocked(key: string): Promise<boolean> {
        return (await this.requireClient().exists(key)) > 0;
    }

    async tryLock(key: string, options: { ttlSeconds?: number } = {}): Promise<boolean> {
        const token = randomUUID();
        const result = await this.requireClient().set(key, token, {
            NX: true,
            EX: options.ttlSeconds ?? 600,
        });
        if (!result) return false;
        this.tryLockTokens.set(key, token);
        return true;
    }

    async unlock(key: string): Promise<void> {
        const token = this.tryLockTokens.get(key);
        if (!token) return;
        this.tryLockTokens.delete(key);
        await this.releaseLock(key, token);
    }

    async registrySet(
        namespace: string,
        field: string,
        value: string,
        options: { ttlSeconds?: number } = {}
    ): Promise<void> {
        await this.requireClient().hSet(namespace, field, value);
        if (options.ttlSeconds !== undefined) {
            await this.requireClient().expire(namespace, options.ttlSeconds);
        }
    }

    async registryDelete(namespace: string, field: string): Promise<void> {
        await this.requireClient().hDel(namespace, field);
    }

    async registryExists(namespace: string, field: string): Promise<boolean> {
        return Boolean(await this.requireClient().hExists(namespace, field));
    }

    async registryGetAll(namespace: string): Promise<Record<string, string>> {
        return this.requireClient().hGetAll(namespace);
    }

    async registryGet(namespace: string, field: string): Promise<string | null> {
        return this.requireClient().hGet(namespace, field);
    }

    async registryDrop(namespace: string): Promise<void> {
        await this.requireClient().del(namespace);
    }

    private async releaseLock(key: string, token: string): Promise<void> {
        await this.requireClient().eval(RELEASE_LOCK_SCRIPT, {
            keys: [key],
            arguments: [token],
        });
    }

    private async renewLock(key: string, token: string, ttlSeconds: number): Promise<void> {
        try {
            await this.requireClient().eval(RENEW_LOCK_SCRIPT, {
                keys: [key],
                arguments: [token, String(ttlSeconds)],
            });
        } catch {
            // A failed heartbeat lets the lease expire naturally.
        }
    }

    private parseLuaEntries(input: unknown): BusEntry[] {
        if (!Array.isArray(input)) return [];
        const entries: BusEntry[] = [];
        for (const rawEntry of input) {
            if (!Array.isArray(rawEntry) || rawEntry.length < 2) continue;
            const id = String(rawEntry[0]);
            const fields = rawEntry[1];
            if (!Array.isArray(fields)) continue;
            for (let index = 0; index + 1 < fields.length; index += 2) {
                if (String(fields[index]) === 'payload') {
                    entries.push([id, JSON.parse(String(fields[index + 1])) as BusPayload]);
                    break;
                }
            }
        }
        return entries;
    }

    private assertCount(value: number): void {
        if (!Number.isInteger(value) || value < 0) {
            throw new Error('count must be a non-negative integer.');
        }
    }

    private requireClient(): NodeRedisBusClientLike {
        if (!this.client) throw new Error('Redis message bus is not open.');
        return this.client;
    }
}
