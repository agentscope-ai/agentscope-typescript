/* eslint-disable jsdoc/require-jsdoc */

import { logger } from '@agentscope-ai/agentscope/logger';

import type { DingTalkFetch } from './openapi';

const OPEN_CONNECTION_API = 'https://api.dingtalk.com/v1.0/gateway/connections/open';
const ROBOT_TOPIC = '/v1.0/im/bot/messages/get';
const CARD_TOPIC = '/v1.0/card/instances/callback';

interface DingTalkStreamMessage {
    type?: string;
    headers?: { topic?: string; messageId?: string; contentType?: string };
    data?: unknown;
}

export interface DingTalkStreamHandlers {
    onMessage(payload: Record<string, unknown>): Promise<void>;
    onCardAction(payload: Record<string, unknown>): Promise<void>;
    onState?(state: 'connecting' | 'connected' | 'retrying', error?: string): void;
}

export interface DingTalkStreamTransport {
    listen(handlers: DingTalkStreamHandlers, signal: AbortSignal): Promise<void>;
    close(): Promise<void>;
}

interface WebSocketLike {
    on(event: 'open', listener: () => void): this;
    on(event: 'message', listener: (data: unknown) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    send(data: string): void;
    close(): void;
    ping?(): void;
}

export interface NativeDingTalkStreamOptions {
    clientId: string;
    clientSecret: string;
    fetch?: DingTalkFetch;
    createWebSocket?: (url: string) => Promise<WebSocketLike> | WebSocketLike;
    reconnectDelayMs?: number;
}

/** Safe, cancellable implementation of DingTalk's documented Stream wire protocol. */
export class NativeDingTalkStreamTransport implements DingTalkStreamTransport {
    private readonly clientId: string;
    private readonly clientSecret: string;
    private readonly fetcher: DingTalkFetch;
    private readonly createWebSocket: (url: string) => Promise<WebSocketLike> | WebSocketLike;
    private readonly reconnectDelayMs: number;
    private socket: WebSocketLike | null = null;
    private keepalive: ReturnType<typeof setInterval> | null = null;

    constructor(options: NativeDingTalkStreamOptions) {
        this.clientId = options.clientId;
        this.clientSecret = options.clientSecret;
        this.fetcher = options.fetch ?? fetch;
        this.createWebSocket = options.createWebSocket ?? defaultWebSocket;
        this.reconnectDelayMs = options.reconnectDelayMs ?? 3_000;
    }

    async listen(handlers: DingTalkStreamHandlers, signal: AbortSignal): Promise<void> {
        let everConnected = false;
        while (!signal.aborted) {
            handlers.onState?.(everConnected ? 'retrying' : 'connecting');
            try {
                const endpoint = await this.openConnection(signal);
                await this.runSocket(endpoint, handlers, signal, () => {
                    everConnected = true;
                    handlers.onState?.('connected');
                });
            } catch (error) {
                if (signal.aborted) break;
                const message = errorMessage(error);
                handlers.onState?.(
                    everConnected ? 'retrying' : 'connecting',
                    everConnected ? message : undefined
                );
                logger.warning(`DingTalk Stream connection failed: ${message}`);
            }
            if (!signal.aborted) await abortableDelay(this.reconnectDelayMs, signal);
        }
    }

    async close(): Promise<void> {
        if (this.keepalive) clearInterval(this.keepalive);
        this.keepalive = null;
        this.socket?.close();
        this.socket = null;
    }

