/* eslint-disable jsdoc/require-jsdoc */

import { RealtimeAudioBuffer } from './realtime-buffer';

describe('RealtimeAudioBuffer', () => {
    test('returns deltas and never emits a second WAV header', () => {
        const buffer = new RealtimeAudioBuffer();
        buffer.append(Buffer.from('FIRST'));
        const first = decode(buffer.getAudioResponse());
        expect(first.subarray(0, 4).toString()).toBe('RIFF');
        expect(first.subarray(44).toString()).toBe('FIRST');

        buffer.append(Buffer.from('SECOND'));
        const second = decode(buffer.getAudioResponse());
        expect(second.toString()).toBe('SECOND');
        expect(buffer.getAudioResponse().content).toBeNull();
    });

    test('streams queued audio and marks the last delta terminal', async () => {
        const buffer = new RealtimeAudioBuffer();
        buffer.append(Buffer.from('AAAA'));
        buffer.finish();
        const chunks = [];
        for await (const chunk of buffer.getAudioChunks()) chunks.push(chunk);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].isLast).toBe(true);
        const payload = decode(chunks[0]);
        expect(payload.subarray(0, 4).toString()).toBe('RIFF');
        expect(payload.subarray(44).toString()).toBe('AAAA');
    });

    test('waits independently for finish rather than resolving on audio', async () => {
        const buffer = new RealtimeAudioBuffer();
        const finished = buffer.waitForFinish(100);
        buffer.append(Buffer.from('AAAA'));
        await Promise.resolve();
        buffer.finish();
        await expect(finished).resolves.toBe(true);
    });
});

function decode(response: { content: { source: unknown } | null }): Buffer {
    const source = response.content?.source;
    if (
        typeof source !== 'object' ||
        source === null ||
        !('type' in source) ||
        source.type !== 'base64' ||
        !('data' in source) ||
        typeof source.data !== 'string'
    ) {
        throw new Error('Expected base64 audio.');
    }
    return Buffer.from(source.data, 'base64');
}
