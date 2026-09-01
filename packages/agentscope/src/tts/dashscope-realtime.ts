/* eslint-disable jsdoc/require-jsdoc */

import WebSocket from 'ws';

import { DashScopeCredential } from '../credential';
import { TTSModelBase, TTSResponse } from './base';
import { RealtimeAudioBuffer } from './realtime-buffer';
import { DASHSCOPE_TTS_PARAMETER_SCHEMA } from './schemas';
import type { TTSModelCard } from '../model/card';
import { listModelCards } from '../model/card-registry';

export interface DashScopeRealtimeTTSParameters extends Record<string, unknown> {
    voice: string;
}

export interface DashScopeRealtimeTTSClient {
    connect(): Promise<void>;
    close(): Promise<void> | void;
    updateSession(options: { voice: string; mode: 'server_commit' }): Promise<void> | void;
    appendText(text: string): Promise<void> | void;
    commit(): Promise<void> | void;
    finish(): Promise<void> | void;
}

export type DashScopeRealtimeClientFactory = (options: {
    credential: DashScopeCredential;
    model: string;
    onEvent: (event: Record<string, unknown>) => void;
    onClose: () => void;
}) => DashScopeRealtimeTTSClient;

export interface DashScopeRealtimeTTSModelOptions {
    credential: DashScopeCredential;
    model?: string;
    parameters?: Partial<DashScopeRealtimeTTSParameters>;
    stream?: boolean;
    coldStartLength?: number | null;
    coldStartWords?: number | null;
    maxRetries?: number;
    retryDelay?: number;
    clientFactory?: DashScopeRealtimeClientFactory;
}

/** DashScope realtime WebSocket TTS model. */
export class DashScopeRealtimeTTSModel extends TTSModelBase<DashScopeRealtimeTTSParameters> {
    readonly type = 'dashscope_realtime_tts' as const;
    readonly coldStartLength: number | null;
    readonly coldStartWords: number | null;
    readonly maxRetries: number;
    readonly retryDelay: number;
    private readonly clientFactory: DashScopeRealtimeClientFactory;
    private readonly audio = new RealtimeAudioBuffer();
    private client: DashScopeRealtimeTTSClient | null = null;
    private connected = false;
    private coldStartBuffer = '';
    private coldStartDone = false;
    private accumulatedText = '';

    constructor(options: DashScopeRealtimeTTSModelOptions) {
        super({
            credential: options.credential,
            model: options.model ?? 'qwen3-tts-flash-realtime',
            parameters: { voice: options.parameters?.voice ?? 'Cherry' },
            stream: options.stream,
            realtime: true,
        });
        this.coldStartLength = options.coldStartLength ?? null;
        this.coldStartWords = options.coldStartWords ?? null;
        this.maxRetries = options.maxRetries ?? 3;
        this.retryDelay = options.retryDelay ?? 5;
        this.clientFactory = options.clientFactory ?? createRealtimeClient;
    }

    static listModels(): TTSModelCard[] {
        const cards = listModelCards({
            kind: 'tts',
            provider: 'dashscope',
            parameterSchema: DASHSCOPE_TTS_PARAMETER_SCHEMA,
        }) as TTSModelCard[];
        return cards.filter(card => card.realtime);
    }

    get isConnected(): boolean {
        return this.connected;
    }

    override async connect(): Promise<void> {
        if (this.connected) return;
        this.audio.reset();
        this.client = this.clientFactory({
            credential: this.credential as DashScopeCredential,
            model: this.model,
            onEvent: event => this.handleEvent(event),
            onClose: () => this.audio.finish(),
        });
        await this.client.connect();
        await this.client.updateSession({
            voice: this.parameters.voice,
            mode: 'server_commit',
        });
        this.connected = true;
    }

    override async close(): Promise<void> {
        if (!this.connected) return;
        this.connected = false;
        await this.client?.close();
    }

    override async push(text: string): Promise<TTSResponse> {
        this.assertConnected();
        if (!text) return new TTSResponse({ content: null });
        this.accumulatedText += text;
        if (!this.coldStartDone) {
            this.coldStartBuffer += text;
            if (!this.coldStartReady()) return this.audio.getAudioResponse();
            try {
                await this.client?.appendText(this.coldStartBuffer);
            } catch {
                return new TTSResponse({ content: null });
            }
            this.coldStartBuffer = '';
            this.coldStartDone = true;
        } else {
            try {
                await this.client?.appendText(text);
            } catch {
                return new TTSResponse({ content: null });
            }
        }
        return this.audio.getAudioResponse();
    }