    private async openConnection(signal: AbortSignal): Promise<string> {
        const response = await this.fetcher(OPEN_CONNECTION_API, {
            method: 'POST',
            signal,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                clientId: this.clientId,
                clientSecret: this.clientSecret,
                subscriptions: [
                    { type: 'CALLBACK', topic: ROBOT_TOPIC },
                    { type: 'CALLBACK', topic: CARD_TOPIC },
                ],
                ua: 'agentscope-typescript',
            }),
        });
        if (!response.ok)
            throw new Error(`DingTalk Stream handshake failed: HTTP ${response.status}`);
        const data = asRecord(await response.json());
        const endpoint = String(data.endpoint ?? '');
        const ticket = String(data.ticket ?? '');
        if (!endpoint || !ticket) throw new Error('DingTalk Stream handshake returned no endpoint');
        const url = new URL(endpoint);
        url.searchParams.set('ticket', ticket);
        return url.toString();
    }

    private async runSocket(
        url: string,
        handlers: DingTalkStreamHandlers,
        signal: AbortSignal,
        onOpen: () => void
    ): Promise<void> {
        const socket = await this.createWebSocket(url);
        this.socket = socket;
        await new Promise<void>((resolve, reject) => {
            let opened = false;
            let settled = false;
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', abort);
                if (this.keepalive) clearInterval(this.keepalive);
                this.keepalive = null;
                if (this.socket === socket) this.socket = null;
                if (error) reject(error);
                else resolve();
            };
            const abort = () => {
                socket.close();
                finish();
            };
            signal.addEventListener('abort', abort, { once: true });
            socket.on('open', () => {
                opened = true;
                onOpen();
                this.keepalive = setInterval(() => socket.ping?.(), 60_000);
            });
            socket.on('message', data => {
                void this.routeMessage(socket, data, handlers).catch(error => {
                    logger.error(`DingTalk Stream callback failed: ${errorMessage(error)}`);
                });
            });
            socket.on('error', error => {
                if (!opened) finish(error);
                else logger.warning(`DingTalk Stream socket error: ${error.message}`);
            });
            socket.on('close', () => finish());
        });
    }

    private async routeMessage(
        socket: WebSocketLike,
        raw: unknown,
        handlers: DingTalkStreamHandlers
    ): Promise<void> {
        let message: DingTalkStreamMessage;
        try {
            const text = Buffer.isBuffer(raw)
                ? raw.toString('utf8')
                : raw instanceof ArrayBuffer
                  ? Buffer.from(raw).toString('utf8')
                  : String(raw);
            message = JSON.parse(text) as DingTalkStreamMessage;
        } catch {
            return;
        }
        const topic = message.headers?.topic ?? '';
        if (message.type === 'SYSTEM' && topic === 'disconnect') {
            socket.close();
            return;
        }
        if (message.type === 'SYSTEM' && topic === 'ping') {
            this.ack(socket, message, 200, 'OK', asRecord(message.data));
            return;
        }
        if (message.type !== 'CALLBACK') return;
        const payload = asRecordOrJSON(message.data);
        try {
            if (topic === ROBOT_TOPIC) await handlers.onMessage(payload);
            else if (topic === CARD_TOPIC) await handlers.onCardAction(payload);
            else return;
            this.ack(socket, message, 200, 'OK', {});
        } catch (error) {
            this.ack(socket, message, 500, 'ERROR', {});
            throw error;
        }
    }

    private ack(
        socket: WebSocketLike,
        message: DingTalkStreamMessage,
        code: number,
        status: string,
        data: Record<string, unknown>
    ): void {
        socket.send(
            JSON.stringify({
                code,
                headers: {
                    contentType: 'application/json',
                    messageId: message.headers?.messageId ?? '',
                },
                message: status,
                data: JSON.stringify(data),
            })
        );
    }
}

async function defaultWebSocket(url: string): Promise<WebSocketLike> {
    try {
        const module = await import('ws');
        return new module.default(url) as unknown as WebSocketLike;
    } catch (error) {
        throw new Error(
            `DingTalk channel requires the optional 'ws' package: ${errorMessage(error)}`
        );
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function asRecordOrJSON(value: unknown): Record<string, unknown> {
    if (typeof value !== 'string') return asRecord(value);
    try {
        return asRecord(JSON.parse(value));
    } catch {
        return {};
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>(resolve => {
        const timer = setTimeout(done, milliseconds);
        function done() {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        }
        signal.addEventListener('abort', done, { once: true });
    });
}
