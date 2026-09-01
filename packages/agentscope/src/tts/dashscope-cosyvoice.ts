/* eslint-disable jsdoc/require-jsdoc */

import WebSocket from 'ws';

import { DashScopeCredential } from '../credential';
import { concatBytes, pcmWavResponse } from './audio';
import { TTSModelBase, TTSResponse } from './base';
import { RealtimeAudioBuffer } from './realtime-buffer';
import { COSYVOICE_TTS_PARAMETER_SCHEMA } from './schemas';
import type { TTSModelCard } from '../model/card';
import { listModelCards } from '../model/card-registry';

export interface DashScopeCosyVoiceParameters extends Record<string, unknown> {
    voice: string;
    realtime: boolean;
}

export interface CosyVoiceSynthesizer {
    call(text: string): Promise<Uint8Array | null>;
    streamingCall(text: string): Promise<void> | void;
    streamingComplete(): Promise<void> | void;
    close(): Promise<void> | void;
}

export type CosyVoiceSynthesizerFactory = (options: {
    credential: DashScopeCredential;
    model: string;
    voice: string;
    streaming: boolean;
    onOpen: () => void;
    onData: (data: Uint8Array) => void;
    onComplete: () => void;
    onClose: () => void;
    onError: (error: unknown) => void;
}) => CosyVoiceSynthesizer;

export interface DashScopeCosyVoiceTTSModelOptions {
    credential: DashScopeCredential;
    model?: string;
    parameters?: Partial<DashScopeCosyVoiceParameters>;
    stream?: boolean;
    coldStartLength?: number | null;
    coldStartWords?: number | null;
    maxRetries?: number;
    retryDelay?: number;
    synthesizerFactory?: CosyVoiceSynthesizerFactory;
}

/** DashScope CosyVoice one-shot and realtime TTS model. */
export class DashScopeCosyVoiceTTSModel extends TTSModelBase<DashScopeCosyVoiceParameters> {
    readonly type = 'dashscope_cosyvoice_tts' as const;
    readonly coldStartLength: number | null;
    readonly coldStartWords: number | null;
    readonly maxRetries: number;
    readonly retryDelay: number;
    private readonly synthesizerFactory: CosyVoiceSynthesizerFactory;
    private readonly audio = new RealtimeAudioBuffer();
    private synthesizer: CosyVoiceSynthesizer | null = null;
    private connected = false;
    private coldStartBuffer = '';
    private coldStartDone = false;
    private accumulatedText = '';

    constructor(options: DashScopeCosyVoiceTTSModelOptions) {
        const parameters = {
            voice: options.parameters?.voice ?? 'longanhuan',
            realtime: options.parameters?.realtime ?? false,
        };
        super({
            credential: options.credential,
            model: options.model ?? 'cosyvoice-v3-flash',
            parameters,
            stream: options.stream,
            realtime: parameters.realtime,
        });
        this.coldStartLength = options.coldStartLength ?? null;
        this.coldStartWords = options.coldStartWords ?? null;
        this.maxRetries = options.maxRetries ?? 3;
        this.retryDelay = options.retryDelay ?? 5;
        this.synthesizerFactory = options.synthesizerFactory ?? createCosyVoiceSynthesizer;
    }

    static listModels(): TTSModelCard[] {
        return listModelCards({
            kind: 'tts',
            provider: 'dashscope',
            parameterSchema: COSYVOICE_TTS_PARAMETER_SCHEMA,
        }).filter(card => card.name.startsWith('cosyvoice-')) as TTSModelCard[];
    }

    get isConnected(): boolean {
        return this.connected;
    }

    override async connect(): Promise<void> {
        if (this.connected) return;
        this.audio.reset();
        this.synthesizer = this.createSynthesizer(true);
        this.connected = true;
    }

    override async close(): Promise<void> {
        if (!this.connected) return;
        this.connected = false;
        try {
            await this.synthesizer?.close();
        } catch {}
    }

    override async push(text: string): Promise<TTSResponse> {
        if (!this.realtime) return super.push(text);
        this.assertConnected();
        if (!text) return new TTSResponse({ content: null });
        this.accumulatedText += text;
        let textToSend: string;
        if (this.coldStartDone) {
            textToSend = text;
        } else {
            this.coldStartBuffer += text;
            if (!this.coldStartReady()) return this.audio.getAudioResponse();
            textToSend = this.coldStartBuffer;
            this.coldStartBuffer = '';
            this.coldStartDone = true;
        }
        try {
            await this.synthesizer?.streamingCall(textToSend);
        } catch {
            return new TTSResponse({ content: null });
        }
        return this.audio.getAudioResponse();
    }

    async synthesize(
        text?: string | null
    ): Promise<TTSResponse | AsyncGenerator<TTSResponse, void>> {
        return this.realtime ? this.synthesizeRealtime(text) : this.synthesizeOnce(text);
    }

    private async synthesizeOnce(
        text?: string | null
    ): Promise<TTSResponse | AsyncGenerator<TTSResponse, void>> {
        if (!text) return new TTSResponse({ content: null });
        this.audio.reset();
        const synthesizer = this.createSynthesizer(this.stream);
        const audio = await synthesizer.call(text);
        if (this.stream) return this.audio.getAudioChunks();
        return audio?.byteLength ? pcmWavResponse(audio) : new TTSResponse({ content: null });
    }

