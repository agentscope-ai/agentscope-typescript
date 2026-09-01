/* eslint-disable jsdoc/require-jsdoc */

import { audioResponse, concatBytes, streamingWavDelta, TTS_WAV_MEDIA_TYPE } from './audio';
import { TTSResponse } from './base';

/** Provider-neutral incremental PCM buffer for realtime TTS transports. */
export class RealtimeAudioBuffer {
    private chunks: Uint8Array[] = [];
    private consumed = 0;
    private finished = false;
    private changeWaiters: Array<() => void> = [];
    private finishWaiters: Array<(finished: boolean) => void> = [];

    reset(): void {
        this.chunks = [];
        this.consumed = 0;
        this.finished = false;
        this.notifyChange();
        this.notifyFinish(false);
    }

    append(data: Uint8Array): void {
        if (data.byteLength === 0) return;
        this.chunks.push(new Uint8Array(data));
        this.notifyChange();
    }

    finish(): void {
        this.finished = true;
        this.notifyChange();
        this.notifyFinish(true);
    }

    hasAudioData(): boolean {
        return this.totalLength() > 0;
    }

    getAudioResponse(): TTSResponse {
        const delta = this.takeDelta(this.consumed === 0);
        return delta
            ? audioResponse(delta, TTS_WAV_MEDIA_TYPE)
            : new TTSResponse({ content: null });
    }

    async waitForFinish(timeoutMs?: number): Promise<boolean> {
        if (this.finished) return true;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        return new Promise(resolve => {
            const waiter = (finished: boolean): void => {
                if (timeout) clearTimeout(timeout);
                resolve(finished);
            };
            this.finishWaiters.push(waiter);
            if (timeoutMs != null) {
                timeout = setTimeout(() => {
                    this.finishWaiters = this.finishWaiters.filter(item => item !== waiter);
                    resolve(false);
                }, timeoutMs);
            }
        });
    }

    async *getAudioChunks(): AsyncGenerator<TTSResponse, void> {
        let headerSent = this.consumed > 0;
        while (true) {
            const delta = this.takeDelta(!headerSent);
            if (delta) {
                headerSent = true;
                yield audioResponse(delta, TTS_WAV_MEDIA_TYPE, this.finished);
                if (this.finished) {
                    this.reset();
                    return;
                }
                continue;
            }
            if (this.finished) {
                yield new TTSResponse({ content: null, isLast: true });
                this.reset();
                return;
            }
            await this.waitForChange();
        }
    }

    private takeDelta(header: boolean): Uint8Array | null {
        const all = concatBytes(this.chunks);
        if (all.byteLength <= this.consumed) return null;
        const delta = all.slice(this.consumed);
        this.consumed = all.byteLength;
        return streamingWavDelta(delta, header);
    }

    private totalLength(): number {
        return this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    }

    private waitForChange(): Promise<void> {
        return new Promise(resolve => this.changeWaiters.push(resolve));
    }

    private notifyChange(): void {
        const waiters = this.changeWaiters;
        this.changeWaiters = [];
        for (const waiter of waiters) waiter();
    }

    private notifyFinish(finished: boolean): void {
        const waiters = this.finishWaiters;
        this.finishWaiters = [];
        for (const waiter of waiters) waiter(finished);
    }
}
