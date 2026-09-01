/* eslint-disable jsdoc/require-jsdoc */

import { DashScopeCredential } from '../credential';
import type { TTSResponse } from './base';
import type { CosyVoiceSynthesizer, CosyVoiceSynthesizerFactory } from './dashscope-cosyvoice';
import { DashScopeCosyVoiceTTSModel } from './dashscope-cosyvoice';

interface FakeCosyState {
    calls: string[];
    streamed: string[];
    completes: number;
    closes: number;
    emitAudio: boolean;
    throwOnPush: boolean;
}

describe('DashScopeCosyVoiceTTSModel parity', () => {
    test('lists two dedicated cards with realtime as an instance parameter', () => {
        const cards = DashScopeCosyVoiceTTSModel.listModels();
        expect(cards.map(card => card.name).sort()).toEqual([
            'cosyvoice-v3-flash',
            'cosyvoice-v3-plus',
        ]);
        expect(cards.every(card => !card.realtime)).toBe(true);
        expect(cards[0].parameterSchema).toHaveProperty('properties.realtime');
    });

    test('wraps one-shot PCM as a complete WAV', async () => {
        const { factory, state } = fakeFactory();
        const model = createModel(factory, { stream: false });
        const result = (await model.synthesize('Hello')) as TTSResponse;
        expect(state.calls).toEqual(['Hello']);
        const wav = Buffer.from(audioData(result), 'base64');
        expect(wav.subarray(0, 4).toString()).toBe('RIFF');
        expect(wav.subarray(44).toString()).toBe('FULL_AUDIO');
    });

    test('streams callback audio and emits one terminal chunk', async () => {
        const { factory } = fakeFactory();
        const result = await createModel(factory, { stream: true }).synthesize('Hello');
        const chunks = await collect(result);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].isLast).toBe(true);
        const payload = Buffer.from(audioData(chunks[0]), 'base64');
        expect(payload.subarray(0, 4).toString()).toBe('RIFF');
        expect(payload.subarray(44).toString()).toBe('CHUNK');
    });

    test('realtime push buffers cold start and forwards later deltas', async () => {
        const { factory, state } = fakeFactory();
        const model = createModel(factory, {
            parameters: { realtime: true },
            coldStartLength: 10,
        });
        await model.connect();
        await model.push('Hi');
        await model.push(' there');
        expect(state.streamed).toEqual([]);
        await model.push(' friend!');
        await model.push(' More');
        expect(state.streamed).toEqual(['Hi there friend!', ' More']);
    });

    test('realtime synthesis flushes, completes, and returns audio', async () => {
        const { factory, state } = fakeFactory();
        const model = createModel(factory, {
            parameters: { realtime: true },
            stream: false,
        });
        await model.connect();
        await model.push('Hello');
        state.streamed.length = 0;
        const result = (await model.synthesize(' world')) as TTSResponse;
        expect(state.streamed).toEqual([' world']);
        expect(state.completes).toBe(1);
        const payload = Buffer.from(audioData(result), 'base64');
        expect(payload.subarray(44).toString()).toBe('CHUNK');
    });

    test('empty realtime synthesis short-circuits and push failures degrade gracefully', async () => {
        const { factory, state } = fakeFactory();
        const model = createModel(factory, {
            parameters: { realtime: true },
            stream: true,
        });
        await model.connect();
        const empty = await collect(await model.synthesize());
        expect(empty).toHaveLength(1);
        expect(empty[0].content).toBeNull();
        expect(state.completes).toBe(0);

        state.throwOnPush = true;
        await expect(model.push('Hello')).resolves.toMatchObject({ content: null });
    });

    test('raises when realtime synthesis receives no audio', async () => {
        const { factory, state } = fakeFactory();
        state.emitAudio = false;
        const model = createModel(factory, {
            parameters: { realtime: true },
            maxRetries: 1,
            retryDelay: 0,
        });
        await model.connect();
        await expect(model.synthesize('Hello')).rejects.toThrow('no audio after 1 attempts');
    });
});

function fakeFactory(): { factory: CosyVoiceSynthesizerFactory; state: FakeCosyState } {
    const state: FakeCosyState = {
        calls: [],
        streamed: [],
        completes: 0,
        closes: 0,
        emitAudio: true,
        throwOnPush: false,
    };
    const factory: CosyVoiceSynthesizerFactory = options => {
        let opened = false;
        const open = (): void => {
            if (opened) return;
            opened = true;
            options.onOpen();
        };
        const synthesizer: CosyVoiceSynthesizer = {
            call: async text => {
                state.calls.push(text);
                if (options.streaming) {
                    open();
                    if (state.emitAudio) options.onData(Buffer.from('CHUNK'));
                    options.onComplete();
                    return null;
                }
                return Buffer.from('FULL_AUDIO');
            },
            streamingCall: text => {
                if (state.throwOnPush) throw new Error('connection error');
                open();
                state.streamed.push(text);
            },
            streamingComplete: () => {
                state.completes += 1;
                if (state.emitAudio) options.onData(Buffer.from('CHUNK'));
                options.onComplete();
            },
            close: () => {
                state.closes += 1;
                options.onClose();
            },
        };
        return synthesizer;
    };
    return { factory, state };
}

function createModel(
    synthesizerFactory: CosyVoiceSynthesizerFactory,
    options: Partial<ConstructorParameters<typeof DashScopeCosyVoiceTTSModel>[0]> = {}
) {
    return new DashScopeCosyVoiceTTSModel({
        credential: new DashScopeCredential({ apiKey: 'key' }),
        maxRetries: 1,
        retryDelay: 0,
        synthesizerFactory,
        ...options,
    });
}

async function collect(result: unknown): Promise<TTSResponse[]> {
    const responses: TTSResponse[] = [];
    for await (const response of result as AsyncGenerator<TTSResponse>) responses.push(response);
    return responses;
}

function audioData(response: TTSResponse): string {
    const source = response.content?.source;
    if (!source || source.type !== 'base64') throw new Error('Expected base64 audio.');
    return source.data;
}