    async synthesize(
        text?: string | null
    ): Promise<TTSResponse | AsyncGenerator<TTSResponse, void>> {
        this.assertConnected();
        if (text != null) this.accumulatedText += text;
        let unsent = this.coldStartBuffer + (text ?? '');
        this.coldStartBuffer = '';
        const fullText = this.accumulatedText;
        let delay = this.retryDelay;

        try {
            for (let attempt = 0; attempt < this.maxRetries; attempt++) {
                try {
                    if (unsent) await this.client?.appendText(unsent);
                    await this.client?.commit();
                    await this.client?.finish();
                    await this.audio.waitForFinish();
                    if (fullText && !this.audio.hasAudioData()) {
                        if (attempt === this.maxRetries - 1) {
                            throw new Error(
                                `TTS synthesis failed: no audio after ${this.maxRetries} attempts`
                            );
                        }
                        await wait(delay);
                        await this.reconnect();
                        unsent = fullText;
                        delay *= 2;
                        continue;
                    }
                    break;
                } catch (error) {
                    if (attempt === this.maxRetries - 1) throw error;
                    await wait(delay);
                    await this.reconnect();
                    unsent = fullText;
                    delay *= 2;
                }
            }

            if (this.stream) return this.audio.getAudioChunks();
            const response = this.audio.getAudioResponse();
            this.audio.reset();
            return response;
        } finally {
            this.resetTextState();
        }
    }

    private async reconnect(): Promise<void> {
        try {
            await this.client?.close();
        } catch {}
        this.connected = false;
        this.coldStartBuffer = '';
        this.coldStartDone = false;
        await this.connect();
    }

    private handleEvent(event: Record<string, unknown>): void {
        const type = event.type;
        if (type === 'session.created') this.audio.reset();
        if (type === 'response.audio.delta') {
            const delta = event.delta;
            if (typeof delta === 'string') this.audio.append(Buffer.from(delta, 'base64'));
            else if (delta instanceof Uint8Array) this.audio.append(delta);
        }
        if (type === 'session.finished') this.audio.finish();
    }

    private coldStartReady(): boolean {
        if (this.coldStartLength != null && this.coldStartBuffer.length < this.coldStartLength) {
            return false;
        }
        if (
            this.coldStartWords != null &&
            this.coldStartBuffer.trim().split(/\s+/).filter(Boolean).length < this.coldStartWords
        ) {
            return false;
        }
        return true;
    }

    private assertConnected(): void {
        if (!this.connected) {
            throw new Error('TTS model is not connected. Call `connect()` first.');
        }
    }

    private resetTextState(): void {
        this.coldStartBuffer = '';
        this.coldStartDone = false;
        this.accumulatedText = '';
    }
}

function createRealtimeClient(options: {
    credential: DashScopeCredential;
    model: string;
    onEvent: (event: Record<string, unknown>) => void;
    onClose: () => void;
}): DashScopeRealtimeTTSClient {
    let socket: WebSocket | null = null;
    const send = (type: string, fields: Record<string, unknown> = {}): void => {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            throw new Error('DashScope realtime WebSocket is not connected.');
        }
        socket.send(JSON.stringify({ event_id: `event_${crypto.randomUUID()}`, type, ...fields }));
    };
    return {
        connect: () =>
            new Promise<void>((resolve, reject) => {
                socket = new WebSocket(
                    `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(options.model)}`,
                    { headers: { authorization: `Bearer ${options.credential.apiKey}` } }
                );
                socket.once('open', () => resolve());
                socket.once('error', reject);
                socket.on('message', data => {
                    try {
                        const event = JSON.parse(data.toString()) as Record<string, unknown>;
                        options.onEvent(event);
                    } catch {}
                });
                socket.on('close', options.onClose);
            }),
        close: () => socket?.close(),
        updateSession: session => send('session.update', { session }),
        appendText: text => send('input_text_buffer.append', { text }),
        commit: () => send('input_text_buffer.commit'),
        finish: () => send('session.finish'),
    };
}

function wait(seconds: number): Promise<void> {
    return seconds > 0
        ? new Promise(resolve => setTimeout(resolve, seconds * 1000))
        : Promise.resolve();
}
