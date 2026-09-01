/* eslint-disable jsdoc/require-jsdoc */

import type { RedisDriver } from '../src/storage';

type StoredValue =
    | { type: 'string'; value: string }
    | { type: 'set'; value: Set<string> }
    | { type: 'list'; value: string[] };

/** Deterministic RedisDriver used by adapter contract tests. */
export class FakeRedisDriver implements RedisDriver {
    private readonly values = new Map<string, StoredValue>();
    private readonly expiresAt = new Map<string, number>();

    async open(): Promise<void> {}

    async close(): Promise<void> {
        this.values.clear();
        this.expiresAt.clear();
    }

    async get(key: string): Promise<string | null> {
        const stored = this.read(key);
        return stored?.type === 'string' ? stored.value : null;
    }

    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
        this.values.set(key, { type: 'string', value });
        this.setExpiry(key, ttlSeconds);
    }

    async delete(key: string): Promise<boolean> {
        this.expiresAt.delete(key);
        return this.values.delete(key);
    }

    async setAdd(key: string, ...values: string[]): Promise<void> {
        const stored = this.read(key);
        const set = stored?.type === 'set' ? stored.value : new Set<string>();
        for (const value of values) set.add(value);
        this.values.set(key, { type: 'set', value: set });
    }

    async setMembers(key: string): Promise<string[]> {
        const stored = this.read(key);
        return stored?.type === 'set' ? [...stored.value] : [];
    }

    async setRemove(key: string, ...values: string[]): Promise<void> {
        const stored = this.read(key);
        if (stored?.type !== 'set') return;
        for (const value of values) stored.value.delete(value);
    }

    async listLength(key: string): Promise<number> {
        const stored = this.read(key);
        return stored?.type === 'list' ? stored.value.length : 0;
    }

    async listIndex(key: string, index: number): Promise<string | null> {
        const stored = this.read(key);
        if (stored?.type !== 'list') return null;
        const resolved = this.resolveIndex(stored.value, index);
        return resolved >= 0 && resolved < stored.value.length ? stored.value[resolved] : null;
    }

    async listRange(key: string, start: number, end: number): Promise<string[]> {
        const stored = this.read(key);
        if (stored?.type !== 'list') return [];
        const resolvedStart = Math.max(0, this.resolveIndex(stored.value, start));
        const resolvedEnd = Math.min(stored.value.length - 1, this.resolveIndex(stored.value, end));
        return resolvedEnd < resolvedStart
            ? []
            : stored.value.slice(resolvedStart, resolvedEnd + 1);
    }

    async listPush(key: string, value: string): Promise<void> {
        const stored = this.read(key);
        const list = stored?.type === 'list' ? stored.value : [];
        list.push(value);
        this.values.set(key, { type: 'list', value: list });
    }

    async listSet(key: string, index: number, value: string): Promise<void> {
        const stored = this.read(key);
        if (stored?.type !== 'list') throw new Error(`Redis list ${key} does not exist.`);
        const resolved = this.resolveIndex(stored.value, index);
        if (resolved < 0 || resolved >= stored.value.length) {
            throw new Error(`Redis list index ${index} is out of range.`);
        }
        stored.value[resolved] = value;
    }

    async expire(key: string, ttlSeconds: number): Promise<void> {
        if (this.read(key)) this.setExpiry(key, ttlSeconds);
    }

    async compareAndSet(
        key: string,
        expected: string | null,
        value: string,
        ttlSeconds?: number
    ): Promise<boolean> {
        const stored = this.read(key);
        const current = stored?.type === 'string' ? stored.value : null;
        if (current !== expected) return false;
        this.values.set(key, { type: 'string', value });
        this.setExpiry(key, ttlSeconds);
        return true;
    }

    async deleteIfValue(key: string, expected: string): Promise<boolean> {
        const stored = this.read(key);
        if (stored?.type !== 'string' || stored.value !== expected) return false;
        this.expiresAt.delete(key);
        return this.values.delete(key);
    }

    private read(key: string): StoredValue | undefined {
        const expiry = this.expiresAt.get(key);
        if (expiry !== undefined && expiry <= Date.now()) {
            this.values.delete(key);
            this.expiresAt.delete(key);
            return undefined;
        }
        return this.values.get(key);
    }

    private resolveIndex(values: string[], index: number): number {
        return index < 0 ? values.length + index : index;
    }

    private setExpiry(key: string, ttlSeconds?: number): void {
        if (ttlSeconds === undefined) {
            this.expiresAt.delete(key);
        } else {
            this.expiresAt.set(key, Date.now() + ttlSeconds * 1_000);
        }
    }
}
