/* eslint-disable jsdoc/require-jsdoc */

import { DashScopeCredential } from '../credential';
import type { TTSResponse } from './base';
import type {
    DashScopeRealtimeClientFactory,
    DashScopeRealtimeTTSClient,
} from './dashscope-realtime';
import { DashScopeRealtimeTTSModel } from './dashscope-realtime';

interface FakeRealtimeState {
    appended: string[];
    commits: number;
    finishes: number;
    closes: number;
    sessions: Array<{ voice: string; mode: 'server_commit' }>;
    emitAudio: boolean;
}

describe('DashScopeRealtimeTTSModel parity', () => {
    test('lists the realtime card and manages connection lifecycle', async () => {
        expect(DashScopeRealtimeTTSModel.listModels().map(card => card.name)).toEqual([
            'qwen3-tts-flash-realtime',
        ]);
        const { factory, state } = fakeFactory();
        const model = createModel(factory);
        await model.withConnection(async connected => {
            expect(connected.isConnected).toBe(true);
            expect(state.sessions).toEqual([{ voice: 'Cherry', mode: 'server_commit' }]);
            return undefined;
        });
        expect(model.isConnected).toBe(false);
        expect(state.closes).toBe(1);
    });

    test('requires connection and buffers cold-start text', async () => {
        const { factory, state } = fakeFactory();
        const model = createModel(factory, { coldStartLength: 10 });
        await expect(model.push('Hello')).rejects.toThrow('connect()');
        await model.connect();
        await model.push('Hi');
        await model.push(' there');
        expect(state.appended).toEqual([]);
        await model.push(' friend!');
        expect(state.appended).toEqual(['Hi there friend!']);
        await model.push(' More');
        expect(state.appended).toEqual(['Hi there friend!', ' More']);
    });

    test('finalizes pushed text and returns streaming audio deltas', async () => {
        const { factory, state } = fakeFactory();
        const model = createModel(factory, { stream: true });
        await model.connect();
        await model.push('Hello');
        state.appended.length = 0;
        const result = await model.synthesize(' world');
        const chunks = await collect(result);
        expect(state.appended).toEqual([' world']);
        expect(state.commits).toBe(1);
        expect(state.finishes).toBe(1);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].isLast).toBe(true);
        const payload = Buffer.from(audioData(chunks[0]), 'base64');
        expect(payload.subarray(0, 4).toString()).toBe('RIFF');
        expect(payload.subarray(44).toString()).toBe('AUDIO');
    });

    test('flushes a pending cold-start buffer on synthesize', async () => {
        const { factory, state } = fakeFactory();
        const model = createModel(factory, { coldStartLength: 100, stream: false });
        await model.connect();
        await model.push('Hi');
        await model.push(' there');
        expect(state.appended).toEqual([]);
        await model.synthesize();
        expect(state.appended).toEqual(['Hi there']);
    });

    test('raises when synthesis finishes without audio', async () => {
        const { factory, state } = fakeFactory();
        state.emitAudio = false;
        const model = createModel(factory, { maxRetries: 1, retryDelay: 0 });
        await model.connect();
        await expect(model.synthesize('Hello')).rejects.toThrow('no audio after 1 attempts');
    });
});

function fakeFactory(): { factory: DashScopeRealtimeClientFactory; state: FakeRealtimeState } {
    const state: FakeRealtimeState = {
        appended: [],
        commits: 0,
        finishes: 0,
        closes: 0,
        sessions: [],
        emitAudio: true,
    };
    const factory: DashScopeRealtimeClientFactory = options => {
        const client: DashScopeRealtimeTTSClient = {
            connect: async () => options.onEvent({ type: 'session.created' }),
            close: () => {
                state.closes += 1;
            },
            updateSession: session => {
                state.sessions.push(session);
            },
            appendText: text => {
                state.appended.push(text);
            },
            commit: () => {
                state.commits += 1;
            },
            finish: () => {
                state.finishes += 1;
                if (state.emitAudio) {
                    options.onEvent({
                        type: 'response.audio.delta',
                        delta: Buffer.from('AUDIO').toString('base64'),
                    });
                }
                options.onEvent({ type: 'session.finished' });
            },
        };
        return client;
    };
    return { factory, state };
}

function createModel(
    clientFactory: DashScopeRealtimeClientFactory,
    options: Partial<ConstructorParameters<typeof DashScopeRealtimeTTSModel>[0]> = {}
) {
    return new DashScopeRealtimeTTSModel({
        credential: new DashScopeCredential({ apiKey: 'key' }),
        maxRetries: 1,
        retryDelay: 0,
        clientFactory,
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
