/* eslint-disable jsdoc/require-jsdoc */

import type { ReMeConfig } from './reme-config';

export interface ReMeResponse {
    success?: boolean;
    answer?: unknown;
    metadata?: Record<string, unknown>;
    status?: number;
}

export interface ReMeApp {
    start(): Promise<void>;
    close(): Promise<void>;
    updateComponent(component: string, name: string, options: { model: unknown }): Promise<void>;
    runJob(
        name: string,
        parameters: Record<string, unknown>,
        options?: { signal?: AbortSignal }
    ): Promise<ReMeResponse>;
}

export interface ReMeHttpAppOptions {
    endpoint?: string;
    requestTimeoutMs?: number;
    backgroundTimeoutMs?: number;
    fetch?: typeof globalThis.fetch;
}

/** Zero-dependency adapter for the official ReMe HTTP job protocol. */
export class ReMeHttpApp implements ReMeApp {
    readonly endpoint: string;
    readonly requestTimeoutMs: number;
    readonly backgroundTimeoutMs: number;
    private readonly fetchImpl: typeof globalThis.fetch;

    constructor(options: ReMeHttpAppOptions = {}) {
        this.endpoint = (options.endpoint ?? 'http://127.0.0.1:2333').replace(/\/$/, '');
        this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
        this.backgroundTimeoutMs = options.backgroundTimeoutMs ?? 120_000;
        this.fetchImpl = options.fetch ?? globalThis.fetch;
        if (!this.fetchImpl) throw new Error('ReMeHttpApp requires a Fetch API implementation.');
    }

    async start(): Promise<void> {}

    async close(): Promise<void> {}

    async updateComponent(
        _component: string,
        _name: string,
        _options: { model: unknown }
    ): Promise<void> {
        throw new Error(
            'The ReMe HTTP protocol cannot inject in-process AgentScope models. ' +
                'Configure the ReMe service models or provide an app/appFactory driver.'
        );
    }

    async runJob(
        name: string,
        parameters: Record<string, unknown>,
        options: { signal?: AbortSignal } = {}
    ): Promise<ReMeResponse> {
        const background = name === 'auto_memory' || name === 'auto_dream';
        const controller = new AbortController();
        const abort = (): void => controller.abort();
        options.signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(
            () => controller.abort(),
            background ? this.backgroundTimeoutMs : this.requestTimeoutMs
        );
        try {
            const response = await this.fetchImpl(this.endpoint + '/' + name, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(parameters),
                signal: controller.signal,
            });
            const body = await response.json().catch(() => ({}));
            const decoded = isRecord(body) ? body : {};
            const success = response.ok && decoded.success !== false;
            return {
                success,
                status: response.status,
                answer: success
                    ? (decoded.answer ?? '')
                    : (decoded.answer ?? decoded.detail ?? 'HTTP ' + response.status),
                metadata: isRecord(decoded.metadata) ? decoded.metadata : {},
            };
        } catch (error) {
            return {
                success: false,
                status: 0,
                answer: error instanceof Error ? error.message : String(error),
                metadata: {},
            };
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', abort);
        }
    }
}

export type ReMeAppFactory = (config: ReMeConfig) => ReMeApp | Promise<ReMeApp>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
