/* eslint-disable jsdoc/require-jsdoc */

import { randomUUID } from 'node:crypto';

import type { WorkspaceBase } from '@agentscope-ai/agentscope/workspace';

import type { StorageBase } from '../storage';

export type IsolationPolicy = 'per_session' | 'per_agent' | 'per_user';

interface AssignWorkspaceOptions {
    userId: string;
    agentId: string;
    sessionId: string;
    signal?: AbortSignal;
}

class AsyncMutex {
    private tail = Promise.resolve();

    async run<T>(work: () => Promise<T>): Promise<T> {
        const previous = this.tail;
        let release = (): void => {};
        this.tail = new Promise<void>(resolve => {
            release = resolve;
        });
        await previous;
        try {
            return await work();
        } finally {
            release();
        }
    }
}

/** Shared isolation and storage-binding behavior for workspace managers. */
export abstract class WorkspaceManagerBase<TWorkspace extends WorkspaceBase = WorkspaceBase> {
    readonly isolation: IsolationPolicy;
    protected storage: StorageBase | null = null;
    private readonly bindingLocks = new Map<string, AsyncMutex>();
    private readonly reserved = new Map<string, string>();

    constructor(options: { isolation?: IsolationPolicy } = {}) {
        this.isolation = options.isolation ?? 'per_agent';
    }

    bindStorage(storage: StorageBase): void {
        this.storage = storage;
    }

    async assignWorkspaceId(options: AssignWorkspaceOptions): Promise<string> {
        if (this.isolation === 'per_user') return blake2b64(`user::${options.userId}`);
        if (this.isolation === 'per_session') return this.mintWorkspaceId(options.signal);
        if (!this.storage) return blake2b64(`${options.userId}::${options.agentId}`);

        const key = `${options.userId}\0${options.agentId}`;
        const mutex = this.bindingLocks.get(key) ?? new AsyncMutex();
        this.bindingLocks.set(key, mutex);
        return mutex.run(async () => {
            for (const session of await this.storage!.listSessions(
                options.userId,
                options.agentId
            )) {
                if (session.config.workspace_id) {
                    this.reserved.delete(key);
                    return session.config.workspace_id;
                }
            }
            const reserved = this.reserved.get(key);
            if (reserved) return reserved;
            const workspaceId = await this.mintWorkspaceId(options.signal);
            this.reserved.set(key, workspaceId);
            return workspaceId;
        });
    }

    async open(): Promise<this> {
        return this;
    }

    async closeManager(): Promise<void> {
        await this.closeAll();
    }

    abstract getWorkspace(
        userId: string,
        agentId: string,
        sessionId: string,
        workspaceId?: string | null
    ): Promise<TWorkspace>;
    abstract close(workspaceId: string): Promise<void>;
    abstract closeAll(): Promise<void>;

    protected async mintWorkspaceId(_signal?: AbortSignal): Promise<string> {
        return randomUUID().replaceAll('-', '');
    }
}

const MASK_64 = (1n << 64n) - 1n;
const BLAKE2B_IV = [
    0x6a09e667f3bcc908n,
    0xbb67ae8584caa73bn,
    0x3c6ef372fe94f82bn,
    0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n,
    0x9b05688c2b3e6c1fn,
    0x1f83d9abfb41bd6bn,
    0x5be0cd19137e2179n,
];
const BLAKE2B_SIGMA = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

function rotateRight(value: bigint, bits: bigint): bigint {
    return ((value >> bits) | (value << (64n - bits))) & MASK_64;
}

function blakeMix(
    values: bigint[],
    a: number,
    b: number,
    c: number,
    d: number,
    x: bigint,
    y: bigint
): void {
    values[a] = (values[a] + values[b] + x) & MASK_64;
    values[d] = rotateRight(values[d] ^ values[a], 32n);
    values[c] = (values[c] + values[d]) & MASK_64;
    values[b] = rotateRight(values[b] ^ values[c], 24n);
    values[a] = (values[a] + values[b] + y) & MASK_64;
    values[d] = rotateRight(values[d] ^ values[a], 16n);
    values[c] = (values[c] + values[d]) & MASK_64;
    values[b] = rotateRight(values[b] ^ values[c], 63n);
}

function blake2b64(input: string): string {
    const bytes = new TextEncoder().encode(input);
    const state = [...BLAKE2B_IV];
    state[0] ^= 0x01010008n;
    const blockCount = Math.max(1, Math.ceil(bytes.length / 128));
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
        const start = blockIndex * 128;
        const length = Math.min(128, bytes.length - start);
        const block = new Uint8Array(128);
        block.set(bytes.slice(start, start + length));
        const words = Array.from({ length: 16 }, (_, wordIndex) => {
            let word = 0n;
            for (let byteIndex = 0; byteIndex < 8; byteIndex += 1) {
                word |= BigInt(block[wordIndex * 8 + byteIndex]) << BigInt(byteIndex * 8);
            }
            return word;
        });
        const values = [...state, ...BLAKE2B_IV];
        const total = BigInt(start + length);
        values[12] ^= total & MASK_64;
        values[13] ^= total >> 64n;
        if (blockIndex === blockCount - 1) values[14] ^= MASK_64;
        for (let round = 0; round < 12; round += 1) {
            const sigma = BLAKE2B_SIGMA[round % 10];
            blakeMix(values, 0, 4, 8, 12, words[sigma[0]], words[sigma[1]]);
            blakeMix(values, 1, 5, 9, 13, words[sigma[2]], words[sigma[3]]);
            blakeMix(values, 2, 6, 10, 14, words[sigma[4]], words[sigma[5]]);
            blakeMix(values, 3, 7, 11, 15, words[sigma[6]], words[sigma[7]]);
            blakeMix(values, 0, 5, 10, 15, words[sigma[8]], words[sigma[9]]);
            blakeMix(values, 1, 6, 11, 12, words[sigma[10]], words[sigma[11]]);
            blakeMix(values, 2, 7, 8, 13, words[sigma[12]], words[sigma[13]]);
            blakeMix(values, 3, 4, 9, 14, words[sigma[14]], words[sigma[15]]);
        }
        for (let index = 0; index < 8; index += 1) {
            state[index] = state[index] ^ values[index] ^ values[index + 8];
        }
    }
    return Array.from({ length: 8 }, (_, index) =>
        Number((state[0] >> BigInt(index * 8)) & 0xffn)
            .toString(16)
            .padStart(2, '0')
    ).join('');
}