    private async synthesizeRealtime(
        text?: string | null
    ): Promise<TTSResponse | AsyncGenerator<TTSResponse, void>> {
        this.assertConnected();
        if (text != null) this.accumulatedText += text;
        let unsent = this.coldStartBuffer + (text ?? '');
        this.coldStartBuffer = '';
        const fullText = this.accumulatedText;
        let delay = this.retryDelay;

        try {
            if (!fullText && !unsent) {
                return this.stream ? emptyTTSStream() : new TTSResponse({ content: null });
            }
            for (let attempt = 0; attempt < this.maxRetries; attempt++) {
                try {
                    if (unsent) await this.synthesizer?.streamingCall(unsent);
                    await this.synthesizer?.streamingComplete();
                    const finished = await this.audio.waitForFinish(30_000);
                    if (!finished) {
                        if (attempt === this.maxRetries - 1) {
                            throw new Error('CosyVoice TTS synthesis timed out after 30s');
                        }
                        await wait(delay);
                        await this.reconnect();
                        unsent = fullText;
                        delay *= 2;
                        continue;
                    }
                    if (fullText && !this.audio.hasAudioData()) {
                        if (attempt === this.maxRetries - 1) {
                            throw new Error(
                                `CosyVoice TTS synthesis failed: no audio after ${this.maxRetries} attempts`
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

    private createSynthesizer(streaming: boolean): CosyVoiceSynthesizer {
        return this.synthesizerFactory({
            credential: this.credential as DashScopeCredential,
            model: this.model,
            voice: this.parameters.voice,
            streaming,
            onOpen: () => this.audio.reset(),
            onData: data => this.audio.append(data),
            onComplete: () => this.audio.finish(),
            onClose: () => this.audio.finish(),
            onError: () => this.audio.finish(),
        });
    }

    private async reconnect(): Promise<void> {
        try {
            await this.synthesizer?.close();
        } catch {}
        this.connected = false;
        this.coldStartBuffer = '';
        this.coldStartDone = false;
        await this.connect();
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

function createCosyVoiceSynthesizer(options: {
    credential: DashScopeCredential;
    model: string;
    voice: string;
    streaming: boolean;
    onOpen: () => void;
    onData: (data: Uint8Array) => void;
    onComplete: () => void;
    onClose: () => void;
    onError: (error: unknown) => void;
}): CosyVoiceSynthesizer {
    let socket: WebSocket | null = null;
    let taskId = crypto.randomUUID();
    let started: Promise<void> | null = null;
    let resolveStarted: (() => void) | null = null;
    let complete: Promise<void> | null = null;
    let resolveComplete: (() => void) | null = null;
    const send = (action: string, payload: Record<string, unknown>): void => {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            throw new Error('DashScope CosyVoice WebSocket is not connected.');
        }
        socket.send(
            JSON.stringify({
                header: { action, task_id: taskId, streaming: 'duplex' },
                payload,
            })
        );
    };
    const connect = (): Promise<void> => {
        if (socket?.readyState === WebSocket.OPEN) return Promise.resolve();
        return new Promise((resolve, reject) => {
            socket = new WebSocket('wss://dashscope.aliyuncs.com/api-ws/v1/inference', {
                headers: { authorization: `Bearer ${options.credential.apiKey}` },
            });
            socket.once('open', resolve);
            socket.once('error', error => {
                options.onError(error);
                reject(error);
            });
            socket.on('message', (data, binary) => {
                if (binary) {
                    options.onData(new Uint8Array(data as Buffer));
                    return;
                }
                try {
                    const message = JSON.parse(data.toString()) as {
                        header?: { event?: string };
                    };
                    const event = message.header?.event;
                    if (event === 'task-started') {
                        options.onOpen();
                        resolveStarted?.();
                    }
                    if (event === 'task-finished') {
                        options.onComplete();
                        resolveComplete?.();
                    }
                    if (event === 'task-failed') {
                        options.onError(message);
                        resolveStarted?.();
                        resolveComplete?.();
                    }
                } catch (error) {
                    options.onError(error);
                }
            });
            socket.on('close', options.onClose);
        });
    };
    const start = async (): Promise<void> => {
        if (started) return started;
        await connect();
        taskId = crypto.randomUUID();
        started = new Promise(resolve => {
            resolveStarted = resolve;
        });
        complete = new Promise(resolve => {
            resolveComplete = resolve;
        });
        send('run-task', {
            model: options.model,
            task_group: 'audio',
            task: 'tts',
            function: 'SpeechSynthesizer',
            input: {},
            parameters: {
                voice: options.voice,
                volume: 50,
                text_type: 'PlainText',
                sample_rate: 24000,
                rate: 1,
                format: 'pcm',
                pitch: 1,
                seed: 0,
                type: 0,
                enable_ssml: true,
            },
        });
        return started;
    };
    const streamingCall = async (text: string): Promise<void> => {
        await start();
        send('continue-task', {
            model: options.model,
            task_group: 'audio',
            task: 'tts',
            function: 'SpeechSynthesizer',
            input: { text },
        });
    };
    const streamingComplete = async (): Promise<void> => {
        send('finish-task', { input: {} });
        await complete;
    };
    return {
        async call(text) {
            const chunks: Uint8Array[] = [];
            const originalOnData = options.onData;
            if (!options.streaming) {
                options.onData = data => {
                    chunks.push(data);
                    originalOnData(data);
                };
            }
            await streamingCall(text);
            await streamingComplete();
            return options.streaming ? null : concatBytes(chunks);
        },
        streamingCall,
        streamingComplete,
        close: () => socket?.close(),
    };
}

async function* emptyTTSStream(): AsyncGenerator<TTSResponse, void> {
    yield new TTSResponse({ content: null });
}

function wait(seconds: number): Promise<void> {
    return seconds > 0
        ? new Promise(resolve => setTimeout(resolve, seconds * 1000))
        : Promise.resolve();
}
