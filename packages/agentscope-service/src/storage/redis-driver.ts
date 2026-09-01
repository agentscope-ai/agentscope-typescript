/* eslint-disable jsdoc/require-jsdoc */

/** Redis operations required by the service storage adapter. */
export interface RedisDriver {
    open(): Promise<void>;
    close(): Promise<void>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttlSeconds?: number): Promise<void>;
    delete(key: string): Promise<boolean>;
    setAdd(key: string, ...values: string[]): Promise<void>;
    setMembers(key: string): Promise<string[]>;
    setRemove(key: string, ...values: string[]): Promise<void>;
    listLength(key: string): Promise<number>;
    listIndex(key: string, index: number): Promise<string | null>;
    listRange(key: string, start: number, end: number): Promise<string[]>;
    listPush(key: string, value: string): Promise<void>;
    listSet(key: string, index: number, value: string): Promise<void>;
    expire(key: string, ttlSeconds: number): Promise<void>;
    compareAndSet(
        key: string,
        expected: string | null,
        value: string,
        ttlSeconds?: number
    ): Promise<boolean>;
    deleteIfValue(key: string, expected: string): Promise<boolean>;
}

interface NodeRedisClientLike {
    isOpen?: boolean;
    connect(): Promise<unknown>;
    quit(): Promise<unknown>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<unknown>;
    del(key: string): Promise<number>;
    sAdd(key: string, values: string | string[]): Promise<number>;
    sMembers(key: string): Promise<string[]>;
    sRem(key: string, values: string | string[]): Promise<number>;
    lLen(key: string): Promise<number>;
    lIndex(key: string, index: number): Promise<string | null>;
    lRange(key: string, start: number, end: number): Promise<string[]>;
    rPush(key: string, value: string): Promise<number>;
    lSet(key: string, index: number, value: string): Promise<unknown>;
    expire(key: string, seconds: number): Promise<boolean | number>;
    eval(
        script: string,
        options: { keys: string[]; arguments: string[] }
    ): Promise<number | string>;
}

const COMPARE_AND_SET_SCRIPT = `
local current = redis.call('GET', KEYS[1])
local expects_nil = ARGV[1] == '1'
if expects_nil then
  if current ~= false then return 0 end
elseif current == false or current ~= ARGV[2] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[3])
local ttl = tonumber(ARGV[4])
if ttl ~= nil and ttl > 0 then redis.call('EXPIRE', KEYS[1], ttl) end
return 1
`;

const DELETE_IF_VALUE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == false or current ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

export interface NodeRedisDriverOptions {
    url?: string;
    client?: NodeRedisClientLike;
    clientOptions?: Record<string, unknown>;
}

/** Adapter around the optional official `redis` package. */
export class NodeRedisDriver implements RedisDriver {
    private client: NodeRedisClientLike | null;
    private readonly externalClient: NodeRedisClientLike | null;
    private readonly url: string;
    private readonly clientOptions: Record<string, unknown>;

    constructor(options: NodeRedisDriverOptions = {}) {
        this.externalClient = options.client ?? null;
        this.client = options.client ?? null;
        this.url = options.url ?? 'redis://localhost:6379';
        this.clientOptions = options.clientOptions ?? {};
    }

    async open(): Promise<void> {
        if (!this.client) {
            let redis: { createClient(options: Record<string, unknown>): NodeRedisClientLike };
            try {
                redis = (await import('redis')) as unknown as {
                    createClient(options: Record<string, unknown>): NodeRedisClientLike;
                };
            } catch (error) {
                throw new Error("The optional 'redis' package is required for RedisStorage.", {
                    cause: error,
                });
            }
            this.client = redis.createClient({ url: this.url, ...this.clientOptions });
        }
        if (!this.client.isOpen) await this.client.connect();
    }

    async close(): Promise<void> {
        if (this.client && this.client !== this.externalClient && this.client.isOpen) {
            await this.client.quit();
        }
        if (!this.externalClient) this.client = null;
    }

    async get(key: string): Promise<string | null> {
        return this.requireClient().get(key);
    }

    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
        await this.requireClient().set(key, value);
        if (ttlSeconds !== undefined) await this.expire(key, ttlSeconds);
    }

    async delete(key: string): Promise<boolean> {
        return (await this.requireClient().del(key)) > 0;
    }

    async setAdd(key: string, ...values: string[]): Promise<void> {
        if (values.length > 0) await this.requireClient().sAdd(key, values);
    }

    async setMembers(key: string): Promise<string[]> {
        return this.requireClient().sMembers(key);
    }

    async setRemove(key: string, ...values: string[]): Promise<void> {
        if (values.length > 0) await this.requireClient().sRem(key, values);
    }

    async listLength(key: string): Promise<number> {
        return this.requireClient().lLen(key);
    }

    async listIndex(key: string, index: number): Promise<string | null> {
        return this.requireClient().lIndex(key, index);
    }

    async listRange(key: string, start: number, end: number): Promise<string[]> {
        return this.requireClient().lRange(key, start, end);
    }

    async listPush(key: string, value: string): Promise<void> {
        await this.requireClient().rPush(key, value);
    }

    async listSet(key: string, index: number, value: string): Promise<void> {
        await this.requireClient().lSet(key, index, value);
    }

    async expire(key: string, ttlSeconds: number): Promise<void> {
        await this.requireClient().expire(key, ttlSeconds);
    }

    async compareAndSet(
        key: string,
        expected: string | null,
        value: string,
        ttlSeconds?: number
    ): Promise<boolean> {
        const result = await this.requireClient().eval(COMPARE_AND_SET_SCRIPT, {
            keys: [key],
            arguments: [
                expected === null ? '1' : '0',
                expected ?? '',
                value,
                String(ttlSeconds ?? 0),
            ],
        });
        return Number(result) === 1;
    }

    async deleteIfValue(key: string, expected: string): Promise<boolean> {
        const result = await this.requireClient().eval(DELETE_IF_VALUE_SCRIPT, {
            keys: [key],
            arguments: [expected],
        });
        return Number(result) === 1;
    }

    private requireClient(): NodeRedisClientLike {
        if (!this.client) throw new Error('Redis driver is not open.');
        return this.client;
    }
}
