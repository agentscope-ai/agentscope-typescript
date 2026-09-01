/* eslint-disable jsdoc/require-jsdoc */

import { DashScopeCredential } from '../credential';
import { TTSModelBase, TTSResponse, TTSUsage } from './base';

class DummyTTS extends TTSModelBase {
    connectCalls = 0;
    closeCalls = 0;

    constructor(realtime = false) {
        super({
            credential: new DashScopeCredential({ apiKey: 'key' }),
            model: 'dummy',
            parameters: {},
            stream: false,
            realtime,
        });
    }

    override async connect(): Promise<void> {
        this.connectCalls += 1;
    }

    override async close(): Promise<void> {
        this.closeCalls += 1;
    }

    async synthesize(): Promise<TTSResponse> {
        return new TTSResponse({ content: null });
    }
}

describe('TTSModelBase parity', () => {
    test('default push returns an empty response', async () => {
        await expect(new DummyTTS().push('ignored')).resolves.toMatchObject({ content: null });
    });

    test('withConnection gates lifecycle hooks by realtime', async () => {
        const oneShot = new DummyTTS(false);
        await oneShot.withConnection(async model => model.synthesize());
        expect([oneShot.connectCalls, oneShot.closeCalls]).toEqual([0, 0]);

        const realtime = new DummyTTS(true);
        await realtime.withConnection(async model => {
            expect(model.connectCalls).toBe(1);
            expect(model.closeCalls).toBe(0);
            return model.synthesize();
        });
        expect([realtime.connectCalls, realtime.closeCalls]).toEqual([1, 1]);
    });

    test('serializes response and usage with Python field names', () => {
        const usage = new TTSUsage({ inputTokens: 2, outputTokens: 3, time: 0.1 });
        expect(usage.toJSON()).toEqual({
            input_tokens: 2,
            output_tokens: 3,
            time: 0.1,
            type: 'tts',
        });
        const response = new TTSResponse({
            content: null,
            id: 'response',
            createdAt: '2026-01-01T00:00:00.000Z',
            usage,
            isLast: false,
        });
        expect(response.toJSON()).toEqual({
            content: null,
            id: 'response',
            created_at: '2026-01-01T00:00:00.000Z',
            type: 'tts',
            usage,
            metadata: null,
            is_last: false,
        });
    });
});
